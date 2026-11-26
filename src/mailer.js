function validateDelivery(settings) {
  if (!settings.resendApiKey || !settings.emailTo?.split(",").some(value => value.trim())) throw new Error("Email configuration unavailable");
}

async function sendEmail({ subject, content, idempotencyKey, runId }, dependencies = {}) {
  try {
    const resend = dependencies.client;
    if (!resend) throw new Error("An explicit email client is required");
    const emailTo = dependencies.emailTo;
    if (!emailTo) {
      throw new Error("Missing EMAIL_TO or EMAIL environment variable");
    }
    const recipients = emailTo
      .split(",")
      .map((email) => email.trim())
      .filter(Boolean);

    const response = await resend.emails.send({
      from: dependencies.emailFrom || "Research Reports <onboarding@resend.dev>",
      to: recipients,
      subject,
      html: content,
      ...(runId ? { tags: [{ name: "report_run", value: runId }] } : {})
    }, { ...(idempotencyKey ? { idempotencyKey } : {}), signal: AbortSignal.timeout(15000) });

    if (response.error || !response.data?.id) throw new Error("Email provider did not confirm acceptance");

    console.log("Email acceptance confirmed");
    return { id: response.data.id };
  } catch (error) {
    console.error("Failed to confirm email acceptance");
    throw new Error("Email acceptance unavailable");
  }
}

module.exports = { sendEmail, validateDelivery };
