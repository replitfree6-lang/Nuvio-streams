// __STREAM_LABEL_FORMATTER__ v2: one-line emoji label for every stream.
// Movie:  🎬 <Title> • 📺 <Quality> • 🔊 <Audio> • 💬 <Subs> • 🖥️ <Provider> • 🗄️ <Server>
// Series: 🎬 <Title> • 📺 <Quality> • 📂 Season <N> • 🎞️ Episode <N> • 🔊 <Audio> • 💬 <Subs> • 🖥️ <Provider> • 🗄️ <Server>
// Segments with no data are omitted, except Quality (always shown, "Unknown" fallback).
// Server = explicit server label when the provider knows one, else the stream URL's hostname.
// Pure string work, no timers, no TextEncoder, no fetch. Never throws.
function formatStreamLabel(o) {
  try {
    o = o || {};
    var parts = [];
    function str(v) { return (v === undefined || v === null) ? "" : String(v).trim(); }
    function langName(v) {
      var k = str(v).toLowerCase();
      var map = { en: "English", eng: "English", english: "English", hi: "Hindi", hin: "Hindi", hindi: "Hindi",
        es: "Spanish", spa: "Spanish", fr: "French", fre: "French", fra: "French", de: "German", ger: "German", deu: "German",
        it: "Italian", ita: "Italian", pt: "Portuguese", por: "Portuguese", ru: "Russian", rus: "Russian",
        ar: "Arabic", ara: "Arabic", bn: "Bengali", ben: "Bengali", zh: "Chinese", chi: "Chinese", zho: "Chinese",
        ja: "Japanese", jpn: "Japanese", ko: "Korean", kor: "Korean", ta: "Tamil", tam: "Tamil", te: "Telugu", tel: "Telugu",
        ml: "Malayalam", mal: "Malayalam", mr: "Marathi", mar: "Marathi", pa: "Punjabi", pan: "Punjabi",
        ur: "Urdu", urd: "Urdu", id: "Indonesian", ind: "Indonesian", ms: "Malay", msa: "Malay", vi: "Vietnamese",
        vie: "Vietnamese", th: "Thai", tha: "Thai", tl: "Filipino", fil: "Filipino", nl: "Dutch", nld: "Dutch",
        sv: "Swedish", swe: "Swedish", da: "Danish", dan: "Danish", fi: "Finnish", fin: "Finnish",
        no: "Norwegian", nor: "Norwegian", pl: "Polish", pol: "Polish", tr: "Turkish", tur: "Turkish",
        uk: "Ukrainian", ukr: "Ukrainian", cs: "Czech", ces: "Czech", cze: "Czech", el: "Greek", ell: "Greek",
        he: "Hebrew", heb: "Hebrew", ro: "Romanian", ron: "Romanian", rum: "Romanian", hu: "Hungarian", hun: "Hungarian", arabic: "Arabic", bengali: "Bengali", chinese: "Chinese", filipino: "Filipino", indonesian: "Indonesian", portuguese: "Portuguese", russian: "Russian", urdu: "Urdu", spanish: "Spanish", french: "French", german: "German", italian: "Italian", japanese: "Japanese", korean: "Korean", tamil: "Tamil", telugu: "Telugu", malayalam: "Malayalam", marathi: "Marathi", punjabi: "Punjabi", vietnamese: "Vietnamese", thai: "Thai", dutch: "Dutch", swedish: "Swedish", danish: "Danish", finnish: "Finnish", norwegian: "Norwegian", polish: "Polish", turkish: "Turkish", ukrainian: "Ukrainian", czech: "Czech", greek: "Greek", hebrew: "Hebrew", romanian: "Romanian", malay: "Malay" };
      if (map[k]) return map[k];
      return str(v);
    }
    var title = str(o.title);
    if (title) parts.push("🎬 " + title);
    var q = str(o.quality);
    if (!q || q.toLowerCase() === "unknown") q = "Unknown";
    parts.push("📺 " + q);
    if (o.season !== undefined && o.season !== null && String(o.season) !== "") parts.push("📂 Season " + o.season);
    if (o.episode !== undefined && o.episode !== null && String(o.episode) !== "") parts.push("🎞️ Episode " + o.episode);
    var audio = o.audio;
    if (Array.isArray(audio)) audio = audio.filter(function (a) { return str(a); }).join(" / ");
    audio = str(audio);
    if (audio && audio.toLowerCase() !== "unknown") parts.push("🔊 " + audio);
    var subs = o.subtitles;
    var langs = [];
    if (Array.isArray(subs)) {
      for (var i = 0; i < subs.length; i++) {
        var lg = (subs[i] && typeof subs[i] === "object") ? (subs[i].language || subs[i].name) : subs[i];
        lg = langName(lg);
        if (lg && langs.indexOf(lg) === -1) langs.push(lg);
      }
    } else if (typeof subs === "string" && str(subs)) { langs = [langName(subs)]; }
    if (langs.length) {
      var shown = langs.slice(0, 3).join(", ");
      if (langs.length > 3) shown += " +" + (langs.length - 3) + " more";
      parts.push("💬 " + shown);
    }
    var size = str(o.size);
    if (size) parts.push("📦 " + size);
    var extra = str(o.extra);
    if (extra) parts.push(extra);
    var src = str(o.source) || str(o.provider);
    if (src) parts.push("🖥️ " + src);
    var server = str(o.server);
    if (!server && str(o.url)) {
      var h = str(o.url).split("/")[2] || "";
      server = h.replace(/^www\./, "");
    }
    if (server) parts.push("🗄️ " + server);
    return parts.join(" • ");
  } catch (e) {
    try { return (o && (o.source || o.provider) ? String(o.source || o.provider) : "Stream") + " • " + (o && o.quality ? String(o.quality) : "Unknown"); } catch (e2) { return "Stream"; }
  }
}

