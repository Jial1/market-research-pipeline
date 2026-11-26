const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createConfig } = require("../src/config");
const { createLiveDependencies } = require("../src/composition");
const { makeScenario } = require("./fixtures/report-scenarios");
const { runReport } = require("../src/reportRun");
const { safeSettings } = require("../src/runInfrastructure");
const { qualifyReportInputs } = require("../src/qualification");
const credentials = { OPENAI_API_KEY: "synthetic-model-key", FINNHUB_API_KEY: "synthetic-quote-key",
  ALPACA_API_KEY: "synthetic-history-key", ALPACA_SECRET_KEY: "synthetic-history-secret",
  MARKETDATA_TOKEN: "synthetic-options-token", DATABASE_URL: "postgres://synthetic.invalid/unused",
  RESEND_API_KEY: "synthetic-email-key", EMAIL_TO: "reviewer@example.invalid", EMAIL_FROM: "Demo <demo@example.invalid>" };
const makeConfig = env => createConfig({ ...credentials, ...env }, { watchlist: ["NVDA"] });

test("importing public modules neither reads watchlists/environment files nor constructs model/email clients", () => {
  const script = `
    const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
    const read = fs.readFileSync, load = Module._load;
    fs.readFileSync = function(file, ...args) {
      if (['watchlist.txt', '.env'].includes(path.basename(String(file)))) throw new Error('Unexpected configuration read');
      return read.call(this, file, ...args);
    };
    Module._load = function(name, ...args) {
      if (['openai', 'resend'].includes(name)) throw new Error('Unexpected client loading at import');
      return load.call(this, name, ...args);
    };
    for (const module of ['config','index','composition','ai','mailer','market','news','recommendations','reportRun']) require('./src/'+module);
  `;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: path.resolve(__dirname, ".."), encoding: "utf8",
    env: { ...process.env, WATCHLIST_FILE: "missing-watchlist.txt" } });
  assert.equal(result.status, 0, result.stderr);
});

test("startup reads the watchlist once and reuses one model client without constructing an unused email client", async () => {
  const read = fs.readFileSync; let reads = 0, clients = 0, calls = 0;
  fs.readFileSync = function(file, ...args) {
    if (path.basename(String(file)) === "watchlist.txt") reads++;
    return read.call(this, file, ...args);
  };
  try {
    const settings = createConfig(credentials);
    const dependencies = createLiveDependencies(settings, {
      createModelClient: key => { clients++; assert.equal(key, credentials.OPENAI_API_KEY);
        return { chat: { completions: { create: async () => { calls++; return { choices: [{ finish_reason: "stop", message: { content: "saved response" } }] }; } } } }; },
      createEmailClient: () => assert.fail("Local reports do not construct email clients")
    });
    for (let i = 0; i < 2; i++) await dependencies.generateReport({ quotes: [], news: {}, dataQuality: null }, "", { model: settings.model });
    assert.deepEqual({ reads, clients, calls }, { reads: 1, clients: 1, calls: 2 });
  } finally { fs.readFileSync = read; }
});

