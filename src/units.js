const fs = require('fs');
const path = require('path');

// data/paths.json maps a BirdNest numeric id -> its full compound-scoped URL,
// harvested from birdnestlife.com's location listing pages. It exists because
// ~34 of our rows store the SHORT url form (/property/5956), which serves the
// generic marketing shell with no availability payload at all. Without a full
// path those units silently scrape as "nothing blocked".
function loadPaths() {
  const p = path.join(__dirname, '..', 'data', 'paths.json');
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    // A corrupt map must not silently degrade every short-url unit into a
    // wide-open feed. Fail loudly instead.
    throw new Error(`data/paths.json is unreadable (${e.message}) — fix or delete it before running.`);
  }
}

const bnId = (sourceUrl) => {
  const m = /\/(\d+)\/?$/.exec(sourceUrl || '');
  return m ? m[1] : null;
};

const isFullPath = (u) =>
  /^https:\/\/birdnestlife\.com\/property\/[^/]+\/[^/]+\/[^/]+\/\d+\/?$/.test(u || '');

// Load the BirdNest units we want feeds for.
//
// Default scope is every published/draft BirdNest unit that does NOT already
// have a first-party feed in listing_ical — we only want to bridge the gaps, not
// to shadow RentalsUnited where the operator already publishes. Pass
// { includeWired: true } to regenerate everything (useful for auditing our
// output against their feed).
async function loadBirdnestUnits(supabase, { includeWired = false, onlyWp = [] } = {}) {
  const paths = loadPaths();

  const { data: units, error } = await supabase
    .from('units')
    .select('wp_post_id, slug, title, source_url, status, compound')
    .eq('source', 'birdnest')
    .in('status', ['published', 'draft']);
  if (error) throw new Error(`Supabase units query failed: ${error.message}`);

  let wired = new Set();
  if (!includeWired) {
    const { data: ical, error: e2 } = await supabase
      .from('listing_ical')
      .select('wordpress_post_id');
    if (e2) throw new Error(`Supabase listing_ical query failed: ${e2.message}`);
    wired = new Set((ical || []).map((r) => r.wordpress_post_id));
  }

  const out = [];
  for (const u of units || []) {
    if (!includeWired && wired.has(u.wp_post_id)) continue;
    if (onlyWp.length && !onlyWp.includes(u.wp_post_id)) continue;
    // Golf-car "units" are equipment rentals, not stays — no calendar to sync.
    if (/golf\s*car/i.test(u.title || '')) continue;

    const id = bnId(u.source_url);
    const mapped = id ? paths[id] : null;
    // Prefer whichever candidate is a real compound-scoped URL; keep the other
    // as a fallback so a stale map entry can still be rescued by source_url.
    const candidates = [];
    if (isFullPath(u.source_url)) candidates.push(u.source_url);
    if (mapped && !candidates.includes(mapped)) candidates.push(mapped);
    if (!candidates.length && u.source_url) candidates.push(u.source_url);

    out.push({
      wp: u.wp_post_id,
      bnId: id,
      slug: u.slug,
      title: u.title,
      status: u.status,
      compound: u.compound,
      url: candidates[0] || null,
      altUrls: candidates.slice(1),
      resolvable: candidates.some(isFullPath),
    });
  }
  return out;
}

module.exports = { loadBirdnestUnits, loadPaths, bnId, isFullPath };
