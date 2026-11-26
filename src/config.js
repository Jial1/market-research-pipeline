const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");

// Resolve only this repository's environment file, never the parent private project.
function loadEnvironment() {
  require("dotenv").config({ path: path.join(root, ".env"), quiet: true });
}
function bool(value, fallback = false) {
  if (value == null || value === "") return fallback;
  if (/^(true|1|yes|on)$/i.test(value)) return true;
  if (/^(false|0|no|off)$/i.test(value)) return false;
  throw new Error("Invalid boolean configuration value");
}
const number = (value, fallback) => value == null || value === "" || !Number.isFinite(Number(value)) ? fallback : Number(value);

function createConfig(env = process.env, { watchlist: suppliedWatchlist } = {}) {
  for (const name of ["ENABLE_DATA_VALIDATION", "ENABLE_RUN_RECORDS", "ENABLE_CORRECT_EVALUATION", "ENABLE_HISTORICAL_INDICATORS", "ENABLE_REGIME_EVENTS", "ENABLE_REGIME_ALIGNMENT_FILTER", "MIN_RISK_REWARD", "DRY_RUN", "REPORT_RUN_ID", "REPORT_RUN_NAMESPACE"]) {
    if (env[name] != null && env[name] !== "") throw new Error(`Unsupported configuration: ${name}; the public pipeline has fixed validation and evaluation rules`);
  }
  if (env.OPTIONS_DATA_PROVIDER) throw new Error("OPTIONS_DATA_PROVIDER was removed; options use MarketData only");
  if (env.MARKETDATA_API_KEY) throw new Error("MARKETDATA_API_KEY is unsupported; use MARKETDATA_TOKEN");
  const watchlist = [...new Set((suppliedWatchlist || fs.readFileSync(path.resolve(root, env.WATCHLIST_FILE || "watchlist.txt"), "utf8")
    .split(/[\s,]+/)).map(s => s.trim().toUpperCase()).filter(Boolean))];
  if (!watchlist.length || watchlist.some(s => !/^[A-Z][A-Z0-9.-]{0,9}$/.test(s))) throw new Error("Invalid or empty watchlist");
  const maxAgeSeconds = number(env.QUOTE_MAX_AGE_SECONDS, 900);
  if (maxAgeSeconds <= 0 || (env.QUOTE_MAX_AGE_SECONDS && !Number.isFinite(Number(env.QUOTE_MAX_AGE_SECONDS)))) throw new Error("Invalid quote freshness threshold");
  return {
    openaiApiKey: env.OPENAI_API_KEY, resendApiKey: env.RESEND_API_KEY,
    finnhubApiKey: env.FINNHUB_API_KEY, alpacaApiKey: env.ALPACA_API_KEY, alpacaSecretKey: env.ALPACA_SECRET_KEY,
    databaseUrl: env.DATABASE_URL, emailFrom: env.EMAIL_FROM || "Research Reports <onboarding@resend.dev>",
    emailTo: env.EMAIL_TO, model: env.OPENAI_MODEL || "gpt-4o-mini", watchlist,
    execution: { runNamespace: "", runIdentity: env.GITHUB_WORKFLOW || "daily-report" },
    delivery: { email: false },
    dataValidation: { maxAgeSeconds },
    options: {
      enabled: bool(env.ENABLE_OPTIONS_SUPPLEMENT, true),
      marketDataToken: env.MARKETDATA_TOKEN, marketDataMode: env.MARKETDATA_MODE,
      marketDataStrikeLimit: 12, marketDataDteTargets: null,
      minDte: 14, maxDte: 60, preferredMinDte: 21, preferredMaxDte: 45,
      maxBidAskSpreadPct: 15, minOpenInterest: 100, minVolume: 10, maxPremiumRisk: 800
    }
  };
}
function assertPipelineSettings(settings) {
  if (["evaluation", "historicalIndicators", "regimeEvents"].some(key => Object.hasOwn(settings, key))
    || Object.hasOwn(settings.execution || {}, "runRecordsEnabled") || Object.hasOwn(settings.execution || {}, "runId")
    || Object.hasOwn(settings.dataValidation || {}, "enabled")) throw new Error("Unsupported pipeline mode; validation, history, context and corrected evaluation are always enabled");
}
module.exports = { createConfig, loadEnvironment, root, assertPipelineSettings };