// CineCat Nuvio provider — v1.0.0
//
// Site: https://cinecat.eu — movies + TV, free streaming, own player.
// Mechanism (verified live 2026-11-10, plain fetch, no auth, no bot wall):
//   GET https://edge.cinecat.eu/sources/<name>?tmdb=<id>&type=movie|tv
//       [&season=<n>&episode=<n>]
//   -> {source: "<name>", streams: [{kind: "hls", url, label?}, ...]}
//   Sources (GET /sources, group "savannah"): abyssinia, calico, zanzibar,
//   garfield. Each stream is a first-party HLS media playlist on
//   edge.cinecat.eu; its segments go through zstream-proxy and REQUIRE
//   Referer: https://cinecat.eu/ (without it the proxy answers 403 "nope").
//   Verified: a segment fetched with that Referer is real H.264 video
//   (The Matrix 720p BluRay remaster). Only kind === "hls" streams are used;
//   the site also lists third-party "embeds" — this provider never touches
//   them. Quality comes from the stream's label when present, else Unknown.
//   Title comes from TMDB (same key the DoFlix provider uses); a failed
//   lookup just omits the title from the label. webOS-safe, never throws.
//   The backends 502 often and flap per title, so a failed source request
//   gets one retry — that is what keeps the servers contributing.
//   Garfield is EXCLUDED (see CINECAT_SOURCES): its playlists load, but its
//   video segments never arrive — the proxy hangs waiting on Garfield's file
//   host (verified 2026-11-10: 0 bytes in 60s, all three proxies, Matrix
//   and Breaking Bad), so its streams only buffer forever in the app. Only
//   servers whose segments actually serve are emitted.
//   ZCDN is a separate fast path (GET <zcdn>/cdn?tmdb=...&type=... ->
//   {ready, url}). The user confirmed on their phone that ZCDN gives the
//   FULL movie. From this VM /cdn only ever returns the 12-second promo
//   clip (https://zcdn*/promo/cinecat-4k/v2/master.m3u8 — 3 x 4s segments),
//   so the provider only emits a ZCDN stream when the returned url is NOT
//   a "/promo/" URL; a promo url is skipped, never emitted as a stream.

