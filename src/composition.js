// The CLI constructs this object once. Adapters receive captured credentials;
// importing modules never loads configuration or constructs paid-service clients.
const { connectRunDatabase, writeArtifact, readFeedback } = require("./runInfrastructure");
const { collectReportInputs } = require("./data/reportInputs");
const { earningsRequestWindow } = require("./qualification");
const { fetchQuotes } = require("./market");
const { fetchAllNews } = require("./news");
const { fetchMarketCalendar } = require("./data/marketCalendar");
const { fetchAlpacaCandles } = require("./data/alpacaCandles");
const { fetchEarnings } = require("./data/earnings");
const { generateReport } = require("./ai");
const { sendEmail, validateDelivery } = require("./mailer");
const { buildOptionsSupplements } = require("./optionsSupplement");
const { fetchOptionChain } = require("./optionsData");

function createLiveDependencies(settings, {
  createModelClient = key => new (require("openai"))({ apiKey: key }),
  createEmailClient = key => new (require("resend").Resend)(key),
  now = Date.now,
  get
} = {}) {
  for (const [name, value] of [["OPENAI_API_KEY", settings.openaiApiKey], ["FINNHUB_API_KEY", settings.finnhubApiKey],
    ["ALPACA_API_KEY", settings.alpacaApiKey], ["ALPACA_SECRET_KEY", settings.alpacaSecretKey], ["DATABASE_URL", settings.databaseUrl]]) {
    if (!value) throw new Error(`Missing ${name}; use npm start for the offline demo`);
  }
  if (settings.delivery.email) validateDelivery(settings);
  const modelClient = createModelClient(settings.openaiApiKey);
  const emailClient = settings.delivery.email ? createEmailClient(settings.resendApiKey) : null;
  const env = Object.freeze({ FINNHUB_API_KEY: settings.finnhubApiKey,
    ALPACA_API_KEY: settings.alpacaApiKey, ALPACA_SECRET_KEY: settings.alpacaSecretKey });
  return {
    now, connectDatabase: connectRunDatabase, writeArtifact, readFeedback,
    collectInputs: () => collectReportInputs(settings.watchlist, {
      now, earningsWindow: earningsRequestWindow,
      fetchQuotes: symbols => fetchQuotes(symbols, { apiKey: env.FINNHUB_API_KEY, now, get }),
      fetchAllNews: (symbols, options) => fetchAllNews(symbols, { ...options, apiKey: env.FINNHUB_API_KEY, now, get }),
      fetchCalendar: options => fetchMarketCalendar({ ...options, env, get }),
      fetchHistory: (symbol, calendar, options) => fetchAlpacaCandles(symbol, calendar, { ...options, env, get }),
      fetchEarnings: (symbol, options) => fetchEarnings(symbol, { ...options, env, get })
    }),
    generateReport: (inputs, feedback, request) => generateReport(request, modelClient),
    buildOptions: (plans, quotes, snapshots) => buildOptionsSupplements(plans, quotes,
      settings.options, snapshots,
      { fetchChain: (symbol, price, config) => fetchOptionChain(symbol, price, config, { get }) }),
    sendEmail: payload => sendEmail(payload, { client: emailClient, emailTo: settings.emailTo, emailFrom: settings.emailFrom })
  };
}
module.exports = { createLiveDependencies };
