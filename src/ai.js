async function generateReport(request, client) {
  if (!client) throw new Error("An explicit model client is required");
  if (!request) throw new Error("An explicit model request is required");
  // Paid generation has one deadline and no automatic retries.
  const completion = await client.chat.completions.create(request,
    { maxRetries: 0, timeout: 60000, signal: AbortSignal.timeout(60000) });
  const choice = completion.choices?.[0];
  return {
    content: choice?.message?.content ?? JSON.stringify({ refusal: choice?.message?.refusal || "empty_model_response" }),
    finish_reason: choice?.finish_reason ?? null,
    usage: Object.fromEntries(["prompt_tokens", "completion_tokens", "total_tokens"]
      .map(key => [key, Number.isSafeInteger(completion.usage?.[key]) && completion.usage[key] >= 0 ? completion.usage[key] : null]))
  };
}
module.exports = { generateReport };