var CINECAT_API = "https://edge.cinecat.eu";
var CINECAT_REFERER = "https://cinecat.eu/";
var CINECAT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
var CINECAT_TIMEOUT_MS = 12000;
var CINECAT_SOURCES = ["abyssinia", "calico", "zanzibar"];
// Garfield is deliberately NOT in this list: its playlists load, but its
// video segments never arrive (the proxy hangs on Garfield's file host —
// verified 2026-11-10, 0 bytes in 60s, all three proxies, Matrix and
// Breaking Bad), so Garfield streams only buffer forever in the app.
// If it ever recovers, add "garfield" back here.
var CINECAT_ZCDN_HOSTS = [
  "https://zcdn1.2wwlgkfo-31a.workers.dev",
  "https://zcdn2.2wwlgkfo-31a.workers.dev",
  "https://zcdn3.2wwlgkfo-31a.workers.dev"
];
var CINECAT_TMDB_KEY = "d80ba92bc7cefe3359668d30d06f3305";

// ---- fetch helpers (webOS-safe) ----

function cinecatFetch(url, headers, timeoutMs) {
  var controller = null;
  var timer = null;
  try {
    if (typeof AbortController !== "undefined") {
      controller = new AbortController();
    }
  } catch (e) {
    controller = null;
  }
  var opts = { headers: headers || {} };
  if (controller) opts.signal = controller.signal;
  var p = fetch(url, opts);
  if (controller && typeof setTimeout !== "undefined") {
    timer = setTimeout(function () {
      try {
        controller.abort();
      } catch (e) {}
    }, timeoutMs || CINECAT_TIMEOUT_MS);
    p = p.then(
      function (r) {
        try {
          clearTimeout(timer);
        } catch (e) {}
        return r;
      },
      function (e) {
        try {
          clearTimeout(timer);
        } catch (e2) {}
        throw e;
      }
    );
  }
  return p;
}

function cinecatGetJson(url, headers, timeoutMs) {
  return cinecatFetch(url, headers, timeoutMs)
    .then(function (resp) {
      if (!resp || !resp.ok) return null;
      return resp.json().catch(function () {
        return null;
      });
    })
    .catch(function () {
      return null;
    });
}

// ---- TMDB title (for the stream label) ----

function cinecatTmdbTitle(tmdbId, isTv) {
  var kind = isTv ? "tv" : "movie";
  var url =
    "https://api.themoviedb.org/3/" +
    kind +
    "/" +
    tmdbId +
    "?api_key=" +
    CINECAT_TMDB_KEY +
    "&language=en";
  return cinecatGetJson(url, {}, CINECAT_TIMEOUT_MS).then(function (j) {
    if (!j) return "";
    return j.title || j.name || "";
  });
}

// ---- sources ----

function cinecatQualityLabel(label) {
  if (!label) return "Unknown";
  var s = String(label).trim();
  if (/^\d{3,4}p$/i.test(s)) return s;
  if (/^\d{3,4}$/.test(s)) return s + "p";
  return "Unknown";
}

function cinecatSourceNames() {
  return cinecatGetJson(
    CINECAT_API + "/sources",
    { "User-Agent": CINECAT_UA },
    CINECAT_TIMEOUT_MS
  ).then(function (j) {
    if (!j || !j.sources || !j.sources.length) return CINECAT_SOURCES.slice();
    var names = [];
    for (var i = 0; i < j.sources.length; i++) {
      var n = j.sources[i] && j.sources[i].name;
      if (typeof n === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(n)) {
        // Skip garfield: its segments never serve (see CINECAT_SOURCES).
        if (n === "garfield") continue;
        names.push(n);
      }
    }
    if (!names.length) return CINECAT_SOURCES.slice();
    return names;
  });
}

function cinecatOneSource(name, tmdbId, isTv, season, episode) {
  var q =
    "tmdb=" +
    encodeURIComponent(String(tmdbId)) +
    "&type=" +
    (isTv ? "tv" : "movie");
  if (isTv) {
    q += "&season=" + encodeURIComponent(String(season));
    q += "&episode=" + encodeURIComponent(String(episode));
  }
  var url =
    CINECAT_API + "/sources/" + encodeURIComponent(name) + "?" + q;
  var headers = { "User-Agent": CINECAT_UA };
  function parse(j) {
    if (!j || !j.streams || !j.streams.length) return [];
    var out = [];
    for (var i = 0; i < j.streams.length; i++) {
      var s = j.streams[i] || {};
      if (s.kind !== "hls") continue;
      if (typeof s.url !== "string") continue;
      var u = s.url;
      if (u.indexOf("http://") !== 0 && u.indexOf("https://") !== 0) continue;
      out.push({ url: u, quality: cinecatQualityLabel(s.label) });
    }
    return out;
  }
  // These backends 502 often and flap (a source that 502s for one title
  // works for the next), so a failed first attempt gets one retry. A
  // successful response with zero streams is NOT retried.
  return cinecatGetJson(url, headers, CINECAT_TIMEOUT_MS).then(function (j) {
    if (j) return parse(j);
    return cinecatGetJson(url, headers, CINECAT_TIMEOUT_MS).then(function (j2) {
      return parse(j2);
    });
  });
}

