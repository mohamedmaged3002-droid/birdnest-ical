require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getSupabase } = require('./src/supabase');
const { wireUnits } = require('./src/wire');
const cfg = require('./src/config');

async function main() {
  const indexPath = path.join(__dirname, 'docs', 'index.json');
  if (!fs.existsSync(indexPath)) {
    throw new Error('docs/index.json not found — run `npm run sync` first.');
  }
  const { properties } = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

  // Only wire units that actually have a committed .ics on disk. An index entry
  // without a file would publish a 404 URL, and a 404 feed reads as fully
  // available downstream — i.e. it fails OPEN into double-bookings.
  const entries = properties
    .filter((p) => fs.existsSync(path.join(__dirname, 'docs', `${p.wp}.ics`)))
    .map((p) => ({ wp: p.wp, slug: p.slug, ical_url: `${cfg.PAGES_BASE_URL}/${p.wp}.ics` }));

  const sb = getSupabase();
  const { upserted, skipped } = await wireUnits(sb, entries);
  console.log(`Wired ${upserted} listing_ical rows (of ${properties.length} indexed).`);
  if (skipped.length) {
    console.log(`Left ${skipped.length} first-party feed(s) untouched:`);
    for (const s of skipped) console.log(`  [${s.wp}] ${s.ical_url}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
