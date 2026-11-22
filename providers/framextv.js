// FrameX Nuvio provider — v1.0.0
//
// Site: https://framextv.cc — movies + TV, free streaming.
// Mechanism (verified live 2026-11-22, plain fetch, no auth, no key):
//   GET https://api.framextv.cc/api/stream?type=movie&id=<tmdbId>&provider=vidly
//   GET https://api.framextv.cc/api/stream?type=tv&id=<tmdbId>&season=<s>&episode=<e>&provider=vidly
//     -> {success, provider, sources: [{url, quality, type, server, skipProxy}],
//         subtitles: [{url, label, lang, language, format, source, isDefault}]}
//   The API is PINNED to provider=vidly. The response is only used when
//   success is true AND provider is "vidly" — any other provider (vidlink,
//   moviebox, movy, ...) is dropped, never emitted. Vidly serves the stream
//   as HLS ("Baby Dragon I" direct / relay / VPS proxy) on img.rousav.tech
//   (movies) and gzip.rousav.tech (TV) via *.hybrows.workers.dev proxies.
//   Mirrors api.framextv.xyz / .tech / .pro are tried if .cc fails.
//   Quality comes from the highest variant in the master playlist.
//   Subtitles come from the API (OpenSubtitles via subs5.strem.io, VTT);
//   English ones are attached to every stream.
//   Title comes from TMDB (same key the DoFlix/CineCat providers use).
//   webOS-safe, never throws.

var FRAMEX_BASES = [
  "https://api.framextv.cc",
  "https://api.framextv.xyz",
  "https://api.framextv.tech",
  "https://api.framextv.pro"
];
var FRAMEX_REFERER = "https://framextv.cc/";
var FRAMEX_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
var FRAMEX_TIMEOUT_MS = 12000;
var FRAMEX_TMDB_KEY = "d80ba92bc7cefe3359668d30d06f3305";

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

function framexFetchText(url, headers) {
  var ctrl = null;
  var timer = null;
  try {
    if (typeof AbortController !== "undefined" && typeof setTimeout !== "undefined") {
      ctrl = new AbortController();
      timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, FRAMEX_TIMEOUT_MS);
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

function framexFetchJson(url, headers) {
  return framexFetchText(url, headers).then(function (t) {
    if (!t) return null;
    try { return JSON.parse(t); } catch (e) { return null; }
  });
}

function framexTmdbTitle(tmdbId, isTv) {
  var url = "https://api.themoviedb.org/3/" + (isTv ? "tv/" : "movie/") +
    encodeURIComponent(String(tmdbId)) + "?api_key=" + FRAMEX_TMDB_KEY;
  return framexFetchJson(url, { "User-Agent": FRAMEX_UA }).then(function (j) {
    if (!j) return "";
    var t = j.title || j.name || "";
    return typeof t === "string" ? t : "";
  });
}

// Highest variant in a master playlist -> standard label ("1080p", "720p", ...).
// Uses width (cinemascope masters have short heights, e.g. 1920x824 = 1080p).
function framexMaxQuality(masterText) {
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

// Try each API mirror in order; return the first response that is
// success:true AND provider:"vidly". Any other provider is dropped.
function framexStream(tmdbId, isTv, season, episode) {
  var path = "/api/stream?type=" + (isTv ? "tv" : "movie") +
    "&id=" + encodeURIComponent(String(tmdbId));
  if (isTv) {
    path += "&season=" + encodeURIComponent(String(season)) +
      "&episode=" + encodeURIComponent(String(episode));
  }
  path += "&provider=vidly";
  var chain = Promise.resolve(null);
  FRAMEX_BASES.forEach(function (base) {
    chain = chain.then(function (found) {
      if (found) return found;
      return framexFetchJson(base + path, {
        "User-Agent": FRAMEX_UA,
        Referer: FRAMEX_REFERER,
        Accept: "application/json"
      }).then(function (j) {
        if (!j || j.success !== true) return null;
        var prov = (j.provider || "").toString().toLowerCase();
        if (prov !== "vidly") return null;
        if (!j.sources || !j.sources.length) return null;
        return j;
      });
    });
  });
  return chain;
}

// English subtitles from the API response (default first), up to 3.
function framexEnglishSubs(j) {
  var out = [];
  var list = (j && j.subtitles) || [];
  var en = [];
  var other = [];
  for (var i = 0; i < list.length; i++) {
    var s = list[i] || {};
    if (!s.url || typeof s.url !== "string") continue;
    var lang = ((s.lang || s.language || "") + "").toLowerCase();
    var item = { url: s.url, lang: lang || "en", label: s.label || "English" };
    if (lang === "en" || lang === "eng" || lang === "english" || lang.indexOf("en-") === 0) {
      if (s.isDefault) en.unshift(item); else en.push(item);
    } else {
      other.push(item);
    }
  }
  for (var k = 0; k < en.length && out.length < 3; k++) out.push(en[k]);
  return out;
}

// ---- entry point ----

function getStreams(tmdbId, mediaType, season, episode) {
  var id = Number(tmdbId);
  var isTv = mediaType === "tv";
  var sn = Number(season) || 1;
  var ep = Number(episode) || 1;
  if (!id) return Promise.resolve([]);
  var streams = [];
  return Promise.all([
    framexTmdbTitle(id, isTv),
    framexStream(id, isTv, sn, ep)
  ]).then(function (res) {
    var title = res[0] || "";
    var j = res[1] || null;
    if (!j) return streams;
    var subs = framexEnglishSubs(j);
    // The 3 sources are the same stream via different proxies; fetch the
    // first one's master once to learn the real quality.
    var firstUrl = null;
    for (var i = 0; i < j.sources.length; i++) {
      var s0 = j.sources[i] || {};
      if (s0.type === "hls" && typeof s0.url === "string" && s0.url) { firstUrl = s0.url; break; }
    }
    var qualityP = firstUrl
      ? framexFetchText(firstUrl, { "User-Agent": FRAMEX_UA, Referer: FRAMEX_REFERER }).then(function (master) {
          return framexMaxQuality(master);
        })
      : Promise.resolve("Unknown");
    return qualityP.then(function (quality) {
      for (var k = 0; k < j.sources.length; k++) {
        var s = j.sources[k] || {};
        if (s.type !== "hls" || typeof s.url !== "string" || !s.url) continue;
        var server = (s.server && String(s.server)) || "Baby Dragon I";
        var label = formatStreamLabel({
          title: title,
          quality: quality,
          season: isTv ? sn : undefined,
          episode: isTv ? ep : undefined,
          subtitles: subs,
          source: "FrameX",
          server: server
        });
        var stream = {
          name: label,
          title: label,
          url: s.url,
          quality: quality,
          headers: { Referer: FRAMEX_REFERER, "User-Agent": FRAMEX_UA },
          type: "hls"
        };
        if (subs.length) stream.subtitles = subs;
        streams.push(stream);
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