// ---- ZCDN fast path ----
// GET <zcdn>/cdn?tmdb=<id>&type=movie|tv[&season=&episode=] -> {ready, url}.
// The site plays url as the "zcdn" stream when ready. From this VM /cdn
// only ever returns the 12-second promo clip (a "/promo/" url), so a
// "/promo/" url is NEVER emitted — only a real (non-promo) movie url is.
// The user confirmed ZCDN gives the full movie on their network.
function cinecatZcdn(tmdbId, isTv, season, episode) {
  var q =
    "tmdb=" +
    encodeURIComponent(String(tmdbId)) +
    "&type=" +
    (isTv ? "tv" : "movie");
  if (isTv) {
    q += "&season=" + encodeURIComponent(String(season));
    q += "&episode=" + encodeURIComponent(String(episode));
  }
  var jobs = CINECAT_ZCDN_HOSTS.map(function (host) {
    var url = host + "/cdn?" + q;
    return cinecatGetJson(url, { "User-Agent": CINECAT_UA }, CINECAT_TIMEOUT_MS).then(
      function (j) {
        if (!j || !j.ready) return null;
        if (typeof j.url !== "string") return null;
        var u = j.url;
        if (u.indexOf("http://") !== 0 && u.indexOf("https://") !== 0) return null;
        // The promo clip is a 12-second intro, not the movie — never emit it.
        if (u.indexOf("/promo/") !== -1) return null;
        return u;
      }
    );
  });
  return Promise.all(jobs).then(function (results) {
    for (var i = 0; i < results.length; i++) {
      if (results[i]) return results[i];
    }
    return null;
  });
}

// ---- entry point ----

function getStreams(tmdbId, mediaType, season, episode) {
  var id = Number(tmdbId);
  var isTv = mediaType === "tv";
  var sn = Number(season) || 1;
  var ep = Number(episode) || 1;
  if (!id) return Promise.resolve([]);
  var streams = [];
  function push(s) {
    streams.push(s);
  }
  return Promise.all([
    cinecatTmdbTitle(id, isTv),
    cinecatSourceNames(),
    cinecatZcdn(id, isTv, sn, ep)
  ]).then(function (res) {
    var title = res[0] || "";
    var names = res[1] || CINECAT_SOURCES.slice();
    var zcdnUrl = res[2] || null;
    var jobs = names.map(function (name) {
      return cinecatOneSource(name, id, isTv, sn, ep).then(function (list) {
        for (var i = 0; i < list.length; i++) {
          var item = list[i];
          var server =
            name.charAt(0).toUpperCase() + name.slice(1);
          var label = formatStreamLabel({
            title: title,
            quality: item.quality,
            season: isTv ? sn : undefined,
            episode: isTv ? ep : undefined,
            source: "CineCat",
            server: server
          });
          push({
            name: label,
            title: label,
            url: item.url,
            quality: item.quality,
            headers: { Referer: CINECAT_REFERER, "User-Agent": CINECAT_UA },
            type: "hls"
          });
        }
      });
    });
    return Promise.all(jobs).then(function () {
      if (zcdnUrl) {
        var zcdnLabel = formatStreamLabel({
          title: title,
          quality: "Unknown",
          season: isTv ? sn : undefined,
          episode: isTv ? ep : undefined,
          source: "CineCat",
          server: "ZCDN"
        });
        push({
          name: zcdnLabel,
          title: zcdnLabel,
          url: zcdnUrl,
          quality: "Unknown",
          headers: { Referer: CINECAT_REFERER, "User-Agent": CINECAT_UA },
          type: "hls"
        });
      }
      return streams;
    });
  }).catch(function () {
    return streams;
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams: getStreams };
}
if (typeof global !== "undefined") {
  global.getStreams = getStreams;
}
