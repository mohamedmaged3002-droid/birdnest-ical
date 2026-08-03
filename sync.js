require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getSupabase } = require('./src/supabase');
const { loadBirdnestUnits } = require('./src/units');
const { scrapeUnit } = require('./src/scrape');
const { collapseBlocked, addDays } = require('./src/dates');
const { buildIcal } = require('./src/ical');
const { shouldWrite } = require('./src/guard');
const cfg = require('./src/config');

const OUT = path.join(__dirname, 'docs');

function horizonNights(startDate, months) {
  const end = new Date(startDate);
  end.setMonth(end.getMonth() + months);
  return Math.round((end - startDate) / 86400000);
}

function loadPrevIndex() {
  const p = path.join(OUT, 'index.json');
  if (!fs.existsSync(p)) return { props: {}, pending: {} }; // legit first run
  let j;
  try {
    j = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    // Fail CLOSED. Running with an empty prev would silently disable the
    // availability-collapse guard AND drop the index carry-forward for skipped
    // units, so a single corrupt file could republish wide-open calendars.
    throw new Error(
      `docs/index.json exists but could not be parsed (${e.message}). ` +
        'Aborting to preserve last-good feeds — fix or delete it before re-running.',
    );
  }
  const props = {};
  for (const e of j.properties || []) props[e.wp] = e;
  // `pending` holds streak state for units we have NEVER successfully written.
  // It is deliberately kept out of `properties` (and therefore out of
  // links.csv) so a unit with no .ics on Pages can never be wired into
  // listing_ical — a 404 feed reads as fully available downstream.
  const pending = {};
  for (const e of j.pending || []) pending[e.wp] = e;
  return { props, pending };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const onlyWp = process.argv.slice(2).map(Number).filter(Boolean);
  const startDate = new Date();
  startDate.setHours(12, 0, 0, 0);
  const nights = horizonNights(startDate, cfg.HORIZON_MONTHS);

  const supabase = getSupabase();
  const units = await loadBirdnestUnits(supabase, {
    includeWired: process.env.INCLUDE_WIRED === '1',
    onlyWp,
  });
  console.log(
    `Scraping ${units.length} BirdNest units, horizon=${nights} nights, concurrency=${cfg.UNIT_CONCURRENCY}`,
  );

  const unresolvable = units.filter((u) => !u.resolvable);
  if (unresolvable.length) {
    // Loud, not fatal: these will almost certainly fail the no-blocked-field
    // check and be skipped, but naming them makes the gap actionable instead of
    // invisible.
    console.warn(
      `WARNING: ${unresolvable.length} unit(s) have no compound-scoped URL and will likely be skipped: ` +
        unresolvable.map((u) => u.wp).join(', '),
    );
  }

  const { props: prev, pending: prevPending } = loadPrevIndex();
  // Seed with all prior entries so a filtered run preserves untouched units.
  const indexMap = { ...prev };
  const pendingMap = { ...prevPending };
  const report = {
    startedAt: new Date().toISOString(),
    nights,
    written: 0,
    skipped: [],
    units: [],
  };

  let idx = 0;
  async function worker() {
    while (idx < units.length) {
      const unit = units[idx++];
      const res = await scrapeUnit(unit, { startDate, nights });
      const counts = { ok: res.ok, blocked: res.blocked.length, available: res.availableCount };
      const decision = shouldWrite(prev[unit.wp] || prevPending[unit.wp] || null, counts);
      report.units.push({ wp: unit.wp, ...counts, reason: res.reason, decision: decision.reason });

      if (decision.write) {
        const ranges = collapseBlocked(res.blocked);
        const ics = buildIcal({ wp: unit.wp, title: unit.title, ranges });
        fs.writeFileSync(path.join(OUT, `${unit.wp}.ics`), ics, 'utf8');
        report.written++;
        indexMap[unit.wp] = {
          wp: unit.wp,
          bnId: unit.bnId,
          slug: unit.slug,
          title: unit.title,
          url: res.url,
          blockedRanges: ranges.length,
          availableCount: counts.available,
          // lastWrittenAt is the only trustworthy per-feed age signal: GitHub
          // Pages re-stamps Last-Modified on every deploy, and index.json's own
          // updatedAt is global, not per-unit.
          lastWrittenAt: new Date().toISOString(),
          collapseStreak: 0,
          emptyStreak: 0,
        };
        delete pendingMap[unit.wp]; // graduated from pending to published
        console.log(
          `  [${unit.wp}] WROTE (${decision.reason}) blocked=${counts.blocked} available=${counts.available} ranges=${ranges.length}`,
        );
      } else {
        // Keep the last-good .ics and its index entry, but carry the collapse
        // streak forward. Only ever UPDATE an existing entry, never create one:
        // a unit whose first scrape fails has no .ics on Pages, and inventing an
        // index entry would put a 404 URL into links.csv and let wire.js attach
        // it to listing_ical — where a 404 feed reads as fully available.
        const priorEntry = prev[unit.wp];
        if (priorEntry) {
          indexMap[unit.wp] = {
            ...priorEntry,
            collapseStreak: decision.collapseStreak,
            emptyStreak: decision.emptyStreak,
          };
        } else {
          // Never written. Park the streaks in `pending` so gates that need
          // repeated agreement (empty-confirmed, availability-collapse) can
          // actually reach their threshold instead of deadlocking at 1/3.
          pendingMap[unit.wp] = {
            wp: unit.wp,
            bnId: unit.bnId,
            title: unit.title,
            lastReason: `${decision.reason}/${res.reason}`,
            lastSeenAt: new Date().toISOString(),
            collapseStreak: decision.collapseStreak,
            emptyStreak: decision.emptyStreak,
          };
        }
        report.skipped.push({
          wp: unit.wp,
          reason: decision.reason,
          scrape: res.reason,
          collapseStreak: decision.collapseStreak,
          ...counts,
        });
        console.log(
          `  [${unit.wp}] SKIP (${decision.reason}/${res.reason}${decision.collapseStreak ? ` ${decision.collapseStreak}/3` : ''})`,
        );
      }
    }
  }
  await Promise.all(Array.from({ length: cfg.UNIT_CONCURRENCY }, () => worker()));

  const properties = Object.values(indexMap).sort((a, b) => a.wp - b.wp);
  const pending = Object.values(pendingMap).sort((a, b) => a.wp - b.wp);
  fs.writeFileSync(
    path.join(OUT, 'index.json'),
    JSON.stringify(
      { updatedAt: new Date().toISOString(), count: properties.length, properties, pending },
      null,
      2,
    ),
    'utf8',
  );
  // links.csv lists only units with a real .ics on disk. An entry whose file is
  // missing would advertise a URL that 404s, and a 404 feed reads as fully
  // available — i.e. it fails open into double-bookings.
  const linkable = properties.filter((p) => fs.existsSync(path.join(OUT, `${p.wp}.ics`)));
  fs.writeFileSync(
    path.join(OUT, 'links.csv'),
    ['wp_post_id,bn_id,title,ical_url']
      .concat(
        linkable.map(
          (p) => `${p.wp},${p.bnId || ''},"${String(p.title || '').replace(/"/g, '""')}",${cfg.PAGES_BASE_URL}/${p.wp}.ics`,
        ),
      )
      .join('\n') + '\n',
    'utf8',
  );
  // Pages needs this or Jekyll strips files and directories it doesn't like.
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '', 'utf8');

  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(
    `\nDone. wrote=${report.written} skipped=${report.skipped.length} indexed=${properties.length}`,
  );

  // Non-zero exit if literally nothing succeeded — that is an infrastructure
  // failure (site down, payload shape changed) and CI should go red, not green.
  if (report.written === 0 && units.length > 0) {
    console.error('ERROR: zero feeds written this run.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
