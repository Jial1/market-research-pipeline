const { createReadGet } = require("./readRetry");
const getOptions = createReadGet();
const { daysToExpiration, toNumber, calculateMid } = require("./optionsMath");

function valueAt(payload, keys, index) {
  for (const key of keys) {
    const value = payload?.[key];
    if (Array.isArray(value) && value[index] !== undefined && value[index] !== null && value[index] !== "") {
      return value[index];
    }
    if (!Array.isArray(value) && value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return null;
}

function normalizeExpiration(value) {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "number") {
    return new Date(value * 1000).toISOString().split("T")[0];
  }

  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    return text.slice(0, 10);
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().split("T")[0];
}

function normalizeSide(value) {
  const text = String(value || "").toLowerCase();
  if (text === "put" || text === "p") return "put";
  if (text === "call" || text === "c") return "call";
  return null;
}

function normalizeMarketDataOptionChain(symbol, payload, fallbackUnderlyingPrice) {
  if (!payload || payload.s === "no_data") return [];

  const length = Math.max(
    payload.optionSymbol?.length || 0,
    payload.strike?.length || 0,
    payload.side?.length || 0,
    payload.expiration?.length || 0
  );

  const contracts = [];
  for (let index = 0; index < length; index += 1) {
    const optionType = normalizeSide(valueAt(payload, ["side", "optionSide", "Option_Side"], index));
    const expiration = normalizeExpiration(valueAt(payload, ["expiration", "expirationDate", "Expiration_Date"], index));
    const bid = toNumber(valueAt(payload, ["bid", "Bid"], index));
    const ask = toNumber(valueAt(payload, ["ask", "Ask"], index));
    const last = toNumber(valueAt(payload, ["last", "Last"], index));
    const mid = toNumber(valueAt(payload, ["mid", "Mid"], index)) ?? calculateMid(bid, ask, last);
    const underlyingPrice = toNumber(valueAt(payload, ["underlyingPrice", "Underlying_Price"], index)) ?? fallbackUnderlyingPrice;

    contracts.push({
      symbol,
      option_symbol: valueAt(payload, ["optionSymbol", "option_symbol", "OptionSymbol"], index),
      expiration,
      option_type: optionType,
      strike: toNumber(valueAt(payload, ["strike", "Strike"], index)),
      bid,
      ask,
      last,
      mid,
      volume: toNumber(valueAt(payload, ["volume", "Volume"], index)) ?? 0,
      open_interest: toNumber(valueAt(payload, ["openInterest", "open_interest", "Open_Interest"], index)) ?? 0,
      implied_volatility: toNumber(valueAt(payload, ["iv", "IV", "impliedVolatility"], index)),
      delta: toNumber(valueAt(payload, ["delta", "Delta"], index)),
      gamma: toNumber(valueAt(payload, ["gamma", "Gamma"], index)),
      theta: toNumber(valueAt(payload, ["theta", "Theta"], index)),
      vega: toNumber(valueAt(payload, ["vega", "Vega"], index)),
      underlying_price: underlyingPrice,
      days_to_expiration: toNumber(valueAt(payload, ["dte", "Days_To_Expiration"], index)) ?? daysToExpiration(expiration)
    });
  }

  return contracts.filter(contract => contract.expiration && contract.strike && contract.option_type);
}

// MarketData is the only public options adapter. Provider selection is not a mode.
async function fetchOptionChain(symbol, underlyingPrice, config = {}, { get = getOptions } = {}) {
  if (Object.hasOwn(config, "provider")) throw new Error("Options provider selection was removed; configure MARKETDATA_TOKEN");
  const token = config.marketDataToken;
  if (!token) {
    throw new Error("Missing MARKETDATA_TOKEN");
  }

  const url = `https://api.marketdata.app/v1/options/chain/${encodeURIComponent(symbol)}/`;
  const dteTargets = getDteTargets(config);
  const contracts = [];
  const errors = [];

  for (const dte of dteTargets) {
    const params = buildMarketDataParams(config, dte);
    try {
      const payload = await fetchMarketDataPayload(url, token, params, get);
      contracts.push(...normalizeMarketDataOptionChain(symbol, payload, underlyingPrice));
    } catch (error) {
      errors.push(error.message);
    }
  }

  const uniqueContracts = dedupeContracts(contracts);
  if (uniqueContracts.length > 0) {
    return uniqueContracts;
  }

  if (errors.length > 0) {
    throw new Error(errors.join(" | "));
  }

  return [];
}

function buildMarketDataParams(config, dte) {
  return {
    dte,
    strikeLimit: config.marketDataStrikeLimit || 12,
    ...(config.optionSide ? { side: config.optionSide } : {}),
    ...(config.marketDataMode ? { mode: config.marketDataMode } : {})
  };
}

async function fetchMarketDataPayload(url, token, params, get) {
  let response;
  try {
    response = await get(url, {
      timeout: 15000,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      },
      params,
      validateStatus: status => (status >= 200 && status < 300) || status === 203 || status === 204
    });
  } catch (error) {
    const message = error.response?.data?.errmsg ||
      error.response?.data?.message ||
      error.message;
    throw new Error(`MarketData.app request failed (${formatParams(params)}): ${message}`);
  }

  if (response.status === 204) {
    return { s: "no_data" };
  }

  if (response.data?.s === "error") {
    throw new Error(`MarketData.app option chain error (${formatParams(params)}): ${response.data.errmsg || "unknown error"}`);
  }

  return response.data;
}

function formatParams(params) {
  return Object.entries(params)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function getDteTargets(config = {}) {
  if (Array.isArray(config.marketDataDteTargets) && config.marketDataDteTargets.length > 0) {
    return uniqueNumbers(config.marketDataDteTargets);
  }

  const min = config.preferredMinDte || 21;
  const max = config.preferredMaxDte || 45;
  const midpoint = Math.round((min + max) / 2);
  const lower = min === 21 && max === 45 ? 28 : Math.round((min + midpoint) / 2);
  const upper = min === 21 && max === 45 ? 42 : Math.round((midpoint + max) / 2);

  return uniqueNumbers([midpoint, lower, upper, min, max]);
}

function uniqueNumbers(values) {
  return [...new Set(values.map(value => Number(value)).filter(value => Number.isFinite(value) && value > 0))];
}

function dedupeContracts(contracts) {
  const seen = new Set();
  const unique = [];

  for (const contract of contracts) {
    const key = contract.option_symbol ||
      `${contract.symbol}:${contract.expiration}:${contract.strike}:${contract.option_type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(contract);
  }

  return unique;
}

module.exports = {
  fetchOptionChain,
  getDteTargets,
  normalizeMarketDataOptionChain
};
