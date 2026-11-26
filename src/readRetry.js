const axios = require("axios");
const networkCodes = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EAI_AGAIN", "ERR_NETWORK", "ERR_CANCELED"]);

function retryDelay(value, now) {
  if (value == null) return null;
  const seconds = typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : typeof value === "number" ? value : null;
  if (seconds !== null) return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
  if (typeof value !== "string" || !/[A-Za-z]/.test(value)) return null;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}
async function readWithRetry(action, { now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), random = Math.random } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await action();
      return response;
    } catch (error) {
      const status = error.response?.status ?? error.status;
      const transient = status === 408 || status === 429 || (status >= 500 && status <= 599) || (!status && networkCodes.has(error.code));
      const headers = error.response?.headers || {};
      const advised = retryDelay(headers["retry-after"], now());
      // Never shorten a provider delay. Defer long waits to a later run.
      if (!transient || attempt === 2 || (advised !== null && advised > 5000)) throw error;
      await sleep(advised ?? Math.round(250 * 2 ** attempt + random() * 250));
    }
  }
}
function createReadGet(get = axios.get, retryOptions = {}) {
  return (url, options = {}) => readWithRetry(() => {
    const timeout = Math.min(15000, Math.max(1, options.timeout || 10000));
    return get(url, { ...options, timeout, signal: options.signal || AbortSignal.timeout(timeout) });
  }, retryOptions);
}
module.exports = { retryDelay, readWithRetry, createReadGet };
