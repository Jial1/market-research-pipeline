const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { buildInputSnapshot, buildReportOutput } = require("../src/reportBuilder");
const { sanitize } = require("../src/runInfrastructure");
const { makePreparationFixture } = require("../fixtures/preparation-report");
const settings = { model: "fixture", dataValidation: { maxAgeSeconds: 900 }, options: { enabled: true } };
const redact = value => sanitize(value, {});
const fixture = () => makePreparationFixture(Date.parse("2026-10-21T16:00:00Z"));

test("snapshot integrity covers redacted evidence/request while unavailable feedback stays optional", async () => {
  const f = fixture(), secret = "synthetic-secret-for-redaction";
  f.inputs.news.NVDA.items = [{ headline: secret }];
  const snapshot = await buildInputSnapshot(f.inputs, settings, { now: () => f.now,
    redact: value => sanitize(value, { API_KEY: secret }), readFeedback: async () => { throw new Error("unavailable"); } });
  assert.equal(snapshot.feedback, "");
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secret));
  const { evidence_hash, ...contents } = snapshot;
  assert.equal(evidence_hash, crypto.createHash("sha256").update(JSON.stringify(contents)).digest("hex"));
  f.inputs.quotes.forEach(q => { q.provider_at = "2026-10-20T20:00:00Z"; });
  await assert.rejects(buildInputSnapshot(f.inputs, settings, { now: () => f.now, redact,
    readFeedback: () => assert.fail("Unqualified evidence must fail before feedback") }), /No usable historical evidence/);
});

test("saved model completion controls recovered numerical decisions rather than the retry context", async () => {
  const f = fixture();
  const snapshot = await buildInputSnapshot(f.inputs, settings, { now: () => f.now, redact, readFeedback: async () => "" });
  const options = { now: () => f.now, date: "2026-10-21", dry: true, completion: { finish_reason: "stop" }, redact, buildOptions: async () => [] };
  const incomplete = await buildReportOutput({ ...snapshot, model_completion: { finish_reason: "length" } }, f.report, settings, options);
  assert.deepEqual(incomplete.recommendations, []);
  const complete = await buildReportOutput({ ...snapshot, model_completion: { finish_reason: "stop" } }, f.report, settings,
    { ...options, completion: { finish_reason: "length" } });
  assert.deepEqual(complete.recommendations.map(p => p.symbol), ["NVDA"]);
});

test("options receive only final qualified plans and failures propagate without changing the saved snapshot", async () => {
  const f = fixture();
  const snapshot = await buildInputSnapshot(f.inputs, settings, { now: () => f.now, redact, readFeedback: async () => "" });
  const before = JSON.stringify(snapshot);
  await assert.rejects(buildReportOutput(snapshot, f.report, settings, { now: () => f.now, date: "2026-10-21", dry: false, redact,
    buildOptions: async plans => { assert.deepEqual(plans.map(p => p.symbol), ["NVDA"]); throw new Error("synthetic options failure"); }
  }), /synthetic options failure/);
  assert.equal(JSON.stringify(snapshot), before);
});
