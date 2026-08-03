const test = require('node:test');
const assert = require('node:assert');
const { expandRanges, msToIso, BLOCKED_RE } = require('../src/scrape');
const { collapseBlocked } = require('../src/dates');
const { buildIcal } = require('../src/ical');

const at = (isoStr) => {
  const [y, m, d] = isoStr.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
};

test('msToIso reads BirdNest epochs in Cairo local time, not UTC', () => {
  // 1790852400000 = 2026-09-30T21:00:00Z = 2026-10-01 00:00 Africa/Cairo.
  // Reading this in UTC would yield 2026-09-30 and shift every block a day early.
  assert.strictEqual(msToIso(1790852400000), '2026-10-01');
});

test('expandRanges treats {from,to} as INCLUSIVE on both ends', () => {
  const start = at('2026-08-01');
  const out = expandRanges([{ from: Date.parse('2026-08-18T00:00:00+03:00'), to: Date.parse('2026-08-20T00:00:00+03:00') }], start, 60);
  assert.deepStrictEqual(out, ['2026-08-18', '2026-08-19', '2026-08-20']);
});

test('inclusive checkIn range -> RentalsUnited-equivalent DTEND (to + 1 day)', () => {
  // Ground truth captured 2026-08-03 from unit 5081, which publishes BOTH a live
  // page and a first-party RU feed:
  //   live checkInBlockedDates 2026-08-18..2026-08-23
  //   RU VEVENT               DTSTART 20260818, DTEND 20260824 (exclusive)
  const start = at('2026-08-01');
  const dates = expandRanges(
    [{ from: Date.parse('2026-08-18T00:00:00+03:00'), to: Date.parse('2026-08-23T00:00:00+03:00') }],
    start,
    60,
  );
  const ranges = collapseBlocked(dates);
  assert.strictEqual(ranges.length, 1);
  assert.strictEqual(ranges[0].start, '2026-08-18');
  assert.strictEqual(ranges[0].endExclusive, '2026-08-24');
});

test('overlapping ranges merge instead of double-counting', () => {
  // The live page really does emit overlapping ranges, e.g. 08-02..08-15
  // alongside 08-03..08-03 and 08-16..08-16 on unit 5081.
  const start = at('2026-08-01');
  const dates = expandRanges(
    [
      { from: Date.parse('2026-08-02T00:00:00+03:00'), to: Date.parse('2026-08-15T00:00:00+03:00') },
      { from: Date.parse('2026-08-03T00:00:00+03:00'), to: Date.parse('2026-08-03T00:00:00+03:00') },
      { from: Date.parse('2026-08-16T00:00:00+03:00'), to: Date.parse('2026-08-16T00:00:00+03:00') },
    ],
    start,
    60,
  );
  const ranges = collapseBlocked([...new Set(dates)].sort());
  assert.strictEqual(ranges.length, 1, 'contiguous + overlapping ranges collapse to one');
  assert.strictEqual(ranges[0].start, '2026-08-02');
  assert.strictEqual(ranges[0].endExclusive, '2026-08-17');
});

test('ranges are clipped to the horizon and never loop for years', () => {
  const start = at('2026-08-01');
  // BirdNest publishes closures years out (5960 is blocked to 2028-06-30).
  const out = expandRanges(
    [{ from: Date.parse('2026-06-01T00:00:00+03:00'), to: Date.parse('2028-06-30T00:00:00+03:00') }],
    start,
    30,
  );
  assert.strictEqual(out.length, 30, 'clipped to exactly the horizon');
  assert.strictEqual(out[0], '2026-08-01', 'starts at horizon start, not range start');
  assert.strictEqual(out[out.length - 1], '2026-08-30');
});

test('malformed ranges are ignored, not treated as open', () => {
  const start = at('2026-08-01');
  assert.deepStrictEqual(expandRanges([null, {}, { from: 1, to: null }], start, 30), []);
  // to < from must not spin
  const rev = expandRanges(
    [{ from: Date.parse('2026-08-20T00:00:00+03:00'), to: Date.parse('2026-08-10T00:00:00+03:00') }],
    start,
    30,
  );
  assert.deepStrictEqual(rev, []);
});

test('BLOCKED_RE matches the real escaped RSC payload shape', () => {
  const payload =
    'self.__next_f.push([1,"2b:{\\"checkInBlockedDates\\":[{\\"from\\":1790852400000,\\"to\\":1830074400000}],\\"checkOutBlockedDates\\":[]} "])';
  const m = BLOCKED_RE.exec(payload);
  assert.ok(m, 'regex should match the live payload');
  const parsed = JSON.parse(m[1].replace(/\\"/g, '"'));
  assert.strictEqual(parsed[0].from, 1790852400000);
});

test('buildIcal emits range-encoded UIDs so OTAs see changed blocks', () => {
  const ics = buildIcal({
    wp: 5958,
    title: 'Vibrant 1BR Suite',
    ranges: [{ start: '2026-08-05', endExclusive: '2026-08-08' }],
  });
  assert.match(ics, /UID:birdnest-5958-20260805-20260808@bluekeys\.co/);
  assert.match(ics, /DTSTART;VALUE=DATE:20260805/);
  assert.match(ics, /DTEND;VALUE=DATE:20260808/);
  assert.match(ics, /SUMMARY:BLOCKED/);
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
});
