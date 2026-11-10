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

// Arc018 Nuvio provider — v1.0.0
// Site: https://arc018.stream (movies + TV, free streaming, own player UI).
// Mechanism (verified live 2026-11-10, plain fetch, no auth, no bot wall):
//   TMDB -> title + year -> slug "<title>-<year>-watch-online"
//   Movie: GET /watch-movie/<slug>/  |  TV: GET /watch-series/<slug>/ then
//          the episode link /episode/<slug>/s<season>-e<episode>/
//   The watch/episode page carries a data-token. POST it to /ajax/ajax.php
//   (movies: field "players", TV: field "players_show") -> JSON array of
//   servers [{name, link}]. The two servers are "arc018" (mfw09.org, a
//   Byse video host) and "Vidmoly" (kaembed.net).
//   Vidmoly: the embed page is a JWPlayer page whose `sources` array holds a
//   direct HLS master playlist URL (vmpx/vmget.online, tokenised, ~12h
//   expiry). The master has 2 variants (up to 1080p). Segments serve.
//   arc018/Byse server: NOT included. Its embed is a React SPA whose video
//   API (/api/videos/...) requires a proof-of-work + browser-fingerprint
//   captcha token before /api/videos/stream/<id> will serve; the stream
//   endpoint returns 403 "invalid or expired token" without it. That is a
//   browser-bound anti-bot gate the app runtime cannot pass, so only
//   Vidmoly streams are emitted (same "only playable streams" rule as
//   DoFlix/CineCat). If the arc018 server's direct URL is ever captured
//   (phone DevTools, like Toonix), it can be added then.
// Quality: parsed from the Vidmoly HLS master (highest variant resolution).
// webOS-safe: no setTimeout, no RegExp.$1, no optional chaining, no
// matchAll, no .at(). Never throws — returns [] on any failure.
(function () {
  "use strict";
  var TMDB_KEY = "d80ba92bc7cefe3359668d30d06f3305";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
  var SITE = "https://arc018.stream";
  var TIMEOUT_MS = 12000;

  function fetchWithTimeout(url, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    if (!opts.headers["User-Agent"]) opts.headers["User-Agent"] = UA;
    var controller = null;
    var timer = null;
    try {
      if (typeof AbortController !== "undefined") {
        controller = new AbortController();
        opts.signal = controller.signal;
        if (typeof setTimeout !== "undefined") {
          timer = setTimeout(function () { try { controller.abort(); } catch (e) {} }, TIMEOUT_MS);
        }
      }
    } catch (e) {}
    var p = fetch(url, opts);
    if (timer) {
      p = p.then(function (r) { clearTimeout(timer); return r; }, function (e) { clearTimeout(timer); throw e; });
    }
    return p;
  }

  function jsonGet(url) {
    return fetchWithTimeout(url, { headers: { Accept: "application/json" } })
      .then(function (r) { if (!r.ok) return null; return r.json(); })
      .catch(function () { return null; });
  }

  function textGet(url, referer) {
    var h = {};
    if (referer) h.Referer = referer;
    return fetchWithTimeout(url, { headers: h })
      .then(function (r) { if (!r.ok) return null; return r.text(); })
      .catch(function () { return null; });
  }

  function slugify(title, year) {
    var s = String(title || "").toLowerCase();
    s = s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return s + "-" + year + "-watch-online";
  }

  function normTitle(t) {
    return String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
  }

  // Find a watch link in the site search HTML matching title+year.
  function findInSearch(html, mediaType, title, year) {
    if (!html) return null;
    var want = normTitle(title);
    var wantMovie = mediaType === "movie";
    var re = /<a[^>]+href="(https:\/\/arc018\.stream\/(watch-movie|watch-series)\/([^"]+?))"[^>]*>([\s\S]{0,1200}?)<\/a>/g;
    var m;
    while ((m = re.exec(html)) !== null) {
      var kind = m[2];
      if (wantMovie && kind !== "watch-movie") continue;
      if (!wantMovie && kind !== "watch-series") continue;
      var card = m[4] || "";
      var h3 = card.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
      var cardTitle = h3 ? normTitle(h3[1].replace(/<[^>]+>/g, "")) : "";
      var y = card.match(/<span>(\d{4})<\/span>/);
      var cardYear = y ? parseInt(y[1], 10) : null;
      if (cardTitle === want && (cardYear === null || cardYear === year)) return m[1];
    }
    return null;
  }

  function tmdbTitle(tmdbId, mediaType) {
    var kind = mediaType === "tv" ? "tv" : "movie";
    return jsonGet("https://api.themoviedb.org/3/" + kind + "/" + tmdbId + "?api_key=" + TMDB_KEY + "&language=en-US")
      .then(function (d) {
        if (!d) return null;
        var title = d.title || d.name || null;
        var date = d.release_date || d.first_air_date || "";
        var year = date ? parseInt(date.slice(0, 4), 10) : null;
        if (!title || !year) return null;
        return { title: title, year: year };
      });
  }

  function extractToken(html) {
    if (!html) return null;
    var m = html.match(/data-token="([^"]+)"/);
    return m ? m[1] : null;
  }

  // POST the token to /ajax/ajax.php; field is "players" (movie) or "players_show" (tv).
  function loadServers(pageUrl, token, field) {
    var body = new URLSearchParams();
    body.append(field, token);
    return fetchWithTimeout(SITE + "/ajax/ajax.php", {
      method: "POST",
      headers: { Referer: pageUrl, "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    })
      .then(function (r) { if (!r.ok) return null; return r.json(); })
      .then(function (j) {
        if (!j) return null;
        if (Array.isArray(j)) return j;
        return null; // {"error": "No playable sources"} etc.
      })
      .catch(function () { return null; });
  }

  function vidmolyLink(servers) {
    if (!servers) return null;
    for (var i = 0; i < servers.length; i++) {
      var s = servers[i] || {};
      if (String(s.name || "").toLowerCase() === "vidmoly" && typeof s.link === "string" && s.link.indexOf("kaembed.net") >= 0) return s.link;
    }
    return null;
  }

  // Extract the HLS master URL from a Vidmoly (kaembed) embed page.
  function extractVidmolyHls(html) {
    if (!html) return null;
    var m = html.match(/https:\/\/[a-z0-9.-]+\.vm[a-z]*\.online\/[^"' ]*master\.m3u8[^"' ]*/);
    return m ? m[0] : null;
  }

  // Highest resolution in an HLS master playlist -> "1080p"/"720p"/"480p".
  function qualityFromMaster(masterText) {
    if (!masterText) return "Unknown";
    var best = 0;
    var re = /RESOLUTION=(\d+)x(\d+)/g;
    var m;
    while ((m = re.exec(masterText)) !== null) {
      var h = parseInt(m[2], 10);
      if (h > best) best = h;
    }
    if (best >= 1080) return "1080p";
    if (best >= 720) return "720p";
    if (best >= 480) return "480p";
    if (best > 0) return best + "p";
    return "Unknown";
  }

  function toStream(hlsUrl, title, mediaType, season, episode, quality) {
    var label = formatStreamLabel({
      title: title, quality: quality,
      season: mediaType === "tv" ? season : null,
      episode: mediaType === "tv" ? episode : null,
      source: "Arc018", server: "Vidmoly"
    });
    return { name: label, title: label, url: hlsUrl, quality: quality, type: "hls",
      headers: { Referer: "https://kaembed.net/", "User-Agent": UA } };
  }

  function getStreams(tmdbId, mediaType, season, episode) {
    season = season == null ? null : Number(season);
    episode = episode == null ? null : Number(episode);
    var isTv = mediaType === "tv";
    return tmdbTitle(tmdbId, mediaType).then(function (meta) {
      if (!meta) return [];
      var slug = slugify(meta.title, meta.year);
      var watchPath = isTv ? "/watch-series/" + slug + "/" : "/watch-movie/" + slug + "/";
      var watchUrl = SITE + watchPath;
      // 1) watch page (direct slug; fall back to search if it 404s)
      return textGet(watchUrl).then(function (html) {
        if (!html) {
          return textGet(SITE + "/search?q=" + encodeURIComponent(meta.title)).then(function (sh) {
            var found = findInSearch(sh, mediaType, meta.title, meta.year);
            if (!found) return [];
            return textGet(found);
          });
        }
        return html;
      }).then(function (pageHtml) {
        if (!pageHtml) return [];
        if (!isTv) return { pageHtml: pageHtml, pageUrl: watchUrl };
        // TV: find the episode link on the series page.
        var epRe = new RegExp("/episode/" + slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/s" + (season < 10 ? "0" + season : season) + "-e" + (episode < 10 ? "0" + episode : episode) + "/");
        var em = pageHtml.match(epRe);
        if (!em) return [];
        var epUrl = SITE + em[0];
        return textGet(epUrl).then(function (eh) {
          if (!eh) return [];
          return { pageHtml: eh, pageUrl: epUrl };
        });
      }).then(function (res) {
        if (!res || !res.pageHtml) return [];
        var token = extractToken(res.pageHtml);
        if (!token) return [];
        // 2) servers (movies: "players", TV: "players_show")
        return loadServers(res.pageUrl, token, isTv ? "players_show" : "players").then(function (servers) {
          var vm = vidmolyLink(servers);
          if (!vm) return [];
          // 3) Vidmoly embed -> HLS master
          return textGet(vm, res.pageUrl).then(function (eh) {
            var hls = extractVidmolyHls(eh);
            if (!hls) return [];
            return textGet(hls, vm).then(function (master) {
              var q = qualityFromMaster(master);
              return [toStream(hls, meta.title, mediaType, season, episode, q)];
            });
          });
        });
      });
    }).catch(function () { return []; });
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { getStreams: getStreams };
  if (typeof global !== "undefined") global.getStreams = getStreams;
})();
