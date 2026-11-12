// CNO Nuvio provider — v1.0.0
//
// Site: https://cno.to — movies + TV, free streaming, own player.
// Mechanism (verified live 2026-11-12, plain fetch, no auth, no bot wall
// on the API itself):
//   Movie: GET https://cno.to/api/movie/<tmdbId>
//     -> {title, sources: [{id, kind, url, label, own, ...}, ...]}
//     Only ONE source is a real stream: "Server 21", the site's OWN HLS
//     server ({kind: "hls", own: true, url: "/api/s/21/movie/<id>?v=3"}).
//     The other two ("Player 1" = cinesrc.st embed, "Player 2" =
//     vidfast.vc embed) are third-party embeds and are NEVER used.
//   TV: the metadata call GET /api/tv/<tmdb>?season=<s>&episode=<e>
//     returns no sources, so the Server 21 URL is built directly:
//     GET https://cno.to/api/s/21/tv/<tmdb>/<season>/<episode>?v=3
//   The Server 21 URL returns a real HLS master playlist (v.lumenbox.top
//   variants, up to 3840x2160, H.264 + AAC). The master loads with a plain
//   fetch; the variants/segments are Cloudflare-guarded and need
//   Referer: https://cno.to/ (they 403 from this VM's network even with
//   it — the user's residential network reaches them; the user already
//   has CNO working in-app, so in-app playback is the decisive test).
//   Quality comes from the highest RESOLUTION in the master playlist.
//   Title comes from TMDB (same key the DoFlix/CineCat providers use).
//   webOS-safe, never throws.

var CNO_API = "https://cno.to";
var CNO_REFERER = "https://cno.to/";
var CNO_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
var CNO_TIMEOUT_MS = 12000;
var CNO_TMDB_KEY = "d80ba92bc7cefe3359668d30d06f3305";

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

function cnoFetchText(url, headers) {
  var ctrl = null;
  var timer = null;
  try {
    if (typeof AbortController !== "undefined" && typeof setTimeout !== "undefined") {
      ctrl = new AbortController();
      timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, CNO_TIMEOUT_MS);
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

function cnoFetchJson(url, headers) {
  return cnoFetchText(url, headers).then(function (t) {
    if (!t) return null;
    try { return JSON.parse(t); } catch (e) { return null; }
  });
}

function cnoTmdbTitle(tmdbId, isTv) {
  var url = "https://api.themoviedb.org/3/" + (isTv ? "tv/" : "movie/") +
    encodeURIComponent(String(tmdbId)) + "?api_key=" + CNO_TMDB_KEY;
  return cnoFetchJson(url, { "User-Agent": CNO_UA }).then(function (j) {
    if (!j) return "";
    var t = j.title || j.name || "";
    return typeof t === "string" ? t : "";
  });
}

// Highest RESOLUTION=WxH in a master playlist -> "2160p" / "1080p" / ...
function cnoMaxQuality(masterText) {
  if (!masterText) return "Unknown";
  var best = 0;
  var re = /RESOLUTION=(\d+)x(\d+)/g;
  var m = null;
  while ((m = re.exec(masterText)) !== null) {
    var h = parseInt(m[2], 10);
    if (h > best) best = h;
  }
  if (!best) return "Unknown";
  return best + "p";
}

// ---- Server 21 ----

// Movie: resolve the own HLS source from the metadata call, fetch its
// master playlist, and return {url, quality} (or null).
function cnoMovieServer21(tmdbId) {
  var url = CNO_API + "/api/movie/" + encodeURIComponent(String(tmdbId));
  return cnoFetchJson(url, { "User-Agent": CNO_UA, Referer: CNO_REFERER }).then(function (j) {
    if (!j || !j.sources || !j.sources.length) return null;
    var ownUrl = null;
    for (var i = 0; i < j.sources.length; i++) {
      var s = j.sources[i] || {};
      // Only the site's OWN HLS server. Embeds (Player 1 / Player 2)
      // are third-party embeds and are never used.
      if (s.kind === "hls" && s.own === true && typeof s.url === "string" && s.url) {
        ownUrl = s.url;
        break;
      }
    }
    if (!ownUrl) return null;
    if (ownUrl.indexOf("http://") !== 0 && ownUrl.indexOf("https://") !== 0) {
      ownUrl = CNO_API + (ownUrl.charAt(0) === "/" ? "" : "/") + ownUrl;
    }
    return cnoFetchText(ownUrl, { "User-Agent": CNO_UA, Referer: CNO_REFERER }).then(function (master) {
      if (!master || master.indexOf("#EXTM3U") !== 0) return null;
      return { url: ownUrl, quality: cnoMaxQuality(master) };
    });
  });
}

// TV: the metadata call returns no sources, so the Server 21 URL is built
// directly (verified live for Breaking Bad S1E1).
function cnoTvServer21(tmdbId, season, episode) {
  var url = CNO_API + "/api/s/21/tv/" + encodeURIComponent(String(tmdbId)) +
    "/" + encodeURIComponent(String(season)) + "/" + encodeURIComponent(String(episode)) + "?v=3";
  return cnoFetchText(url, { "User-Agent": CNO_UA, Referer: CNO_REFERER }).then(function (master) {
    if (!master || master.indexOf("#EXTM3U") !== 0) return null;
    return { url: url, quality: cnoMaxQuality(master) };
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
    cnoTmdbTitle(id, isTv),
    isTv ? cnoTvServer21(id, sn, ep) : cnoMovieServer21(id)
  ]).then(function (res) {
    var title = res[0] || "";
    var s21 = res[1] || null;
    if (s21) {
      var label = formatStreamLabel({
        title: title,
        quality: s21.quality,
        season: isTv ? sn : undefined,
        episode: isTv ? ep : undefined,
        source: "CNO",
        server: "Server 21"
      });
      push({
        name: label,
        title: label,
        url: s21.url,
        quality: s21.quality,
        headers: { Referer: CNO_REFERER, "User-Agent": CNO_UA },
        type: "hls"
      });
    }
    return streams;
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