test("composed market/options/email adapters use captured credentials after the environment changes", async () => {
  const settings = makeConfig(); settings.delivery.email = true;
  const fixture = makeScenario("market-open"); const requests = [];
  let emailClients = 0, sent;
  const dependencies = createLiveDependencies(settings, {
    now: () => fixture.now,
    createModelClient: () => ({}),
    createEmailClient: key => { emailClients++; assert.equal(key, credentials.RESEND_API_KEY);
      return { emails: { send: async body => { sent = body; return { data: { id: "synthetic-receipt" } }; } } }; },
    get: async (url, options) => {
      requests.push(url);
      if (url.includes("alpaca.markets")) {
        assert.equal(options.headers["APCA-API-KEY-ID"], credentials.ALPACA_API_KEY);
        assert.equal(options.headers["APCA-API-SECRET-KEY"], credentials.ALPACA_SECRET_KEY);
        if (url.endsWith("calendar")) return { data: fixture.inputs.evidence.calendar.sessions.map(s => ({ date: s.date, open: "09:30", close: "16:00" })) };
        const symbol = options.params.symbols;
        return { data: { bars: { [symbol]: fixture.inputs.evidence.histories[symbol].candles.map(c => ({ t: c.provider_at,
          o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume })) } } };
      }
      if (url.includes("marketdata.app")) {
        assert.equal(options.headers.Authorization, `Bearer ${credentials.MARKETDATA_TOKEN}`);
        return { status: 200, data: { s: "no_data" } };
      }
      assert.equal(options.headers["X-Finnhub-Token"], credentials.FINNHUB_API_KEY);
      if (url.endsWith("/quote")) return { data: { c: 120.2, o: 120, h: 121.2, l: 119.2, pc: 119.9, d: .3, dp: .25, t: fixture.now / 1000 } };
      if (url.endsWith("/company-news")) return { data: [] };
      return { data: { earningsCalendar: [] } };
    }
  });
  const previous = Object.fromEntries(Object.keys(credentials).map(k => [k, process.env[k]]));
  try {
    for (const key of Object.keys(credentials)) process.env[key] = "changed-after-startup";
    const collected = await dependencies.collectInputs();
    assert.equal(collected.quotes[0].quality.status, "observed");
    assert.equal(collected.quotes[0].historical, undefined);
    const inputs = qualifyReportInputs(collected, { now: fixture.now, maxAgeSeconds: settings.dataValidation.maxAgeSeconds });
    assert.equal(inputs.quotes[0].quality.actionable, true);
    const supplements = await dependencies.buildOptions([{ symbol: "NVDA", trade_direction: "long" }], inputs.quotes, []);
    assert.equal(supplements[0].strategy, "skip_options");
    await dependencies.sendEmail({ subject: "Synthetic", content: "No delivery", idempotencyKey: "synthetic" });
    assert.equal(sent.to[0], credentials.EMAIL_TO); assert.equal(sent.from, credentials.EMAIL_FROM);
    assert.equal(emailClients, 1); assert.ok(requests.length >= 6);
  } finally {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test("retired switches fail before any report stage and cannot disable required qualification", async () => {
  const settings = makeConfig();
  for (const change of [{ historicalIndicators: { enabled: false } }, { evaluation: { enabled: false } },
    { regimeEvents: { enabled: false } }, { execution: { runRecordsEnabled: false } }, { dataValidation: { enabled: false } }]) {
    await assert.rejects(runReport({ ...settings, ...change }, { dryRun: true }, {
      collectInputs: () => assert.fail("Unsupported modes must fail before input collection")
    }), /Unsupported pipeline mode/);
  }
  for (const key of ["ENABLE_DATA_VALIDATION", "ENABLE_RUN_RECORDS", "ENABLE_CORRECT_EVALUATION", "ENABLE_HISTORICAL_INDICATORS", "ENABLE_REGIME_EVENTS", "ENABLE_REGIME_ALIGNMENT_FILTER", "DRY_RUN", "REPORT_RUN_ID", "REPORT_RUN_NAMESPACE"]) {
    assert.throws(() => makeConfig({ [key]: "false" }), /Unsupported configuration/);
  }
});

test("configuration rejects malformed options and serialized recovery settings exclude credentials", () => {
  for (const env of [{ ENABLE_OPTIONS_SUPPLEMENT: "maybe" }, { QUOTE_MAX_AGE_SECONDS: "invalid" },
    { QUOTE_MAX_AGE_SECONDS: "-1" }, { OPTIONS_DATA_PROVIDER: "unknown" }]) assert.throws(() => makeConfig(env));
  const serialized = JSON.stringify(safeSettings(makeConfig()));
  for (const secret of Object.values(credentials)) assert.ok(!serialized.includes(secret));
  assert.match(serialized, /public-report-v3/);
});
