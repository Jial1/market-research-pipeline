const { createReadGet } = require("../readRetry");
const providerGet = createReadGet();
const zone = "America/New_York";
const dateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
});
const sessionDate = ms => dateFormatter.format(new Date(ms));
const shiftDate = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

function sessionTime(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new Error("Invalid session time");
  const target = Date.parse(`${date}T${time}:00Z`);
  if (!Number.isFinite(target) || new Date(target).toISOString().slice(0, 16) !== `${date}T${time}`) throw new Error("Invalid session time");
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(partsFormatter.formatToParts(new Date(guess)).map(x => [x.type, x.value]));
    const represented = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    const delta = target - represented;
    if (!delta) return guess;
    guess += delta;
  }
  throw new Error("Unresolvable session time");
}

function normalizeCalendar(rows, start, end) {
  if (!Array.isArray(rows) || !rows.length) throw new Error("Missing calendar");
  return rows.map((day, i) => {
    if (!day || day.date < start || day.date > end || (i && day.date <= rows[i - 1].date)) throw new Error("Invalid calendar");
    const open = sessionTime(day.date, day.open);
    const close = sessionTime(day.date, day.close);
    if (open >= close) throw new Error("Invalid calendar hours");
    return { date: day.date, open_at: new Date(open).toISOString(), close_at: new Date(close).toISOString() };
  });
}

function calendarContext(calendar, now) {
  const date = sessionDate(now);
  if (calendar?.status !== "ok" || date < calendar.start || date > calendar.end) {
    return { state: "unknown", date, previous_session: null, next_session: null };
  }
  const today = calendar.sessions.find(s => s.date === date);
  const previous = calendar.sessions.filter(s => Date.parse(s.close_at) <= now).at(-1);
  const next = calendar.sessions.find(s => s.date > date);
  const state = today && now >= Date.parse(today.open_at) && now < Date.parse(today.close_at) ? "open" : "closed";
  return { state, date, previous_session: previous || null, next_session: next || null, current_session: today || null };
}

async function fetchMarketCalendar({ now = Date.now(), env = {}, get = providerGet } = {}) {
  const today = sessionDate(now);
  const start = shiftDate(today, -400);
  const end = shiftDate(today, 14);
  const base = { source: "alpaca_calendar", start, end, fetched_at: new Date(now).toISOString() };
  if (!env.ALPACA_API_KEY || !env.ALPACA_SECRET_KEY) return { ...base, status: "failed", reasons: ["missing_calendar_credentials"], sessions: [] };
  try {
    const response = await get("https://paper-api.alpaca.markets/v2/calendar", {
      headers: { "APCA-API-KEY-ID": env.ALPACA_API_KEY, "APCA-API-SECRET-KEY": env.ALPACA_SECRET_KEY },
      params: { start, end }, timeout: 10000
    });
    const sessions = normalizeCalendar(response.data, start, end);
    if (!sessions.some(s => s.date < today) || !sessions.some(s => s.date > today)) throw new Error("Insufficient calendar");
    return { ...base, status: "ok", reasons: [], sessions };
  } catch {
    return { ...base, status: "failed", reasons: ["calendar_unavailable_or_invalid"], sessions: [] };
  }
}

module.exports = { sessionDate, shiftDate, sessionTime, normalizeCalendar, calendarContext, fetchMarketCalendar };
