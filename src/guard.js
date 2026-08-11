// Decide whether a fresh scrape result should overwrite the last-good .ics.
//
// prev:    { availableCount, collapseStreak, emptyStreak } from the previous run
//          (either a written index entry or a pending stub), or null on the very
//          first sighting of a unit.
// current: { ok, blocked, available } counts from this scrape.
//
// Returns { write, reason, collapseStreak, emptyStreak }. The caller MUST persist
// BOTH streaks even when write is false — a gate that only records state on
// success can never accumulate the agreeing observations it needs, so it blocks
// forever (brassbell L-074: a permanent collapse served a 39-day-stale feed).
//
// Asymmetry that drives every decision: our feed emits only BLOCKED events, so
// anything we fail to publish reads as AVAILABLE downstream. Suppressing a write
// fails OPEN, toward double-booking — the expensive direction. Refusing is only
// safe when the alternative would publish a *wider-open* calendar than reality.

// How many consecutive runs must agree before we believe a surprising result.
// At the hourly cadence (was 6h until 2026-08-10) that is ~3h of confirmation,
// down from ~18h. Deliberate: the delay is a cost, not a benefit — while we
// withhold a collapsed calendar we serve the WIDER-open previous one, which is
// the double-booking direction. Three identical scrapes still rule out a
// transient glitch, which is all the streak was ever for.
const COLLAPSE_CONFIRM_RUNS = 3;
const EMPTY_CONFIRM_RUNS = 3;

function shouldWrite(prev, current) {
  const { ok, blocked, available } = current;
  const carried = {
    collapseStreak: (prev && prev.collapseStreak) || 0,
    emptyStreak: (prev && prev.emptyStreak) || 0,
  };

  // Every unhealthy exit resets both streaks: confirmation is only meaningful
  // because a REAL state repeats identically run after run, so a broken scrape
  // must never be able to confirm itself.
  if (!ok) return { write: false, reason: 'scrape-not-ok', collapseStreak: 0, emptyStreak: 0 };

  // Nothing blocked at all is legitimate (brand-new listing with no bookings),
  // but it is also what a silently-changed payload shape looks like. Refuse on
  // first sight, then accept once enough runs agree — otherwise a genuinely
  // empty calendar could never be published at all.
  if (blocked === 0) {
    const hasWritten = prev && typeof prev.blockedRanges === 'number';
    if (!hasWritten) {
      const streak = carried.emptyStreak + 1;
      if (streak >= EMPTY_CONFIRM_RUNS) {
        return { write: true, reason: 'empty-confirmed', collapseStreak: 0, emptyStreak: 0 };
      }
      return { write: false, reason: 'empty-first-observation', collapseStreak: 0, emptyStreak: streak };
    }
    // We have published this unit before; an emptied calendar is just the
    // collapse case and is handled by the gate below.
  }

  if (prev && typeof prev.availableCount === 'number' && prev.availableCount > 0) {
    if (available < prev.availableCount * 0.5) {
      // A halving of availability is usually a scrape glitch — but it is ALSO
      // what a unit going off-sale looks like (owner pulled it, long-term let,
      // seasonal closure), and that state is permanent. Refuse on first sight,
      // accept once enough runs concur. A false confirmation costs bookings
      // (unit shows blocked) — the safe direction — and self-heals, because
      // writing it sets availableCount low and disables this gate until
      // availability returns.
      const streak = carried.collapseStreak + 1;
      if (streak >= COLLAPSE_CONFIRM_RUNS) {
        return { write: true, reason: 'availability-collapse-confirmed', collapseStreak: 0, emptyStreak: 0 };
      }
      return { write: false, reason: 'availability-collapse', collapseStreak: streak, emptyStreak: 0 };
    }
  }

  return { write: true, reason: 'ok', collapseStreak: 0, emptyStreak: 0 };
}

module.exports = { shouldWrite, COLLAPSE_CONFIRM_RUNS, EMPTY_CONFIRM_RUNS };
