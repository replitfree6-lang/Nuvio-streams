/* Toonix (toonix.bond) Nuvio provider — v1.0.1
 *
 * TV only. Two servers:
 *   SORA (default): the site's own first-party stream API.
 *   Legacy: direct archive.org MP4s (no token/proxy). The URL is baked into
 *     the server-rendered watch page (no XHR provides it at play time), so
 *     the plugin extracts it from the watch-page HTML it already fetches.
 *
 * Verified site mechanics (from real DevTools captures on the site):
 *   - Watch page: https://toonix.bond/show/<slug>/<season>/<episode>
 *   - Stream API: GET /api/hydrax/<episodeId>?t=<ms>.<token>
 *     -> { qualities: [{label: "480p"|"360p", src: "<signed mp4 url>"}],
 *          default: "480p", hosts: [...] }
 *   - The t token is SERVER-VALIDATED (forged tokens -> {"error":"expired"});
 *     it cannot be minted by the plugin. It is embedded in the server-rendered
 *     watch page (the site calls hydrax ~2s after page load with no other
 *     preceding API call), so the plugin extracts the verbatim t value from
 *     the watch-page HTML and reuses it. Signed media URLs expire (~6h), so
 *     everything is fetched fresh per resolve, never hardcoded.
 *
 * Flow per getStreams:
 *   1. TMDB -> show title -> site slug
 *   2. GET watch-page HTML -> extract episodeId + full t value
 *   3. GET /api/hydrax/<episodeId>?t=<t> -> qualities[] -> streams
 *
 * webOS-safe: no optional chaining, no matchAll, no RegExp.$1, guarded
 * setTimeout (spin-wait fallback), season/episode coerced to numbers.
 */

var TOONIX_SITE = "https://toonix.bond";
var TOONIX_UA =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36";
var TOONIX_TMDB_KEY = "1865f43a0549ca50d341dd9ab8b29f49";
var TOONIX_TIMEOUT_MS = 12000;

function toonixSleep(ms) {
  try {
    if (typeof setTimeout === "function") {
      return new Promise(function (resolve) {
        setTimeout(resolve, ms);
      });
    }
  } catch (e) {}
  var end = Date.now() + ms;
  while (Date.now() < end) {}
  return Promise.resolve();
}

function toonixFetch(url, headers, timeoutMs) {
  var controller = null;
  var timer = null;
  var settled = false;
  function clearTimer() {
    if (timer !== null) {
      try {
        clearTimeout(timer);
      } catch (e) {}
      timer = null;
    }
  }
  var p = new Promise(function (resolve, reject) {
    try {
      if (typeof AbortController === "function") {
        controller = new AbortController();
        try {
          if (typeof setTimeout === "function") {
            timer = setTimeout(function () {
              if (!settled) {
                settled = true;
                try {
                  controller.abort();
                } catch (e) {}
                reject(new Error("timeout"));
              }
            }, timeoutMs);
          }
        } catch (e) {}
      }
      var opts = { headers: headers || {} };
      if (controller) opts.signal = controller.signal;
      fetch(url, opts).then(
        function (resp) {
          if (!settled) {
            settled = true;
            clearTimer();
            resolve(resp);
          }
        },
        function (err) {
          if (!settled) {
            settled = true;
            clearTimer();
            reject(err);
          }
        }
      );
    } catch (e) {
      if (!settled) {
        settled = true;
        clearTimer();
        reject(e);
      }
    }
  });
  return p;
}

function toonixGetText(url, referer) {
  var headers = {
    "User-Agent": TOONIX_UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
  };
  if (referer) headers["Referer"] = referer;
  return toonixFetch(url, headers, TOONIX_TIMEOUT_MS).then(function (resp) {
    if (!resp || resp.status !== 200) throw new Error("http " + (resp && resp.status));
    return resp.text();
  });
}

