const test = require('node:test');
const assert = require('node:assert');
const { loadBirdnestUnits } = require('../src/units');
const { MARKER } = require('../src/wire');

// Minimal Supabase stub: .from(t).select(...).eq(...).in(...) resolving to rows.
function fakeSb({ units, ical }) {
  return {
    from(table) {
      const rows = table === 'units' ? units : ical;
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: async () => ({ data: rows, error: null }),
        then: undefined,
      };
      // listing_ical is queried as .select(...) with no .eq/.in, so make the
      // select() result awaitable too.
      if (table !== 'units') {
        return {
          select: async () => ({ data: rows, error: null }),
        };
      }
      return chain;
    },
  };
}

const UNITS = [
  { wp_post_id: 1, slug: 'a', title: 'A', status: 'draft', compound: 'X', source_url: 'https://birdnestlife.com/property/S/C/P/1' },
  { wp_post_id: 2, slug: 'b', title: 'B', status: 'draft', compound: 'X', source_url: 'https://birdnestlife.com/property/S/C/P/2' },
  { wp_post_id: 3, slug: 'c', title: 'C', status: 'draft', compound: 'X', source_url: 'https://birdnestlife.com/property/S/C/P/3' },
];

test('units already carrying OUR feed stay in scope so they keep refreshing', async () => {
  // Regression: the first cut excluded every unit with any listing_ical row, so
  // a unit dropped out of the sync the moment wire.js attached its feed and the
  // published .ics froze forever.
  const sb = fakeSb({
    units: UNITS,
    ical: [{ wordpress_post_id: 1, notes: MARKER }],
  });
  const out = await loadBirdnestUnits(sb);
  assert.ok(out.some((u) => u.wp === 1), 'our own feed must NOT remove a unit from scope');
  assert.strictEqual(out.length, 3);
});

test('units with a first-party operator feed are excluded', async () => {
  const sb = fakeSb({
    units: UNITS,
    ical: [{ wordpress_post_id: 2, notes: null }], // RentalsUnited row, not ours
  });
  const out = await loadBirdnestUnits(sb);
  assert.ok(!out.some((u) => u.wp === 2), 'operator feeds are authoritative — do not shadow them');
  assert.deepStrictEqual(out.map((u) => u.wp).sort(), [1, 3]);
});

test('includeWired brings operator-fed units back for auditing', async () => {
  const sb = fakeSb({ units: UNITS, ical: [{ wordpress_post_id: 2, notes: null }] });
  const out = await loadBirdnestUnits(sb, { includeWired: true });
  assert.strictEqual(out.length, 3);
});

test('golf-car equipment rows are never given a calendar', async () => {
  const sb = fakeSb({
    units: [...UNITS, { wp_post_id: 9, slug: 'g', title: '4 Seaters Golf Car Marassi', status: 'draft', compound: 'X', source_url: 'https://birdnestlife.com/property/S/C/P/9' }],
    ical: [],
  });
  const out = await loadBirdnestUnits(sb);
  assert.ok(!out.some((u) => u.wp === 9));
});
