const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const { renderDemo } = require("../scripts/demo");
const { renderScenario, scenarios, syntheticOptionChain } = require("./fixtures/report-scenarios");
const { runReport } = require("../src/reportRun");
const { buildReportOutput } = require("../src/reportBuilder");
const { buildOptionsSupplements } = require("../src/optionsSupplement");
const { createConfig } = require("../src/config");
const { sanitize } = require("../src/runInfrastructure");
const { reportFacts } = require("./reportFacts");
const originalFacts = require("./fixtures/report-facts-baseline.json");

test("reports preserve frozen evidence, prices, decisions, options and evaluation policy", async () => {
  for (const name of scenarios) {
    assert.deepEqual(reportFacts(await renderScenario(name)), originalFacts.scenarios[name], `Financial behavior changed for ${name}`);
  }
});

test("report prose, structured commentary and email subjects are English", async () => {
  for (const name of scenarios) {
    const { output, snapshot } = await renderScenario(name);
    assert.doesNotMatch(JSON.stringify(output), /\p{Script=Han}/u);
    assert.match(output.html, /<html lang="en">/);
    assert.match(output.html, /<meta charset="utf-8">/);
    assert.match(output.subject, /Daily Watchlist Report/);
    assert.match(snapshot.model_request.messages[0].content, /descriptive JSON values must be English/);
    assert.doesNotMatch(snapshot.model_request.messages[0].content, /\p{Script=Han}/u);
  }
});