function toonixGetJson(url, referer) {
  var headers = {
    "User-Agent": TOONIX_UA,
    Accept: "application/json,*/*",
    "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
  };
  if (referer) headers["Referer"] = referer;
  return toonixFetch(url, headers, TOONIX_TIMEOUT_MS).then(function (resp) {
    if (!resp || resp.status !== 200) throw new Error("http " + (resp && resp.status));
    return resp.json();
  });
}

function toonixSlugify(name) {
  var s = String(name || "").toLowerCase();
  s = s.replace(/[''`]/g, "");
  s = s.replace(/[^a-z0-9]+/g, "-");
  s = s.replace(/^-+/, "").replace(/-+$/, "");
  return s;
}

/* Extract the internal episodeId from the watch-page HTML. The page calls
 * /api/hydrax/<id> on load, so the id is in the server-rendered markup. */
function toonixExtractEpisodeId(html) {
  if (!html) return null;
  var patterns = [/\/api\/hydrax\/(\d{4,10})/, /hydrax\/(\d{4,10})/, /["']episode[Ii]d["']\s*[:=]\s*["']?(\d{4,10})/];
  for (var i = 0; i < patterns.length; i++) {
    var m = html.match(patterns[i]);
    if (m && m[1]) return m[1];
  }
  return null;
}

/* Extract the full server-issued t value (<ms>.<token>) from the watch-page
 * HTML. The token is validated server-side and cannot be forged, so the
 * plugin must reuse the verbatim value embedded in the page. The shape
 * (13-digit ms + "." + 43 base64url chars, seen live as
 * 1793801375275.yr3BI19cDEihABVOnQy4S0LymuADuk2tHdZHT3aiqlQ) is distinctive
 * enough to find without knowing the field name. */
function toonixExtractT(html) {
  if (!html) return null;
  var patterns = [
    /[?&]t=(\d{10,20}\.[A-Za-z0-9\-_]{40,50})/,
    /["']t["']\s*:\s*["'](\d{10,20}\.[A-Za-z0-9\-_]{40,50})["']/,
    /(\d{13}\.[A-Za-z0-9\-_]{43})/,
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = html.match(patterns[i]);
    if (m && m[1]) return m[1];
  }
  /* ms + token as separate adjacent fields, e.g. "ms":1793...,"token":"yr3B..." */
  var mp = html.match(/["']ms["']\s*:\s*(\d{13})\s*,\s*["']token["']\s*:\s*["']([A-Za-z0-9\-_]{43})["']/);
  if (mp && mp[1] && mp[2]) return mp[1] + "." + mp[2];
  return null;
}

/* Extract Legacy-server direct media URLs from the watch-page HTML.
 * Legacy serves plain public archive.org MP4s (verified: the file bytes
 * match a DevTools Media capture exactly). No XHR provides the URL at play
 * time, so it must be embedded in the server-rendered page. Prefer the
 * stable https://archive.org/download/<item>/<path> form; fall back to
 * datanode (dn*.archive.org) URLs only if no /download/ URL is present. */
function toonixExtractLegacyUrls(html) {
  if (!html) return [];
  var found = [];
  var seen = {};
  function collect(re) {
    var m;
    while ((m = re.exec(html)) !== null) {
      var u = String(m[0]).replace(/[.,;!?)\]]+$/, "");
      if (u && !seen[u]) {
        seen[u] = true;
        found.push(u);
      }
    }
  }
  collect(/https:\/\/archive\.org\/download\/[^\s"'<>\\]+/g);
  if (found.length === 0) {
    collect(/https:\/\/[a-z0-9.-]+\.archive\.org\/[^\s"'<>\\]+/g);
  }
  return found;
}

function toonixTmdbTitle(tmdbId) {
  var base =
    "https://api.themoviedb.org/3/tv/" +
    encodeURIComponent(String(tmdbId)) +
    "?api_key=" +
    TOONIX_TMDB_KEY +
    "&language=en-US";
  /* The site's slugs don't always match TMDB's primary title
   * (e.g. TMDB "Crayon Shin-chan" vs site slug "shin-chan"), so also pull
   * alternative titles and try every slug variant. */
  var altUrl =
    "https://api.themoviedb.org/3/tv/" +
    encodeURIComponent(String(tmdbId)) +
    "/alternative_titles?api_key=" +
    TOONIX_TMDB_KEY;
  return toonixGetJson(base, null).then(function (data) {
    if (!data) throw new Error("tmdb empty");
    var titles = [];
    if (data.name) titles.push(data.name);
    if (data.original_name) titles.push(data.original_name);
    return toonixGetJson(altUrl, null).then(
      function (alt) {
        if (alt && alt.results) {
          for (var i = 0; i < alt.results.length; i++) {
            if (alt.results[i] && alt.results[i].title) titles.push(alt.results[i].title);
          }
        }
        return { titles: titles, name: data.name || data.original_name || "" };
      },
      function () {
        return { titles: titles, name: data.name || data.original_name || "" };
      }
    );
  });
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    if (mediaType !== "tv") return [];
    season = Number(season);
    episode = Number(episode);
    if (!tmdbId || !season || !episode) return [];

    var info = await toonixTmdbTitle(tmdbId);
    var candidates = [];
    var seen = {};
    var titles = info.titles || [];
    for (var ti = 0; ti < titles.length; ti++) {
      var sl = toonixSlugify(titles[ti]);
      if (sl && !seen[sl]) {
        seen[sl] = true;
        candidates.push(sl);
      }
    }
    if (candidates.length === 0) return [];

    var episodeId = null;
    var tVal = null;
    var watchUrl = null;
    var pageHtml = null;
    for (var i = 0; i < candidates.length && (!episodeId || !tVal); i++) {
      watchUrl = TOONIX_SITE + "/show/" + candidates[i] + "/" + season + "/" + episode;
      var html = null;
      try {
        html = await toonixGetText(watchUrl, TOONIX_SITE + "/");
      } catch (e) {
        html = null;
      }
      if (html) {
        pageHtml = html;
        if (!episodeId) episodeId = toonixExtractEpisodeId(html);
        if (!tVal) tVal = toonixExtractT(html);
      }
    }
    if (!watchUrl || !pageHtml) return [];

    var streams = [];
    var showLabel = info.name || ("TMDB " + tmdbId);

    /* SORA server via the hydrax API. Independent try/catch: if this path
     * fails, the Legacy extraction below still gets its chance. */
    if (episodeId && tVal) {
      try {
        var apiUrl = TOONIX_SITE + "/api/hydrax/" + episodeId + "?t=" + encodeURIComponent(tVal);
        var data = await toonixGetJson(apiUrl, watchUrl);
        if (data && !data.error && data.qualities && data.qualities.length) {
          for (var q = 0; q < data.qualities.length; q++) {
            var item = data.qualities[q];
            if (!item || !item.src) continue;
            var label = item.label || "Auto";
            streams.push({
              name: "Toonix",
              title: showLabel + " S" + season + " E" + episode + " - " + label,
              url: item.src,
              quality: label,
              type: "mp4",
              headers: {
                Referer: TOONIX_SITE + "/",
                "User-Agent": TOONIX_UA,
              },
            });
          }
        }
      } catch (e) {}
    }

    /* Legacy server: direct archive.org MP4s from the watch-page HTML. */
    var legacyUrls = toonixExtractLegacyUrls(pageHtml);
    for (var l = 0; l < legacyUrls.length; l++) {
      streams.push({
        name: "Toonix Legacy",
        title: showLabel + " S" + season + " E" + episode + " - Legacy",
        url: legacyUrls[l],
        quality: "Auto",
        type: "mp4",
        headers: {
          Referer: TOONIX_SITE + "/",
          "User-Agent": TOONIX_UA,
        },
      });
    }
    return streams;
  } catch (e) {
    return [];
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams: getStreams };
}
try {
  if (typeof global !== "undefined") global.getStreams = getStreams;
} catch (e) {}
