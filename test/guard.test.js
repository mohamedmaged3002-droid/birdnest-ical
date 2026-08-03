const test = require('node:test');
const assert = require('node:assert');
const { shouldWrite, COLLAPSE_CONFIRM_RUNS, EMPTY_CONFIRM_RUNS } = require('../src/guard');
const { wireUnits, MARKER } = require('../src/wire');

test('a failed scrape never overwrites the last-good feed', () => {
  const d = shouldWrite({ availableCount: 300, collapseStreak: 0 }, { ok: false, blocked: 0, available: 0 });
  assert.strictEqual(d.write, false);
  assert.strictEqual(d.reason, 'scrape-not-ok');
  assert.strictEqual(d.collapseStreak, 0, 'unhealthy runs reset the streak');
});

test('an empty calendar on first sight is not published', () => {
  // Nothing blocked + no prior observation is indistinguishable from a payload
  // shape change, and publishing it would attach a wide-open feed.
  const d = shouldWrite(null, { ok: true, blocked: 0, available: 395 });
  assert.strictEqual(d.write, false);
  assert.strictEqual(d.reason, 'empty-first-observation');
});

test('normal result writes', () => {
  const d = shouldWrite({ availableCount: 300, collapseStreak: 0 }, { ok: true, blocked: 100, available: 295 });
  assert.strictEqual(d.write, true);
  assert.strictEqual(d.reason, 'ok');
});

test('a sudden availability collapse is refused until confirmed N times', () => {
  const prev = { availableCount: 300, collapseStreak: 0 };
  const cur = { ok: true, blocked: 390, available: 5 };

  let streak = 0;
  for (let run = 1; run < COLLAPSE_CONFIRM_RUNS; run++) {
    const d = shouldWrite({ ...prev, collapseStreak: streak }, cur);
    assert.strictEqual(d.write, false, `run ${run} should still refuse`);
    assert.strictEqual(d.collapseStreak, run);
    streak = d.collapseStreak;
  }
  const final = shouldWrite({ ...prev, collapseStreak: streak }, cur);
  assert.strictEqual(final.write, true, 'accepted once enough runs agree');
  assert.strictEqual(final.reason, 'availability-collapse-confirmed');
  assert.strictEqual(final.collapseStreak, 0, 'streak resets after writing');
});

test('a genuinely closed unit self-heals out of the collapse gate', () => {
  // Once we write availableCount=0 the gate is disabled (prev.availableCount>0
  // is false), so a permanently-closed unit cannot deadlock its own feed.
  const d = shouldWrite({ availableCount: 0, collapseStreak: 0 }, { ok: true, blocked: 395, available: 0 });
  assert.strictEqual(d.write, true);
});

// ---- wire safety ---------------------------------------------------------

function fakeSb(existingRows) {
  const captured = { upserted: null };
  return {
    captured,
    from() {
      return {
        select() {
          return { in: async () => ({ data: existingRows, error: null }) };
        },
        upsert: async (rows) => {
          captured.upserted = rows;
          return { error: null };
        },
      };
    },
  };
}

test('wire never clobbers a first-party operator feed', async () => {
  const sb = fakeSb([
    { wordpress_post_id: 5081, ical_url: 'https://new.rentalsunited.com/iCal/iCal.ashx?apa=4857424', notes: null },
  ]);
  const { upserted, skipped } = await wireUnits(sb, [
    { wp: 5081, slug: 'a', ical_url: 'https://pages/5081.ics' },
  ]);
  assert.strictEqual(upserted, 0);
  assert.strictEqual(skipped.length, 1);
  assert.strictEqual(skipped[0].reason, 'first-party-feed-present');
  assert.strictEqual(sb.captured.upserted, null, 'no write attempted');
});

test('wire does replace a feed it wrote itself', async () => {
  const sb = fakeSb([{ wordpress_post_id: 5956, ical_url: 'https://pages/5956.ics', notes: MARKER }]);
  const { upserted, skipped } = await wireUnits(sb, [
    { wp: 5956, slug: 'b', ical_url: 'https://pages/5956.ics' },
  ]);
  assert.strictEqual(upserted, 1);
  assert.strictEqual(skipped.length, 0);
});

test('wire inserts where no row exists', async () => {
  const sb = fakeSb([]);
  const { upserted } = await wireUnits(sb, [{ wp: 5957, slug: 'c', ical_url: 'https://pages/5957.ics' }]);
  assert.strictEqual(upserted, 1);
  assert.strictEqual(sb.captured.upserted[0].notes, MARKER);
});

test('an empty calendar is published once enough runs agree (no deadlock)', () => {
  // Regression: the first cut refused empty calendars forever, because state was
  // only persisted for units that had already been written. A brand-new listing
  // with no bookings could therefore never get a feed at all.
  const cur = { ok: true, blocked: 0, available: 396 };
  let prev = null;
  for (let run = 1; run < EMPTY_CONFIRM_RUNS; run++) {
    const d = shouldWrite(prev, cur);
    assert.strictEqual(d.write, false, `run ${run} should still refuse`);
    assert.strictEqual(d.emptyStreak, run, 'streak must accumulate across runs');
    prev = { emptyStreak: d.emptyStreak, collapseStreak: d.collapseStreak };
  }
  const final = shouldWrite(prev, cur);
  assert.strictEqual(final.write, true);
  assert.strictEqual(final.reason, 'empty-confirmed');
});

test('a broken scrape resets the empty streak', () => {
  const d = shouldWrite({ emptyStreak: 2, collapseStreak: 0 }, { ok: false, blocked: 0, available: 0 });
  assert.strictEqual(d.emptyStreak, 0, 'a failure must not confirm an empty calendar');
});

test('an already-published unit that empties uses the collapse gate, not the empty gate', () => {
  const prev = { availableCount: 100, blockedRanges: 3, collapseStreak: 0, emptyStreak: 0 };
  const d = shouldWrite(prev, { ok: true, blocked: 0, available: 396 });
  // available went UP, so no collapse — this is a normal write.
  assert.strictEqual(d.write, true);
  assert.strictEqual(d.reason, 'ok');
});
