const crypto = require("crypto");
const { qualifyReportInputs } = require("./qualification");
const { qualifyRecommendations } = require("./recommendations");
const { parseModelAnalysis, VERSION: MODEL_SCHEMA_VERSION } = require("./modelAnalysis");
const { buildReportDocument } = require("./reportDocument");
const { formatDashboard } = require("./formatter");
const { buildReportRequest, PROMPT_VERSION } = require("./reportPrompt");
const { policy: evaluationPolicy, applyEvaluationPolicy } = require("./evaluationPolicy");
const { buildPreparation } = require("./preparation");
const { filterContextPlans } = require("./data/regimeEvents");

// Application construction only: no run states, SQL, filesystem, model or email calls.
async function buildInputSnapshot(inputs, settings, { now, redact, readFeedback }) {
  inputs = qualifyReportInputs(inputs, { now: now(), maxAgeSeconds: settings.dataValidation?.maxAgeSeconds ?? 900 });
  if (!inputs.quotes.some(q => ["ok", "research_only"].includes(q.quality.status))) throw new Error("No usable historical evidence");
  let feedback = "";
  try { feedback = await readFeedback(); } catch {} // Feedback is optional; evidence is not.
  const safe = redact({ inputs, feedback });
  safe.model_request = redact(buildReportRequest(inputs.quotes, inputs.news, feedback, inputs.dataQuality,
    { model: settings.model, marketContext: inputs.marketContext,
      preparationContext: inputs.preparationContext }));
  safe.prompt_version = PROMPT_VERSION;
  safe.model_schema_version = MODEL_SCHEMA_VERSION;
  safe.evidence_hash = crypto.createHash("sha256").update(JSON.stringify(safe)).digest("hex");
  return safe;
}

async function buildReportOutput(snapshot, response, settings, { now, date, dry, completion, redact, buildOptions }) {
  let inputs = snapshot.inputs;
  const report = redact(response);
  const modelValidation = parseModelAnalysis(report, inputs.quotes.map(q => q.symbol));
  const analysis = modelValidation.analysis;
  const issuedAt = new Date(now()).toISOString();
  const modelCompletion = snapshot.model_completion || completion || { finish_reason: null };
  const generationIncomplete = modelCompletion.finish_reason != null && modelCompletion.finish_reason !== "stop";
  inputs = qualifyReportInputs(inputs, { now: Date.parse(issuedAt), maxAgeSeconds: settings.dataValidation?.maxAgeSeconds ?? 900 });
  const eligibleSession = inputs.dataQuality.eligible_session;
  const preparation = buildPreparation(analysis?.preparation || [], inputs,
      { finishReason: modelCompletion.finish_reason, validationError: modelValidation.errors[0] || null });
  // This mode always requires explicit eligibility, even for test fixtures.
  const quotes = inputs.quotes.map(q => ({ ...q, quality: { ...q.quality, enforced: true,
    actionable: q.quality?.actionable === true && Boolean(eligibleSession) && !generationIncomplete } }));
  const parsed = qualifyRecommendations(analysis?.recommendations || [], quotes, { requireHistorical: true });
  const evaluated = applyEvaluationPolicy(parsed);
  const filtered = filterContextPlans(evaluated.recommendations, inputs.marketContext);
  const recommendations = filtered.recommendations;
  const exclusions = [...evaluated.exclusions, ...filtered.exclusions];
  if (!analysis) exclusions.push({ symbol: "all", reason: modelValidation.errors[0] });
  if (!eligibleSession) exclusions.push({ symbol: "all", reason: "issuance_calendar_unavailable" });
  if (generationIncomplete) exclusions.push({ symbol: "all", reason: "model_generation_incomplete" });
  const optionChainSnapshots = [];
  const optionsSupplements = !settings.options?.enabled ? [] : redact(await buildOptions(recommendations, quotes, optionChainSnapshots));
  const reportDocument = buildReportDocument({ analysis, quotes, recommendations, optionsSupplements,
    dataQuality: { ...inputs.dataQuality, eligible_session: eligibleSession }, evaluationPolicy, exclusions,
    marketContext: inputs.marketContext, preparation, issuedAt });
  const html = formatDashboard(reportDocument);
  return redact({ report, recommendations, preparation, model_completion: modelCompletion,
    model_validation: { schema_version: MODEL_SCHEMA_VERSION, state: modelValidation.state, errors: modelValidation.errors },
    optionsSupplements, optionChainSnapshots, evaluationPolicy, exclusions, html, reportDocument,
    dataQuality: { ...inputs.dataQuality, eligible_session: eligibleSession },
    marketContext: inputs.marketContext,
    issued_at: issuedAt, eligible_session: eligibleSession,
    subject: `${dry ? "[DRY RUN] " : ""}Daily Watchlist Report - ${date}` });
}

module.exports = { buildInputSnapshot, buildReportOutput };
