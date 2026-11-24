// Zoryva (zoryva.me) Nuvio provider v1.0.0
// Zoryva is a free streaming front-end (movies/TV/anime). Its watch page offers
// 4 sources; the two that return direct playable streams from a plain client are
// backed by the Atlantic hls.lol resolver API:
//   - Silvia:  GET https://it.hls.lol/resolve?tmdbId=<id>&type=movie|tv[&season=&episode=]
//   - Q62:     GET https://stream.hls.lol/q62?tmdbId=<id>&type=movie|tv[&season=&episode=]
// Both return {"found":true,"sources":{ "<label>": {"label","server","type":"hls","url":"...m3u8", "quality"?} }}.
// The atlantic.bz Referer is REQUIRED (without it the API returns {"error":"forbidden"}).
// Zoryva's other two sources are NOT used: VidSrc is vidfamily (banned), and the
// VidZee source did not play in a live browser test.
// Verified live 2026-11-24: Matrix (603) -> Silvia 720p + Q62 1080p (both real
// master playlists); Project Hail Mary (687163) -> Silvia 720p; BB S1E1 -> Silvia 720p.
// webOS-safe (no setTimeout without a guard, no optional chaining, no matchAll, no .at()).
// Never throws; returns [] on any failure.

(function () {
  "use strict";

  var TMDB_API_KEY = "d80ba92bc7cefe3359668d30d06f3305";
  var TMDB_BASE = "https://api.themoviedb.org/3";
  var ATLANTIC_REFERER = "https://atlantic.bz/";
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

  function qualityFromLabel(label, fallback) {
    var s = String(label || "");
    var m = s.match(/(\d{3,4})\s*p/i);
    if (m) return m[1] + "p";
    if (fallback) return String(fallback);
    return "Unknown";
  }

  function parseSources(data) {
    var out = [];
    try {
      if (!data || typeof data !== "object") return out;
      var sources = data.sources;
      if (!sources || typeof sources !== "object") return out;
      var keys = Object.keys(sources);
      for (var i = 0; i < keys.length; i++) {
        var entry = sources[keys[i]];
        if (!entry || typeof entry !== "object") continue;
        var url = entry.url || entry.master || "";
        if (!url || typeof url !== "string") continue;
        // Only direct playable URLs: full http(s) .m3u8 (or .mp4). Skip tokens.
        if (url.indexOf("http") !== 0) continue;
        if (url.indexOf(".m3u8") === -1 && url.indexOf(".mp4") === -1) continue;
        var type = entry.type || "";
        if (type === "hls" || url.indexOf(".m3u8") !== -1) type = "hls";
        else if (url.indexOf(".mp4") !== -1) type = "mp4";
        else type = "hls";
        var quality = entry.quality ? String(entry.quality) : qualityFromLabel(entry.label || keys[i], null);
        out.push({
          url: url,
          type: type,
          quality: quality,
          server: entry.server ? String(entry.server) : (keys[i] || "Unknown"),
          label: entry.label ? String(entry.label) : keys[i]
        });
      }
    } catch (e) {}
    return out;
  }

  function resolveServer(baseUrl, tmdbId, mediaType, season, episode) {
    var q = "tmdbId=" + encodeURIComponent(tmdbId) + "&type=" + (mediaType === "tv" ? "tv" : "movie");
    if (mediaType === "tv") {
      if (season !== null && season !== undefined) q += "&season=" + encodeURIComponent(season);
      if (episode !== null && episode !== undefined) q += "&episode=" + encodeURIComponent(episode);
    }
    var url = baseUrl + "?" + q;
    var headers = {
      "User-Agent": UA,
      "Accept": "*/*",
      "Referer": ATLANTIC_REFERER,
      "Origin": ATLANTIC_REFERER
    };
    return fetchJson(url, headers).then(function (data) {
      if (!data) return [];
      if (data.found === false) return [];
      return parseSources(data);
    }).catch(function () { return []; });
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

      var titlePromise = getTmdbTitle(tmdbId, mediaType);
      var silviaPromise = resolveServer("https://it.hls.lol/resolve", tmdbId, mediaType, season, episode);
      var q62Promise = resolveServer("https://stream.hls.lol/q62", tmdbId, mediaType, season, episode);

      return Promise.all([titlePromise, silviaPromise, q62Promise]).then(function (results) {
        var title = results[0] || null;
        var found = results[1].concat(results[2]);
        var seen = {};
        var streams = [];
        for (var i = 0; i < found.length; i++) {
          var f = found[i];
          if (seen[f.url]) continue;
          seen[f.url] = true;
          var label = formatStreamLabel({
            title: title,
            quality: f.quality,
            season: mediaType === "tv" ? season : undefined,
            episode: mediaType === "tv" ? episode : undefined,
            source: "Zoryva",
            server: f.server,
            url: f.url
          });
          streams.push({
            name: label,
            title: label,
            url: f.url,
            quality: f.quality,
            type: f.type,
            headers: {
              "Referer": ATLANTIC_REFERER,
              "User-Agent": UA
            }
          });
        }
        return streams;
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
