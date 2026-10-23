# NEPU — Nuvio plugin

A Nuvio scraper plugin for [nepu.io](https://nepu.io) ("NEPU Stream"):
movies, TV shows, cartoons and anime in HD.

**Manifest URL** (add this in Nuvio):
`https://raw.githubusercontent.com/replitfree6-lang/Nuvio-streams/main/manifest.json`

## How it works

Nuvio hands the scraper a TMDB id, media type and (for series) season /
episode numbers. The scraper then follows the same steps as the site's
own pages:

1. TMDB id → title + year (primary, original and alternative titles).
2. `GET https://nepu.io/search/<title>` → result cards are parsed and
   matched exactly on normalised title, year and type — a TV request only
   ever resolves to a series entry and a movie request only to a movie
   entry (the lesson from the AnimeDekho plugin: never fall back to a
   same-name different-type result). The site's [SUB] / [DUB] / [4K]
   editions are separate catalogue entries; all matching editions are
   used and their streams are labelled with the edition.
3. A movie result page is itself the watch page. For a series, the show
   page's canonical URL plus `/season/<s>/episode/<e>` is the watch page.
4. Each source button on the watch page carries a `data-embed` id. The
   site's own player loader (`detail.js`) fetches the player with
   `POST https://nepu.io/ajax/embed` (`id=<embed id>`); the scraper does
   the same and reads the returned player HTML: `<source src>` elements,
   PlayerJS `"file": "…"` configs and bare `.m3u8` / `.mp4` / `.txt`
   URLs become streams, and `<track>` elements become subtitles. If a
   source answers with a nested player page instead, it is scanned one
   level deep.
5. Every emitted stream carries the watch page as Referer and the same
   desktop User-Agent the scraper itself used (some hosts bind playback
   to the fetching identity).

Series season/episode numbers are taken as given (the site uses the
usual convention: season 0 = specials). String season/episode arguments
from the app are coerced to numbers.

## Platform notes

- The scraper avoids JavaScript features the LG webOS build of the app
  lacks (no optional chaining, no `matchAll`, etc.), guards every
  `setTimeout` use (that runtime has none), and reads `Set-Cookie`
  through `getSetCookie()` / `headers.get()` / a full header scan,
  because the TV fetch layer hides it from the first two.
- **Cloudflare:** nepu.io sits behind Cloudflare's managed challenge.
  Whether a given network is challenged is Cloudflare's per-IP decision:
  datacenter IPs get the interactive "Just a moment" page (which no
  scraper can pass — it needs a real browser), while ordinary residential
  connections are typically served directly. If the plugin returns no
  streams on a network that the challenge blocks, that is the site's
  gate, not a scraper failure; the same URL in a browser on that network
  will show the challenge page.

## Testing

Validated against the site's real markup (archived snapshots of its
listing and watch pages): search-card parsing (titles/years/types),
type-safe title picking, watch-page source extraction and embed-response
media/subtitle parsing all pass. A live run from the build server is
blocked by the Cloudflare challenge described above, so the decisive
live check is the in-app test on a residential connection.

## Files

- `manifest.json` — the plugin repository manifest.
- `providers/nepu.js` — the scraper (single file, no dependencies).
