// MoviesAPI Nuvio provider — v1.0.0
//
// Site: https://moviesapi.to — movies + TV, free streaming.
// Mechanism (verified live 2026-11-22, plain fetch, no login):
//   Movie: GET https://moviesapi.to/api/vidora/v1/movie/<tmdbId>
//   TV:    GET https://moviesapi.to/api/vidora/v1/tv/<tmdbId>/<season>/<episode>
//     Headers REQUIRED: x-player-key (public player key from the site's own
//     frontend JS) + Referer: the movie/tv page on moviesapi.to.
//     Without the Referer the API returns {"error":"Forbidden"}.
//     -> {result, type, title, tmdb_id, imdb_id, year, view_type, view_id,
//         sources: [{file_code, url, source, tracks: []}]}
//     A real source is a direct HLS master.m3u8 on paretocdn.site
//     (tokenised, 12h expiry). "result": false means the title is not
//     encoded yet — the provider then returns no streams.
//   Quality comes from the highest variant in the master playlist.
//   Title comes from the API response (TMDB as fallback).
//   webOS-safe, never throws.

var MOVIESAPI_BASE = "https://moviesapi.to";
var MOVIESAPI_API = "https://moviesapi.to/api/vidora/v1";
var MOVIESAPI_KEY = "3a67e8866ae1d2bb9e81fe7f73315a56eb3bdf5e3e755c7554c8be6910aa6b13";
var MOVIESAPI_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
var MOVIESAPI_TIMEOUT_MS = 12000;
var MOVIESAPI_TMDB_KEY = "d80ba92bc7cefe3359668d30d06f3305";

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

// ---- helpers ----

function moviesapiFetchText(url, headers) {
  var ctrl = null;
  var timer = null;
  try {
    if (typeof AbortController !== "undefined" && typeof setTimeout !== "undefined") {
      ctrl = new AbortController();
      timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, MOVIESAPI_TIMEOUT_MS);
    }
  } catch (e) { ctrl = null; }
  var opts = { headers: headers || {} };
  if (ctrl) opts.signal = ctrl.signal;
  return fetch(url, opts).then(function (r) {
    if (timer) clearTimeout(timer);
    if (!r || !r.ok) return null;
    return r.text();
  }).catch(function () {
    if (timer) clearTimeout(timer);
    return null;
  });
}

function moviesapiFetchJson(url, headers) {
  return moviesapiFetchText(url, headers).then(function (t) {
    if (!t) return null;
    try { return JSON.parse(t); } catch (e) { return null; }
  });
}

function moviesapiTmdbTitle(tmdbId, isTv) {
  var url = "https://api.themoviedb.org/3/" + (isTv ? "tv/" : "movie/") +
    encodeURIComponent(String(tmdbId)) + "?api_key=" + MOVIESAPI_TMDB_KEY;
  return moviesapiFetchJson(url, { "User-Agent": MOVIESAPI_UA }).then(function (j) {
    if (!j) return "";
    var t = j.title || j.name || "";
    return typeof t === "string" ? t : "";
  });
}

// Highest variant in a master playlist -> standard label ("1080p", "720p", ...).
// Uses width (cinemascope masters have short heights, e.g. 1920x824 = 1080p).
function moviesapiMaxQuality(masterText) {
  if (!masterText) return "Unknown";
  var bestW = 0;
  var bestH = 0;
  var re = /RESOLUTION=(\d+)x(\d+)/g;
  var m = null;
  while ((m = re.exec(masterText)) !== null) {
    var w = parseInt(m[1], 10);
    var h = parseInt(m[2], 10);
    if (w > bestW) bestW = w;
    if (h > bestH) bestH = h;
  }
  if (!bestW && !bestH) return "Unknown";
  if (bestW >= 1920 || bestH >= 1080) return "1080p";
  if (bestW >= 1280 || bestH >= 720) return "720p";
  if (bestW >= 854 || bestH >= 480) return "480p";
  if (bestH >= 360) return "360p";
  return "Unknown";
}

// ---- entry point ----

function getStreams(tmdbId, mediaType, season, episode) {
  var id = Number(tmdbId);
  var isTv = mediaType === "tv";
  var sn = Number(season) || 1;
  var ep = Number(episode) || 1;
  if (!id) return Promise.resolve([]);
  var streams = [];
  var apiUrl = isTv
    ? MOVIESAPI_API + "/tv/" + encodeURIComponent(String(id)) + "/" + sn + "/" + ep
    : MOVIESAPI_API + "/movie/" + encodeURIComponent(String(id));
  var pageRef = isTv
    ? MOVIESAPI_BASE + "/tv/" + encodeURIComponent(String(id)) + "/" + sn + "/" + ep
    : MOVIESAPI_BASE + "/movie/" + encodeURIComponent(String(id));
  var apiHeaders = {
    "User-Agent": MOVIESAPI_UA,
    Referer: pageRef,
    Accept: "application/json",
    "x-player-key": MOVIESAPI_KEY
  };
  return moviesapiFetchJson(apiUrl, apiHeaders).then(function (j) {
    if (!j || j.result !== true || !j.sources || !j.sources.length) return streams;
    var title = (j.title && String(j.title)) || "";
    var titleP = title ? Promise.resolve(title) : moviesapiTmdbTitle(id, isTv);
    // Fetch each source's master once to learn the real quality.
    var jobs = [];
    for (var i = 0; i < j.sources.length; i++) {
      (function (s) {
        if (!s || typeof s.url !== "string" || !s.url) return;
        var url = s.url;
        var server = (s.source && String(s.source)) || "Vidora";
        jobs.push(moviesapiFetchText(url, {
          "User-Agent": MOVIESAPI_UA,
          Referer: pageRef
        }).then(function (master) {
          return { url: url, server: server, quality: moviesapiMaxQuality(master) };
        }));
      })(j.sources[i]);
    }
    if (!jobs.length) return streams;
    return Promise.all(jobs).then(function (resolved) {
      return titleP.then(function (t) {
        for (var k = 0; k < resolved.length; k++) {
          var r = resolved[k];
          if (!r || !r.url) continue;
          var label = formatStreamLabel({
            title: t,
            quality: r.quality,
            season: isTv ? sn : undefined,
            episode: isTv ? ep : undefined,
            source: "MoviesAPI",
            server: r.server
          });
          streams.push({
            name: label,
            title: label,
            url: r.url,
            quality: r.quality,
            headers: { Referer: pageRef, "User-Agent": MOVIESAPI_UA },
            type: "hls"
          });
        }
        return streams;
      });
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
