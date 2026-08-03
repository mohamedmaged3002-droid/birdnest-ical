# birdnest-ical

Publishes per-unit iCal feeds for BlueKeys' **BirdNest** inventory by reading availability
straight off `birdnestlife.com`, for the units where BirdNest has not given us a first-party
(RentalsUnited / Airbnb) feed.

```
birdnestlife.com property page  ->  sync.js  ->  docs/<wp_post_id>.ics  ->  GitHub Pages
                                                                              |
                                                                        wire.js -> Supabase listing_ical
```

Runs every 6h via GitHub Actions (`.github/workflows/sync.yml`).

## Why this exists

Two problems this solves:

1. **Missing feeds.** ~66 published/draft BirdNest units have no feed at all, so their
   calendars never sync and every date reads as available.
2. **Wrong feeds.** When BirdNest does send links by hand they are sometimes another unit's
   feed. On 2026-08-03 three of seventeen supplied links were duplicates of a *different*
   unit's calendar — verified by comparing each feed's `X-WR-CALNAME` against the live
   listing title. Scraping the unit's own page cannot make that mistake.

## How it works

BirdNest server-renders each property page with the calendar already embedded in the RSC
payload:

```
self.__next_f.push([1,"2b:{\"checkInBlockedDates\":[{\"from\":1790852400000,\"to\":1830074400000}],...
```

So one plain `GET` per unit yields the whole calendar — no Playwright, no date-picker
driving, no per-night probing. That makes this bridge far cheaper and less flaky than
`brassbell-ical`, which has to probe a booking form night by night.

### Date semantics (verified, do not guess)

`checkInBlockedDates` `{from, to}` is **inclusive on both ends** and lists the dates you
cannot *check in* on. The equivalent iCal event is `DTSTART = from`, `DTEND = to + 1 day`
(`DTEND` exclusive).

Confirmed 2026-08-03 against unit **5081**, which has both a live page and a first-party
RentalsUnited feed — all four in-horizon ranges matched byte for byte:

| ours (scraped)          | BirdNest RU feed        |
| ----------------------- | ----------------------- |
| `20260803 -> 20260817`  | `20260803 -> 20260817`  |
| `20260818 -> 20260824`  | `20260818 -> 20260824`  |
| `20260825 -> 20260831`  | `20260825 -> 20260831`  |
| `20260901 -> 20260907`  | `20260901 -> 20260907`  |

`checkOutBlockedDates` is the same list shifted one day; it carries no extra information
and is ignored.

Epochs are stamped at **midnight Africa/Cairo**, so they must be read in that zone —
parsing `1790852400000` as UTC yields 2026-09-30 instead of 2026-10-01 and shifts every
block a day early.

## Safety model

Our feed emits **only BLOCKED events**, so anything we fail to publish reads as *available*
downstream. Suppressing a write therefore fails **open**, toward double-booking. Every gate
is designed around that asymmetry:

- **Never clobber a first-party feed.** `wire.js` only writes a `listing_ical` row when none
  exists or when the existing row is one we wrote (`[birdnest-ical auto]` in `notes`).
  Operator feeds come from their PMS and outrank a scrape.
- **Failed scrape keeps the last-good `.ics`.** A missing `checkInBlockedDates` is treated as
  "wrong URL", never as "nothing is blocked" — the short URL form (`/property/5956`) serves a
  generic shell with no payload, and trusting it would publish a wide-open calendar.
- **Empty-on-first-sight is refused.** No blocks *and* no prior observation is
  indistinguishable from a payload-shape change.
- **Availability collapse needs 3 agreeing runs** (~18h) before it is believed, then
  self-heals — the same deadlock that served a 39-day-stale feed in `brassbell-ical` (L-074).
- **Corrupt `docs/index.json` aborts the run** rather than silently disabling the guards.
- **Zero feeds written = non-zero exit**, so CI goes red on an infrastructure failure.

## Usage

```bash
cp .env.example .env        # add SUPABASE_SERVICE_ROLE_KEY
npm install
npm test                    # 16 tests: date semantics, guards, wire safety
npm run sync                # all units without a first-party feed
node sync.js 5956 5957      # just these wp_post_ids
INCLUDE_WIRED=1 node sync.js 5081   # audit mode: regenerate a unit that has an operator feed
npm run wire                # attach published feeds to Supabase listing_ical
```

### Outputs

| path                | contents                                             |
| ------------------- | ---------------------------------------------------- |
| `docs/<wp>.ics`     | one feed per unit                                    |
| `docs/index.json`   | per-unit state: ranges, availability, collapse streak |
| `docs/links.csv`    | `wp_post_id, bn_id, title, ical_url`                  |
| `docs/report.json`  | last run: written / skipped with reasons              |

Feed URL: `https://mohamedmaged3002-droid.github.io/birdnest-ical/<wp_post_id>.ics`

## `data/paths.json`

Maps BirdNest numeric id → full compound-scoped URL, harvested from the location listing
pages. Needed because ~34 of our rows store the short URL form, which has no availability
payload. Regenerate by crawling `birdnestlife.com/listing?a=<amenityId>` and collecting
`/property/.../<id>` links.

## Related

- `brassbell-ical/` — same pattern for Brassbell (probes a booking form; heavier)
- `soul-ical/` — Soul's colour-coded sheet → per-code feeds
- Supabase `listing_ical` keys the WP id as **`wordpress_post_id`**, not `wp_post_id`
