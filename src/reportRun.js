const { isDeepStrictEqual } = require("util");
const { sessionDate } = require("./data/marketCalendar");
const { VERSION: MODEL_SCHEMA_VERSION } = require("./modelAnalysis");
const { PROMPT_VERSION } = require("./reportPrompt");
const { buildInputSnapshot, buildReportOutput } = require("./reportBuilder");
const { RunRecords } = require("./runRecords");
const { assertPipelineSettings } = require("./config");
const { sanitize, safeSettings, writeArtifact, connectRunDatabase, readFeedback } = require("./runInfrastructure");

async function runReport(settings, options = {}, dependencies = {}) {
  assertPipelineSettings(settings);
  const dry = Boolean(options.dryRun), now = dependencies.now || Date.now;
  const date = sessionDate(now());
  const identity = settings.execution?.runIdentity || "daily-report";
  const key = `${settings.execution?.runNamespace ? `${settings.execution.runNamespace}:` : ""}${identity}:${date}`;
  const collect = dependencies.collectInputs || (() => { throw new Error("Explicit input adapter required"); });
  const model = dependencies.generateReport || (() => { throw new Error("Explicit model adapter required"); });
  const buildOptions = dependencies.buildOptions || (() => { throw new Error("Explicit options adapter required"); });
  const send = dependencies.sendEmail || (() => { throw new Error("Explicit email adapter required"); });
  const artifact = dependencies.writeArtifact || writeArtifact;
  const makeSnapshot = async db => buildInputSnapshot(await collect(), settings,
    { now, redact: sanitize, readFeedback: () => (dependencies.readFeedback || readFeedback)(db, settings) });
  const generate = async snapshot => {
    const result = await model(snapshot.inputs, snapshot.feedback, snapshot.model_request);
    if (typeof result?.content !== "string") throw new Error("Invalid model adapter response");
    return { report_text: sanitize(result.content), model_completion: { finish_reason: result.finish_reason ?? null },
      model_usage: result.usage ? [result.usage] : [] };
  };
  const makeOutput = (snapshot, report, completion) => buildReportOutput(snapshot, report, settings,
    { now, date, dry, completion, redact: sanitize, buildOptions });
  if (dry) {
    const snapshot = await makeSnapshot(null), response = await generate(snapshot);
    const output = await makeOutput(snapshot, response.report_text, response.model_completion);
    return { status: "dry_run", artifact: await artifact({ run_key: `dry:${key}`, settings: safeSettings(settings), snapshot, output,
      email_status: "disabled", production_writes: false }) };
  }
  let db;
  try { db = await (dependencies.connectDatabase || connectRunDatabase)(settings); } catch { db = null; }
  if (!db) return { status: "research_only", artifact: await artifact({ run_key: key, reason: "database_unavailable",
    output: { report: "Research only: database unavailable; no tracked recommendations or email created.", recommendations: [] },
    email_status: "disabled", production_writes: false }) };
  const records = new RunRecords(db);
  let run;
  try {
    run = await records.claim(key, date, safeSettings(settings), settings.model);
    if (!run) return { status: "already_running" };
    if (run.status === "completed") return { status: "already_completed", run_id: run.id,
      artifact: await artifact({ output: run.output, email_status: run.email_status, production_writes: false }) };
    if (run.email_status === "unknown") return { status: "delivery_unknown", run_id: run.id };
    if (!run.output && !isDeepStrictEqual(run.settings, safeSettings(settings))) throw new Error("Recovery version changed");
    const snapshot = run.snapshot || await makeSnapshot(db);
    if (!run.snapshot) await records.saveSnapshot(run.id, snapshot);
    if (!run.output && (snapshot.model_schema_version !== MODEL_SCHEMA_VERSION || snapshot.prompt_version !== PROMPT_VERSION)) {
      throw new Error("Recovery model contract changed");
    }
    let output = run.output;
    if (!output) {
      // Checkpoint even an empty/refused response; recovery never pays again.
      if (typeof snapshot.report_text !== "string") {
        Object.assign(snapshot, await generate(snapshot));
        await records.saveSnapshot(run.id, snapshot);
      }
      output = await makeOutput(snapshot, snapshot.report_text, snapshot.model_completion);
      await records.saveOutput(run.id, output);
    }
    await records.storePlans(run, output);
    const savedArtifact = await artifact({ output,
      email_status: settings.delivery?.email !== true ? "disabled" : run.email_status, production_writes: true });
    if (settings.delivery?.email !== true) {
      await records.completeWithoutEmail(run.id);
      return { status: "completed", run_id: run.id, artifact: savedArtifact, email_status: "disabled" };
    }
    if (!await records.beginEmail(run.id)) return { status: "delivery_unknown", run_id: run.id };
    const receipt = await send({ subject: output.subject, content: output.html,
      idempotencyKey: `report-run/${run.id}`, runId: run.id });
    if (!receipt?.id) throw new Error("Email receipt unavailable");
    await records.complete(run.id, receipt.id);
    return { status: "completed", run_id: run.id, artifact: savedArtifact };
  } catch {
    if (run) await records.fail(run.id, "report_run_failed").catch(() => {});
    throw new Error("Report run failed; saved stages preserved; inspect run status before retry");
  } finally {
    await records.release().catch(() => {});
    await db.disconnect();
  }
}

module.exports = { runReport };
