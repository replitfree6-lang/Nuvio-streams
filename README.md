# MeowTV — Nuvio plugin

A Nuvio scraper plugin for [meowtv.ru](https://meowtv.ru): movies, TV
shows and anime.

**Manifest URL** (add this in Nuvio):
`https://raw.githubusercontent.com/replitfree6-lang/Nuvio-streams/main/manifest.json`

## How it works

MeowTV keys everything by TMDB id — the same ids Nuvio hands a
scraper — so there is no site search or title matching to go wrong.
The scraper mirrors the site's own web client (`api.meowtv.ru`):

1. `POST /streams/ticket` mints a short-lived stream ticket. The ticket
   is bound to the caller's User-Agent (the site's client retries once
   on ticket / signature / UA-mismatch errors, and so does this
   scraper), so one fixed desktop User-Agent is used for the ticket,
   the stream calls and the emitted stream headers.
2. `GET /streams/movie/<tmdbId>?s=acme&list=1` (or
   `/streams/tv/<tmdbId>/<season>/<episode>?s=acme&list=1`) returns the
   Acme source's stream list. The site's other sources — Dcloud, TCloud,
   IPcloud, English, Hindi and (for movies) Türkçe — are then queried
   the same way, one call each, in the site's own list order.
3. `GET /subs/movie/<tmdbId>` / `/subs/tv/<tmdbId>/<s>/<e>` returns the
   subtitle catalogue (no ticket needed); the tracks are attached to
   every emitted stream.

Every stream carries the headers the API specifies for it, plus the
ticket User-Agent and the site as Referer.

Not used, deliberately:

- **FebBox** — the site's extra source requires the viewer's *own*
  FebBox account token (its API answers "Febbox token not set" without
  one), and a scraper has no way to ask the viewer for it.
- **The VidSrc iframe embed** the website displays in browsers — an
  embed page is not a playable stream URL, so it cannot be returned to
  Nuvio as a stream.

## Platform notes

- String season/episode arguments from the app are coerced to numbers.
- The code avoids JavaScript features the LG webOS build of the app
  lacks (no optional chaining, no `matchAll`) and guards every
  `setTimeout` use (that runtime has none).

## Testing

Live from the build server: the site and its API answer normally (no
bot wall), the anonymous subtitle endpoint returns real tracks for
real titles, and the response parsers are verified against the API's
documented shapes. One link cannot be exercised from the build server:
its network stalls all POSTs to the API host (including unrelated
account endpoints), so the ticket mint — and with it the final stream
list — is verified by the in-app test on a normal connection.

## Files

- `manifest.json` — the plugin repository manifest.
- `providers/meowtv.js` — the scraper (single file, no dependencies).
