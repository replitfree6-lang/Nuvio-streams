// VideoAPI (videoapi.la) Nuvio provider v1.0.0
// VideoAPI is a free Spanish video API + site generator. Its embed page for a
// title loads a single player hosted on vimeos.net, and that player page carries
// a DIRECT HLS master playlist on *.vimeos.zip / *.vimeos.net. Chain:
//   1. GET https://videoapi.la/e/movie/<tmdb>  (TV: /e/tv/<tmdb>/<s>/<e>)
//      -> page contains https://vimeos.net/embed-<id>.html?cf=<JWT>
//   2. GET the vimeos embed page (Referer = the videoapi page)
//      -> page contains a direct .m3u8 master playlist URL (p2/p3.vimeos.zip or
//         s9.vimeos.net, /hls2/.../master.m3u8, signed, ~12h expiry)
//   3. The master playlist is fetched to read the best resolution + audio
//      tracks (Spanish default, English also present on the titles checked).
//      Subtitle .vtt files on the same host are attached when found.
// The public /api/v1/public/embed endpoint only returns an IFRAME (to
// videoapp.zip) and is NOT used - the app needs direct stream URLs.
// Verified live 2026-11-24: Fight Club (550) full chain, real 480p+720p
// master + segment 200; Matrix (603) master 200; Breaking Bad S1E1 master 200
// (852x480, ES+EN audio, Spanish .vtt 200); PHM (687163) embed + m3u8 found.
// Vimeos is NOT in the vidfamily list (no VidLink/VidNest/VidFast/VidSrc/
// 2Embed/Filemoon/Vixsrc etc. anywhere in the chain). No login, no bot gate
// on any step from a plain client. Signed URLs are resolved fresh every call.
// webOS-safe (no setTimeout without a guard, no optional chaining, no matchAll, no .at()).
// Never throws; returns [] on any failure.