test("default CLI writes one local report with unusable live credentials and network disabled", async () => {
  const script = `
    const deny = () => { throw new Error('Network is forbidden in the demo'); };
    const Module = require('node:module'), load = Module._load;
    Module._load = function(name, ...args) {
      if (['openai', 'resend', 'pg'].includes(name)) throw new Error('External client is forbidden in the demo');
      return load.call(this, name, ...args);
    };
    require('node:net').Socket.prototype.connect = deny;
    require('node:http').request = deny; require('node:https').request = deny;
    global.fetch = deny;
    require('./src/index').cli([]).catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: path.resolve(__dirname, ".."), encoding: "utf8",
    env: { ...process.env, WATCHLIST_FILE: "does-not-exist", DATABASE_URL: "postgres://invalid.invalid/unused",
      OPENAI_API_KEY: "unused", FINNHUB_API_KEY: "unused", RESEND_API_KEY: "unused" } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Offline report:/);
  assert.deepEqual(fs.readdirSync(path.resolve(__dirname, "../examples")), ["report-preview.png"]);
  const folder = path.resolve(__dirname, "../local-data/demo");
  assert.deepEqual(fs.readdirSync(folder), ["report.html"]);
  assert.equal(fs.readFileSync(path.join(folder, "report.html"), "utf8"), (await renderDemo()).output.html);
});

test("live CLI rejects missing credentials before provider calls", async () => {
  const result = spawnSync(process.execPath, ["src/index.js", "--live"], {
    cwd: path.resolve(__dirname, ".."), encoding: "utf8", env: { ...process.env, OPENAI_API_KEY: "" }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing OPENAI_API_KEY/);
});

test("every demo returns the pipeline artifact directly and never patches or rerenders its output", async () => {
  for (const name of scenarios) {
    let pipelineArtifact, optionsCalls = 0;
    const actual = await renderScenario(name, async (settings, options, dependencies) => {
      const write = dependencies.writeArtifact, build = dependencies.buildOptions;
      return runReport(settings, options, { ...dependencies,
        buildOptions: (...args) => { optionsCalls++; return build(...args); },
        writeArtifact: value => {
          value.output = new Proxy(value.output, { set: () => assert.fail("Demo must not mutate completed output") });
          pipelineArtifact = value; return write(value);
        }
      });
    });
    assert.strictEqual(actual, pipelineArtifact, name);
    assert.equal(optionsCalls, 1, "Enabled options use the shared construction path even for an empty plan set");
    assert.equal(actual.email_status, "disabled"); assert.equal(actual.production_writes, false);
  }
});

test("offline and live-style construction produce identical decisions, options, evidence and HTML", async () => {
  for (const name of scenarios) {
    const artifact = await renderScenario(name);
    const settings = { ...createConfig({}, { watchlist: ["NVDA", "MSFT"] }), model: "saved-synthetic-response" };
    const live = await buildReportOutput(artifact.snapshot, artifact.output.report, settings, {
      now: () => Date.parse(artifact.output.issued_at), date: "2026-10-21", dry: false,
      redact: value => sanitize(value, {}),
      buildOptions: (plans, quotes, snapshots) => buildOptionsSupplements(plans, quotes, settings.options, snapshots,
        { fetchChain: async (...args) => name === "options-unavailable" ? [] : syntheticOptionChain(...args) })
    });
    const { subject: demoSubject, ...demoOutput } = artifact.output;
    const { subject: liveSubject, ...liveOutput } = live;
    assert.equal(demoSubject, `[DRY RUN] ${liveSubject}`);
    assert.deepEqual(demoOutput, liveOutput, name);
  }
});

test("shared options construction retains actual synthetic chains, including an empty-chain observation", async () => {
  const open = (await renderScenario("market-open")).output;
  const plan = open.recommendations[0];
  assert.deepEqual(open.optionChainSnapshots, [{ symbol: "NVDA", contracts: syntheticOptionChain("NVDA", plan.current_price) }]);
  assert.equal(open.optionsSupplements[0].option_symbol, open.optionChainSnapshots[0].contracts[0].option_symbol);
  const unavailable = (await renderScenario("options-unavailable")).output;
  assert.deepEqual(unavailable.optionChainSnapshots, [{ symbol: "NVDA", contracts: [] }]);
  assert.equal(unavailable.optionsSupplements[0].strategy, "skip_options");
  assert.deepEqual(unavailable.recommendations.map(p => p.symbol), ["NVDA"]);
  for (const name of ["overnight", "earnings-conflict", "unavailable-data"]) {
    assert.deepEqual((await renderScenario(name)).output.optionChainSnapshots, []);
  }
  const short = await renderScenario("market-open", (settings, options, dependencies) => {
    const generate = dependencies.generateReport;
    return runReport(settings, options, { ...dependencies, generateReport: async (...args) => {
      const analysis = JSON.parse((await generate(...args)).content), plan = analysis.recommendations[0];
      Object.assign(plan, { trade_direction: "short", target_price: plan.entry_price - 10, stop_loss: plan.entry_price + 4 });
      return { content: JSON.stringify(analysis) };
    } });
  });
  assert.equal(short.output.recommendations[0].trade_direction, "short");
  assert.equal(short.output.optionsSupplements[0].option_type, "put");
  assert.equal(short.output.optionChainSnapshots[0].contracts[0].delta, -.52);
});

test("demo options honor final freshness and the same enabled setting without any external effects", async () => {
  let stalePlans;
  const stale = await renderScenario("market-open", (settings, options, dependencies) => {
    let clock = dependencies.now();
    const generate = dependencies.generateReport, build = dependencies.buildOptions;
    return runReport(settings, options, { ...dependencies, now: () => clock,
      generateReport: async (...args) => { clock += 901000; return generate(...args); },
      buildOptions: (plans, ...args) => { stalePlans = plans; return build(plans, ...args); }
    });
  });
  assert.deepEqual(stalePlans, []); assert.deepEqual(stale.output.optionsSupplements, []);
  assert.deepEqual(stale.output.optionChainSnapshots, []);
  const disabled = await renderScenario("market-open", (settings, options, dependencies) => {
    settings.options.enabled = false;
    settings.delivery.email = true; // Dry mode must still suppress delivery.
    return runReport(settings, options, { ...dependencies, buildOptions: () => assert.fail("Disabled options must not run") });
  });
  assert.deepEqual(disabled.output.recommendations.map(p => p.symbol), ["NVDA"]);
  assert.deepEqual(disabled.output.optionsSupplements, []);
  assert.equal(disabled.email_status, "disabled"); assert.equal(disabled.production_writes, false);
});

test("a fixture chain failure uses the shared skip result while retaining the qualified stock plan", async () => {
  const artifact = await renderScenario("market-open", (settings, options, dependencies) => runReport(settings, options, {
    ...dependencies,
    buildOptions: (plans, quotes, snapshots) => buildOptionsSupplements(plans, quotes, settings.options, snapshots,
      { fetchChain: async () => { throw new Error("synthetic chain failure"); } })
  }));
  assert.deepEqual(artifact.output.recommendations.map(p => p.symbol), ["NVDA"]);
  assert.equal(artifact.output.optionsSupplements[0].strategy, "skip_options");
  assert.match(artifact.output.optionsSupplements[0].skip_reason, /synthetic chain failure/);
  assert.deepEqual(artifact.output.optionChainSnapshots, []);
});
