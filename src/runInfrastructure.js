const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { feedback_issuance_days } = require("../config/evaluation-contract.json");

function sanitize(value, env = process.env) {
  const publicTokenFields = new Set(["max_tokens", "max_completion_tokens", "prompt_tokens", "completion_tokens", "total_tokens"]);
  const secrets = Object.entries(env).filter(([key, val]) => /KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL/.test(key) && val?.length >= 8).map(([, val]) => val);
  function clean(item) {
    if (typeof item === "string") {
      let result = item.replace(/postgres(?:ql)?:\/\/[^\s"<>]+/gi, "[redacted-database-url]");
      for (const secret of secrets) result = result.split(secret).join("[redacted]");
      return result;
    }
    if (Array.isArray(item)) return item.map(clean);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item)
      .filter(([key, val]) => val !== undefined && (publicTokenFields.has(key)
        || !/api.?key|secret|token|password|authorization|database.?url|connection.?string|email.?to/i.test(key)))
      .map(([key, val]) => [key, clean(val)]));
    return item;
  }
  return clean(value);
}


function safeSettings(settings) {
  return sanitize({ model: settings.model, watchlist: settings.watchlist,
    ...(settings.execution?.runNamespace ? { runNamespace: settings.execution.runNamespace } : {}),
    ...(settings.delivery ? { delivery: settings.delivery } : {}),
    pipeline_version: "public-report-v3", dataValidation: settings.dataValidation, options: settings.options });
}


function writeArtifact(value) {
  const folder = path.resolve(__dirname, "../local-data/report-runs");
  fs.mkdirSync(folder, { recursive: true });
  const base = path.join(folder, crypto.randomUUID());
  const safe = sanitize(value);
  fs.writeFileSync(`${base}.json`, JSON.stringify(safe, null, 2));
  if (safe.output?.html) fs.writeFileSync(`${base}.html`, safe.output.html);
  return `${base}.json`;
}


async function connectRunDatabase(settings) {
  if (!settings.databaseUrl) return null;
  const { DatabaseClient } = require("./database");
  const db = new DatabaseClient(settings.databaseUrl);
  try {
    await db.connect();
    if (!await db.validateSchema()) throw new Error("Missing schema");
    return db;
  } catch {
    await db.disconnect().catch(() => {});
    return null;
  }
}


async function readFeedback(db, settings) {
  if (!db) return "";
  const feedback = await db.getCorrectEvaluationContext(require("./evaluationPolicy").policy.version, feedback_issuance_days, settings.execution?.runNamespace || "");
  return require("./performanceContext").formatRecommendationFeedback(feedback);
}

module.exports = { sanitize, safeSettings, writeArtifact, connectRunDatabase, readFeedback };
