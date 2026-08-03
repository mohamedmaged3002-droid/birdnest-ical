const MARKER = '[birdnest-ical auto]';

// entries: [{ wp, slug, ical_url }] -> upsert one listing_ical row per entry.
//
// CRITICAL difference from the brassbell bridge: there, every feed in the table
// is ours, so a blind upsert is safe. Here most BirdNest units already carry a
// FIRST-PARTY feed (RentalsUnited / Airbnb) that the operator maintains, and
// that feed is authoritative — it is fed by their PMS, whereas ours is scraped
// from a public page. Clobbering it with a scrape would be a downgrade.
//
// So we only ever write a row when either:
//   * no row exists for that unit, or
//   * the existing row is one we previously wrote (carries MARKER in notes).
// Anything else is left untouched and reported as skipped.
async function wireUnits(sb, entries) {
  if (!entries.length) return { upserted: 0, skipped: [] };

  const wps = entries.map((e) => e.wp);
  const { data: existing, error: readErr } = await sb
    .from('listing_ical')
    .select('wordpress_post_id, ical_url, notes')
    .in('wordpress_post_id', wps);
  if (readErr) throw new Error(`wireUnits read: ${readErr.message}`);

  const byWp = new Map((existing || []).map((r) => [r.wordpress_post_id, r]));

  const rows = [];
  const skipped = [];
  for (const e of entries) {
    const cur = byWp.get(e.wp);
    if (cur && !String(cur.notes || '').includes(MARKER)) {
      skipped.push({ wp: e.wp, reason: 'first-party-feed-present', ical_url: cur.ical_url });
      continue;
    }
    rows.push({
      wordpress_post_id: e.wp,
      listing_slug: e.slug,
      ical_url: e.ical_url,
      notes: MARKER,
      updated_at: new Date().toISOString(),
    });
  }

  if (rows.length) {
    const { error } = await sb.from('listing_ical').upsert(rows, { onConflict: 'wordpress_post_id' });
    if (error) throw new Error(`wireUnits upsert: ${error.message}`);
  }
  return { upserted: rows.length, skipped };
}

module.exports = { wireUnits, MARKER };
