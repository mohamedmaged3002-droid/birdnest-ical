const { iso, parseIso, addDays } = require('./dates');
const cfg = require('./config');

// BirdNest renders each property page with its availability already embedded in
// the RSC flight payload:
//
//   self.__next_f.push([1,"2b:{\"checkInBlockedDates\":[{\"from\":1790852400000,\"to\":1830074400000}],...
//
// so a single plain GET per unit yields the full calendar — no date-picker
// driving, no per-night probing, no Playwright. That is why this bridge is far
// cheaper and far less flaky than the brassbell one.
//
// SEMANTICS (verified 2026-08-03 against unit 5081, which also has a first-party
// RentalsUnited feed — four ranges matched exactly):
//   checkInBlockedDates {from, to} is INCLUSIVE on both ends and enumerates the
//   dates you cannot CHECK IN on. A RentalsUnited VEVENT for the same booking is
//   DTSTART=from, DTEND=to+1day (DTEND exclusive). Expanding [from..to] to
//   individual nights and letting collapseBlocked() re-derive endExclusive
//   therefore reproduces the operator's own feed.
//     live checkIn 2026-08-18..2026-08-23  <->  RU 20260818..20260824  ✓
//     live checkIn 2026-08-25..2026-08-30  <->  RU 20260825..20260831  ✓
//     live checkIn 2026-09-01..2026-09-06  <->  RU 20260901..20260907  ✓
//     live checkIn 2026-10-10..2027-09-29  <->  RU 20261010..20270930  ✓
//
// checkOutBlockedDates is the same list shifted +1 day; it carries no extra
// information, so we ignore it.
const BLOCKED_RE = /checkInBlockedDates\\":(\[.*?\])/;

// Epoch ms -> 'YYYY-MM-DD'. BirdNest stamps midnight Egypt local (UTC+2/+3) as
// e.g. 1790852400000 = 2026-09-30T21:00Z, so reading it in UTC would shift the
// date a day earlier. Convert in the Africa/Cairo wall clock instead.
function msToIso(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: cfg.OPERATOR_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(Number(ms)));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// [{from,to}] -> flat list of ISO dates, clipped to [startDate, startDate+nights).
// Ranges are expanded rather than passed through so that overlapping ranges (the
// live page emits them, e.g. 08-02..08-15 alongside 08-03..08-03) merge cleanly.
function expandRanges(ranges, startDate, nights) {
  const first = iso(startDate);
  const lastExclusive = iso(addDays(startDate, nights));
  const out = [];
  for (const r of ranges) {
    if (r == null || r.from == null || r.to == null) continue;
    let cur = msToIso(r.from);
    const end = msToIso(r.to);
    if (end < cur) continue; // malformed range — ignore rather than loop forever
    // Hard stop: a runaway range (BirdNest publishes closures out to 2029) must
    // not spin per-day for years. Clip to the horizon window up front.
    if (cur < first) cur = first;
    let guard = 0;
    while (cur <= end && cur < lastExclusive && guard++ < nights + 2) {
      if (cur >= first) out.push(cur);
      cur = iso(addDays(parseIso(cur), 1));
    }
  }
  return out;
}

async function fetchText(url, { timeoutMs = cfg.FETCH_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': cfg.USER_AGENT, Accept: 'text/html' },
      redirect: 'follow',
    });
    if (!res.ok) return { ok: false, status: res.status, body: '' };
    return { ok: true, status: res.status, body: await res.text() };
  } catch (e) {
    return { ok: false, status: 0, body: '', error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

// Scrape one unit. Returns
//   { ok, blocked:[iso], availableCount, url, reason }
// ok=false means "do not trust this result" — the caller keeps the last-good feed.
async function scrapeUnit(unit, { startDate, nights }) {
  const urls = [unit.url, ...(unit.altUrls || [])].filter(Boolean);
  let lastReason = 'no-url';

  for (const url of urls) {
    let res = null;
    for (let attempt = 1; attempt <= cfg.FETCH_RETRIES; attempt++) {
      res = await fetchText(url);
      if (res.ok) break;
      if (attempt < cfg.FETCH_RETRIES) await new Promise((r) => setTimeout(r, cfg.RETRY_BACKOFF_MS * attempt));
    }
    if (!res || !res.ok) {
      lastReason = `http-${res ? res.status : 0}`;
      continue;
    }

    const m = BLOCKED_RE.exec(res.body);
    if (!m) {
      // The short URL form (/property/5956) serves the generic marketing shell
      // with no availability payload, so a miss here usually means "wrong path"
      // rather than "no bookings" — try the next candidate URL. Treating it as
      // "nothing blocked" would publish a wide-open calendar. Never do that.
      lastReason = 'no-blocked-field';
      continue;
    }

    let ranges;
    try {
      ranges = JSON.parse(m[1].replace(/\\"/g, '"'));
    } catch (e) {
      lastReason = 'unparseable-blocked-field';
      continue;
    }
    if (!Array.isArray(ranges)) {
      lastReason = 'blocked-field-not-array';
      continue;
    }

    const blocked = [...new Set(expandRanges(ranges, startDate, nights))].sort();
    return {
      ok: true,
      url,
      blocked,
      availableCount: nights - blocked.length,
      rawRanges: ranges.length,
      reason: 'ok',
    };
  }

  return { ok: false, url: urls[0] || null, blocked: [], availableCount: 0, rawRanges: 0, reason: lastReason };
}

module.exports = { scrapeUnit, expandRanges, msToIso, fetchText, BLOCKED_RE };