(function () {
  "use strict";

  var TMDB_API_KEY = "d80ba92bc7cefe3359668d30d06f3305";
  var TMDB_BASE = "https://api.themoviedb.org/3";
  var VIDEOAPI_BASE = "https://videoapi.la";
  var VIMEOS_REFERER = "https://vimeos.net/";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
  var TIMEOUT_MS = 12000;

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

  function fetchWithTimeout(url, headers) {
    var controller = null;
    var timer = null;
    try {
      if (typeof AbortController !== "undefined") {
        controller = new AbortController();
        if (typeof setTimeout === "function") {
          timer = setTimeout(function () { try { controller.abort(); } catch (e) {} }, TIMEOUT_MS);
        }
      }
    } catch (e) { controller = null; }
    var opts = { headers: headers || {} };
    if (controller) opts.signal = controller.signal;
    return fetch(url, opts).then(function (res) {
      if (timer && typeof clearTimeout === "function") { try { clearTimeout(timer); } catch (e) {} }
      return res;
    }).catch(function (err) {
      if (timer && typeof clearTimeout === "function") { try { clearTimeout(timer); } catch (e) {} }
      throw err;
    });
  }

  function fetchJson(url, headers) {
    return fetchWithTimeout(url, headers).then(function (res) {
      if (!res || !res.ok) return null;
      return res.json().catch(function () { return null; });
    }).catch(function () { return null; });
  }

  function fetchText(url, headers) {
    return fetchWithTimeout(url, headers).then(function (res) {
      if (!res || !res.ok) return null;
      return res.text().catch(function () { return null; });
    }).catch(function () { return null; });
  }

  function getTmdbTitle(tmdbId, mediaType) {
    var url = TMDB_BASE + "/" + (mediaType === "tv" ? "tv" : "movie") + "/" + tmdbId + "?api_key=" + TMDB_API_KEY;
    return fetchJson(url, { "Accept": "application/json" }).then(function (data) {
      if (!data) return null;
      return data.title || data.name || null;
    }).catch(function () { return null; });
  }

  // First vimeos embed URL in a VideoAPI page, or null.
  function extractEmbedUrl(html) {
    if (!html) return null;
    var m = html.match(/https:\/\/[a-z0-9.-]*vimeos\.net\/embed-[a-z0-9]+\.html\?cf=[A-Za-z0-9._-]+/i);
    return m ? m[0] : null;
  }

  // First direct .m3u8 master URL in a vimeos player page, or null.
  function extractM3u8(html) {
    if (!html) return null;
    var m = html.match(/https:\/\/[a-z0-9.-]*vimeos\.(?:zip|net)\/hls2\/[^"' \t\r\n]+\.m3u8[^"' \t\r\n]*/i);
    return m ? m[0] : null;
  }

  // Subtitle .vtt URLs on the same vimeos host: [{url, language}].
  function extractSubtitles(html) {
    var out = [];
    if (!html) return out;
    var seen = {};
    var re = /https:\/\/[a-z0-9.-]*vimeos\.(?:zip|net)\/vtt\/[^"' \t\r\n]+\.vtt/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var url = m[0];
      if (seen[url]) continue;
      seen[url] = true;
      var lang = "Unknown";
      var lm = url.match(/_([a-z]{3})\.vtt$/i);
      if (lm) lang = lm[1];
      out.push({ url: url, language: lang });
    }
    return out;
  }

  // From a master playlist: best resolution height + audio track names.
  function parseMaster(text) {
    var info = { quality: "Unknown", audio: [] };
    if (!text) return info;
    var maxH = 0;
    var re = /RESOLUTION=\d+x(\d+)/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      var h = parseInt(m[1], 10);
      if (!isNaN(h) && h > maxH) maxH = h;
    }
    if (maxH >= 1080) info.quality = "1080p";
    else if (maxH >= 720) info.quality = "720p";
    else if (maxH >= 480) info.quality = "480p";
    else if (maxH > 0) info.quality = maxH + "p";
    var are = /#EXT-X-MEDIA:TYPE=AUDIO[^,\n]*,NAME="([^"]+)"[^,\n]*,LANGUAGE="([a-z]{2})"/g;
    while ((m = are.exec(text)) !== null) {
      var name = m[1];
      if (name && info.audio.indexOf(name) === -1) info.audio.push(name);
    }
    return info;
  }

  function getStreams(tmdbId, mediaType, season, episode) {
    try {
      tmdbId = String(tmdbId);
      mediaType = mediaType === "tv" ? "tv" : "movie";
      if (season !== null && season !== undefined && season !== "") season = Number(season);
      else season = null;
      if (episode !== null && episode !== undefined && episode !== "") episode = Number(episode);
      else episode = null;
      if (isNaN(season)) season = null;
      if (isNaN(episode)) episode = null;

      var pageUrl;
      if (mediaType === "tv") {
        if (season === null || episode === null) return Promise.resolve([]);
        pageUrl = VIDEOAPI_BASE + "/e/tv/" + tmdbId + "/" + season + "/" + episode;
      } else {
        pageUrl = VIDEOAPI_BASE + "/e/movie/" + tmdbId;
      }

      var titlePromise = getTmdbTitle(tmdbId, mediaType);
      var streamPromise = fetchText(pageUrl, {
        "User-Agent": UA,
        "Accept": "text/html",
        "Referer": VIDEOAPI_BASE + "/"
      }).then(function (pageHtml) {
        var embedUrl = extractEmbedUrl(pageHtml);
        if (!embedUrl) return null;
        return fetchText(embedUrl, {
          "User-Agent": UA,
          "Accept": "text/html",
          "Referer": pageUrl
        }).then(function (embedHtml) {
          var m3u8 = extractM3u8(embedHtml);
          if (!m3u8) return null;
          var subs = extractSubtitles(embedHtml);
          return fetchText(m3u8, {
            "User-Agent": UA,
            "Accept": "*/*",
            "Referer": VIMEOS_REFERER
          }).then(function (master) {
            var info = parseMaster(master);
            return { url: m3u8, quality: info.quality, audio: info.audio, subtitles: subs };
          }).catch(function () {
            return { url: m3u8, quality: "Unknown", audio: [], subtitles: subs };
          });
        });
      }).catch(function () { return null; });

      return Promise.all([titlePromise, streamPromise]).then(function (results) {
        var title = results[0] || null;
        var found = results[1];
        if (!found || !found.url) return [];
        var subs = [];
        for (var i = 0; i < found.subtitles.length; i++) {
          subs.push({ url: found.subtitles[i].url, language: found.subtitles[i].language, label: found.subtitles[i].language });
        }
        var label = formatStreamLabel({
          title: title,
          quality: found.quality,
          season: mediaType === "tv" ? season : undefined,
          episode: mediaType === "tv" ? episode : undefined,
          audio: found.audio.length ? found.audio : undefined,
          subtitles: subs,
          source: "VideoAPI",
          server: "Vimeos",
          url: found.url
        });
        var stream = {
          name: label,
          title: label,
          url: found.url,
          quality: found.quality,
          type: "hls",
          headers: {
            "Referer": VIMEOS_REFERER,
            "User-Agent": UA
          }
        };
        if (subs.length) stream.subtitles = subs;
        return [stream];
      }).catch(function () { return []; });
    } catch (e) {
      return Promise.resolve([]);
    }
  }

  var api = { getStreams: getStreams };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof global !== "undefined") { try { global.getStreams = getStreams; } catch (e) {} }
  if (typeof self !== "undefined") { try { self.getStreams = getStreams; } catch (e) {} }
})();
