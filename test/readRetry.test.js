const { test } = require("node:test");
const assert = require("node:assert/strict");
const { retryDelay, readWithRetry, createReadGet } = require("../src/readRetry");
const error = (status, headers = {}) => Object.assign(new Error("private-url-and-key"), { response: { status, headers } });

test("read retries are capped at three, respect Retry-After and do not expose error bodies", async () => {
  const waits = []; let calls = 0;
  await readWithRetry(async () => {
    calls++; if (calls === 1) throw error(429, { "retry-after": "2" }); if (calls === 2) throw error(503); return "ok";
  }, { sleep: async ms => waits.push(ms), random: () => 0 });
  assert.deepEqual(waits, [2000, 500]); assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(readWithRetry(async () => { calls++; throw error(500); }, { sleep: async () => {} }));
  assert.equal(calls, 3);
});

test("permanent failures and long Retry-After defer without an early retry", async () => {
  for (const failure of [error(401), error(403), error(404), error(422), error(429, { "retry-after": "90" }), new Error("invalid response")]) {
    let calls = 0;
    await assert.rejects(readWithRetry(async () => { calls++; throw failure; }, { sleep: () => assert.fail("wait") }));
    assert.equal(calls, 1);
  }
  const now = Date.parse("2026-10-21T16:00:00Z");
  assert.equal(retryDelay("Wed, 21 Oct 2026 16:00:03 GMT", now), 3000);
  assert.equal(retryDelay("invalid", now), null);
  assert.equal(retryDelay("-1", now), null);
});

test("network reads retry with bounded timeout/cancellation; malformed data is not retried", async () => {
  let calls = 0, captured;
  const get = createReadGet(async (url, options) => {
    captured = options;
    if (++calls < 3) throw Object.assign(new Error("network"), { code: "ECONNRESET" });
    return { data: { invalid: true } };
  }, { sleep: async () => {} });
  const result = await get("https://example.invalid", { timeout: 90000 });
  assert.equal(captured.timeout, 15000); assert.ok(captured.signal instanceof AbortSignal);
  assert.deepEqual(result.data, { invalid: true }); assert.equal(calls, 3);
});

test("paid model call has a single explicit deadline with SDK retries disabled and records usage", async () => {
  const { generateReport } = require("../src/ai");
  let calls = 0;
  const client = { chat: { completions: { create: async (request, options) => {
    calls++; assert.equal(options.maxRetries, 0); assert.equal(options.timeout, 60000); assert.ok(options.signal);
    return { choices: [{ finish_reason: "stop", message: { content: " report " } }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, private: "secret" } };
  } } } };
  const request = { model: "fixture" };
  assert.deepEqual(await generateReport(request, client), { content: " report ", finish_reason: "stop",
    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
  assert.equal(calls, 1);
  client.chat.completions.create = async () => { calls++; throw new Error("timed out"); };
  await assert.rejects(generateReport(request, client)); assert.equal(calls, 2);
  client.chat.completions.create = async () => ({ choices: [] });
  assert.deepEqual(JSON.parse((await generateReport(request, client)).content), { refusal: "empty_model_response" });
});

test("email has a cancellation deadline, per-run tag, stable idempotency and no send retries", async () => {
  const { sendEmail } = require("../src/mailer"); let calls = 0;
  const client = { emails: { send: async (body, options) => {
    calls++; assert.ok(options.signal); assert.equal(options.idempotencyKey, "report-run/id");
    assert.deepEqual(body.tags, [{ name: "report_run", value: "id" }]); throw new Error("lost response");
  } } };
  await assert.rejects(sendEmail({ subject: "fixture", content: "test", runId: "id", idempotencyKey: "report-run/id" },
    { client, emailTo: "fixture@example.invalid" }));
  assert.equal(calls, 1);
});

