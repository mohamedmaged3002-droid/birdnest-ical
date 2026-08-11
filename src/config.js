// Central tunables for the BirdNest -> iCal bridge.
//
// Unlike the brassbell bridge (which probes each night through a booking form),
// BirdNest hands us the whole calendar in one HTML response. So the polite-crawl
// budget here is one request per unit per run — we can afford real concurrency,
// but keep it modest: this is someone else's origin.
module.exports = {
  // Raised 13 -> 15 on 2026-08-10. We emit only BLOCKED events, so everything
  // past the horizon reads as AVAILABLE downstream: a horizon shorter than the
  // operator's declared blocks silently reopens nights they have closed. wp
  // 46443 was the proof — BirdNest blocked to 2027-09-29 while a 13-month
  // horizon stopped at 2027-09-10, leaving 19 nights open that BirdNest sells
  // as closed. Costs nothing: BirdNest returns checkInBlockedDates as absolute
  // RANGES in one response, so a longer horizon is more enumeration of the same
  // single request, not more traffic.
  HORIZON_MONTHS: Number(process.env.HORIZON_MONTHS) || 15,
  UNIT_CONCURRENCY: Number(process.env.UNIT_CONCURRENCY) || 6,

  FETCH_TIMEOUT_MS: Number(process.env.FETCH_TIMEOUT_MS) || 30000,
  FETCH_RETRIES: Number(process.env.FETCH_RETRIES) || 3,
  RETRY_BACKOFF_MS: Number(process.env.RETRY_BACKOFF_MS) || 1500,

  // BirdNest stamps blocked-date epochs at midnight Egypt local time.
  OPERATOR_TZ: 'Africa/Cairo',

  PROPERTY_BASE: 'https://birdnestlife.com/property',
  PAGES_BASE_URL:
    process.env.PAGES_BASE_URL || 'https://mohamedmaged3002-droid.github.io/birdnest-ical',

  USER_AGENT:
    process.env.USER_AGENT ||
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};
