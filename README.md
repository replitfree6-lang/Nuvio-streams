# Dulo — Nuvio plugin

A Nuvio scraper plugin for [dulo.mov](https://dulo.mov): movies, TV
shows and anime.

**Manifest URL** (add this in Nuvio):
`https://raw.githubusercontent.com/replitfree6-lang/Nuvio-streams/main/manifest.json`

## How it works

Dulo keys everything by TMDB id — the same ids Nuvio hands a
scraper — so there is no site search or title matching to go wrong.
The scraper calls the site's own first-party streams endpoint, the
same one its web player uses:

`GET https://dulo.mov/api/streams/resolve?tmdbId=<id>&type=movie|tv&progressive=true`
(plus `seasonId`/`episodeId` for series, and title/year/runtime when
known from TMDB)

The response lists the available sources, e.g. Prime (1080p), Zenith,
Chandra, Breeze and Pickle (4K), each with a stream URL and any
caption tracks, which are attached as subtitles. The endpoint
long-polls while a title's sources are still resolving, so the
scraper polls and merges sources by label (bounded at ~15s) exactly
like the site's client does.

Two source kinds:

- **Proxy sources** (Prime, Zenith, Chandra, Breeze, ...): HLS
  playlists served through the site's stream proxy. The master
  playlist and every segment are proxy URLs, so any HLS player can
  follow them. These are emitted first.
- **Pickle (4K)**: the site's own CDN playlist. For the titles probed
  during development it served a short promo clip rather than the
  feature, so it is emitted last (still selectable, honestly
  labelled).

The site's web player routes its API calls through a proxy transport
with a token chain; that transport is not needed here — the endpoint
answers plain requests directly, which is what the scraper uses.

## Platform notes

- String season/episode arguments from the app are coerced to numbers.
- The code avoids JavaScript features the LG webOS build of the app
  lacks (no optional chaining, no `matchAll`) and guards every
  `setTimeout` use (that runtime has none).

## Testing

Live from the build server: the resolve endpoint returns real
sources for real titles (The Matrix: Prime 1080p, Zenith, Pickle 4K;
Breaking Bad S1E1: Prime 1080p, Zenith, Pickle 4K), and the Prime and
Zenith master playlists fetched from here are genuine HLS playlists.
The source pool rotates slightly between requests (Chandra/Breeze
appear intermittently), which the scraper handles by emitting
whatever the API returns. The final confirmation is the in-app test,
as always.

## Files

- `manifest.json` — the plugin repository manifest.
- `providers/dulo.js` — the scraper (single file, no dependencies).
