// DoFlix Nuvio provider — ported from the DoFlixProvider CloudStream plugin
// (com.cncverse, v38, file DoFlixProvider.cs3). Two stream sources, both
// faithfully ported from the original decompiled code:
//
//  A. Dotflix — GET links.watchkar.com m2download cache
//     (type=movie|tv, key=movie_<tmdbId> | tv_<tmdbId>_s<season>_e<episode>)
//     -> data[] filtered to provider == "DOTFLIX" -> stablePageUrl
//     (dotflix.fit/share/<code>, a Next.js page) -> decodeFlight() decodes the
//     RSC flight payload -> "cloudflareFileUrl" (Fast) and "directLink"
//     (Direct). Direct links are Google usercontent files (verified: real
//     Matroska video data). Cache coverage is movies only in practice
//     (TV episodes miss); DOTFLIX entries exist for recent/popular titles.
//  PLAYABILITY (v1.0.2, user-verified): only the Fast (R2) links play in the
//  Nuvio app. The Direct googleusercontent links DO NOT play: that host
//  ignores Range requests (returns 200, no Accept-Ranges header, serves the
//  whole file from byte 0) and sends Content-Disposition: attachment, so the
//  player cannot seek/read the MKV index of a multi-GB file. The Fast R2
//  host answers 206 with Accept-Ranges: bytes. So this provider emits ONLY
//  Fast links from Dotflix (Direct is parsed but deliberately NOT emitted).
//  GDFlix/GDTot were tried in v1.0.1 and removed in v1.0.2: their pages are
//  Cloudflare/Turnstile-gated for fetch clients, the instant download is
//  disabled, and their file URLs resolve to the same unplayable
//  googleusercontent host anyway. Titles with no Fast link and no SuperStream
//  page (e.g. Spider-Man: Brand New Day, Project Hail Mary, The Matrix)
//  honestly return no streams from DoFlix.
//
//  B. SuperStream — TMDB external_ids -> imdb_id -> GET
//     jerso441ceg.com/play/<imdbId> -> playerConfig() extracts the balanced
//     JSON after "HDVBPlayer(" ({key: CSRF token, file: playlist path})
//     -> POST the file URL (X-CSRF-TOKEN, Referer, Origin) -> JSON array
//     -> TV drills child("id", season) -> child("episode", episode)
//     -> per item POST <origin>/playlist/<file~stripped>.txt -> the .m3u8 URL.
//     NOTE (2026-11-09): the playlist POST returns a bare number ("7" for a
//     valid key, "10" for a wrong one) from this VM, almost certainly because
//     the token is bound to the requesting IP and this VM's egress proxy
//     rotates IPs per request (the play page's embedded userIp changes on
//     every fetch). The chain is ported exactly as the original does it; it
//     needs the in-app test on a stable-IP device to confirm. The play page
//     + playerConfig steps are verified live from here.
//
// webOS-safe: no optional chaining, no matchAll, no RegExp.$1, guarded
// setTimeout (spin-wait fallback), season/episode coerced to numbers.
// Never throws: getStreams always resolves to an array (possibly empty).

var DOFLIX_TMDB_KEY = "d80ba92bc7cefe3359668d30d06f3305";
var DOFLIX_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
var DOFLIX_SS_ORIGIN = "https://jerso441ceg.com";
var DOFLIX_CACHE =
  "https://links.watchkar.com/m2download/m2download_cache.php";
var DOFLIX_TIMEOUT_MS = 12000;

function dooflixSleep(ms) {
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

function dooflixFetch(url, headers, timeoutMs, method, body) {
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
  return new Promise(function (resolve, reject) {
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
      if (method) opts.method = method;
      if (body !== undefined && body !== null) opts.body = body;
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
}

function dooflixGetText(url, headers, timeoutMs) {
  return dooflixFetch(url, headers, timeoutMs || DOFLIX_TIMEOUT_MS)
    .then(function (resp) {
      if (!resp || resp.status < 200 || resp.status >= 300) return null;
      return resp.text();
    })
    .then(function (t) {
      return t;
    })
    .catch(function () {
      return null;
    });
}

function dooflixGetJson(url, headers, timeoutMs) {
  return dooflixGetText(url, headers, timeoutMs).then(function (t) {
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch (e) {
      return null;
    }
  });
}

// Port of decodeFlight(): concatenates the JSON-decoded payloads of every
// self.__next_f.push([1,"..."]) segment (Next.js RSC flight data).
function dooflixDecodeFlight(text) {
  var out = "";
  try {
    if (!text) return out;
    var marker = 'self.__next_f.push([1,"';
    var idx = text.indexOf(marker);
    while (idx >= 0) {
      var start = idx + marker.length;
      var i = start;
      while (i < text.length && text.charAt(i) !== '"') {
        i += text.charAt(i) === "\\" ? 2 : 1;
      }
      if (i > text.length) break;
      try {
        var seg = text.substring(start, i);
        var arr = JSON.parse('["' + seg + '"]');
        out += arr[0];
      } catch (e) {}
      idx = text.indexOf(marker, i);
    }
  } catch (e) {}
  return out;
}

// Port of directLink(): finds "initialDownloadUrl"|"initialDirectLink"|
// "directLink":"<v>". Plain http value -> returned as-is. "$<name>" value ->
// the name is looked up as "<name>:T<hexlen>," and the next <hexlen> chars
// are the URL. Anything else -> null.
function dooflixDirectLink(decoded) {
  try {
    if (!decoded) return null;
    var m = decoded.match(
      /"(?:initialDownloadUrl|initialDirectLink|directLink)":"([^"]+)"/
    );
    if (!m) return null;
    var v = m[1];
    if (v.indexOf("http") === 0) return v;
    if (v.charAt(0) !== "$") return null;
    var name = v.substring(1);
    var esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    var re = new RegExp("(?:^|\\n|[^0-9a-f])" + esc + ":T([0-9a-f]+),");
    var m2 = decoded.match(re);
    if (!m2) return null;
    var len = parseInt(m2[1], 16);
    if (!len) return null;
    var start = m2.index + m2[0].length;
    var val = decoded.substring(start, Math.min(decoded.length, start + len));
    val = val.replace(/^\s+|\s+$/g, "");
    if (val.indexOf("http") === 0) return val;
    return null;
  } catch (e) {
    return null;
  }
}

// Port of playerConfig(): finds "let p3 =" or "HDVBPlayer(" in page text,
// then extracts the balanced {...} JSON object that follows it.
function dooflixPlayerConfig(text) {
  try {
    if (!text) return null;
    var m = text.match(/(?:let\s+p3\s*=|HDVBPlayer\()\s*/);
    if (!m) return null;
    var brace = text.indexOf("{", m.index + m[0].length);
    if (brace < 0) return null;
    var depth = 0;
    var quote = null;
    var i = brace;
    while (i < text.length) {
      var ch = text.charAt(i);
      if (quote === null) {
        if (ch === '"' || ch === "'") quote = ch;
        else if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            try {
              return JSON.parse(text.substring(brace, i + 1));
            } catch (e) {
              return null;
            }
          }
        }
      } else if (ch === quote && text.charAt(i - 1) !== "\\") {
        quote = null;
      }
      i++;
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Port of superStream$child(): first object in the array whose <field>
// equals <value>; returns its "folder" array (or null).
function dooflixChild(arr, field, value) {
  try {
    if (!arr) return null;
    for (var i = 0; i < arr.length; i++) {
      var obj = arr[i];
      if (obj && obj[field] === value) return obj.folder || null;
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Port of getQualityValue()'s label side: "1080P" -> "1080p", "FHD" -> "1080p",
// "HD" -> "720p", "SD" -> "480p", "4K" -> "2160p", else the raw string.
function dooflixQualityLabel(q) {
  try {
    if (!q) return "Unknown";
    var s = String(q).trim().toUpperCase();
    if (s === "4K") return "2160p";
    if (s === "FHD") return "1080p";
    if (s === "HD") return "720p";
    if (s === "SD") return "480p";
    var m = s.match(/^(\d{3,4})P$/);
    if (m) return m[1] + "p";
    return String(q).trim();
  } catch (e) {
    return "Unknown";
  }
}

// fixSpaces(): percent-encode spaces and square brackets in a URL.
function dooflixFixSpaces(u) {
  try {
    return String(u).split(" ").join("%20").split("[").join("%5B").split("]").join("%5D");
  } catch (e) {
    return u;
  }
}

function dooflixResolve(base, rel) {
  try {
    if (rel.indexOf("http://") === 0 || rel.indexOf("https://") === 0) return rel;
    if (rel.charAt(0) === "/") {
      var m = String(base).match(/^(https?:\/\/[^\/]+)/);
      if (m) return m[1] + rel;
      return rel;
    }
    var b = String(base);
    var cut = b.lastIndexOf("/");
    if (cut >= 0) b = b.substring(0, cut + 1);
    return b + rel;
  } catch (e) {
    return rel;
  }
}

function dooflixOriginOf(url) {
  try {
    var m = String(url).match(/^(https?:\/\/[^\/]+)/);
    return m ? m[1] : "";
  } catch (e) {
    return "";
  }
}
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

// ---- TMDB helpers (the provider's own key, as in the .cs3) ----

function dooflixTmdbTitle(tmdbId, isTv) {
  var kind = isTv ? "tv" : "movie";
  var url =
    "https://api.themoviedb.org/3/" +
    kind +
    "/" +
    tmdbId +
    "?api_key=" +
    DOFLIX_TMDB_KEY +
    "&language=en";
  return dooflixGetJson(url, {}, DOFLIX_TIMEOUT_MS).then(function (j) {
    if (!j) return "";
    return j.title || j.name || "";
  });
}

function dooflixImdbId(tmdbId, isTv) {
  var kind = isTv ? "tv" : "movie";
  var url =
    "https://api.themoviedb.org/3/" +
    kind +
    "/" +
    tmdbId +
    "/external_ids?api_key=" +
    DOFLIX_TMDB_KEY;
  return dooflixGetJson(url, {}, DOFLIX_TIMEOUT_MS).then(function (j) {
    if (!j || !j.imdb_id) return null;
    var id = String(j.imdb_id);
    if (id.indexOf("tt") !== 0) return null;
    return id;
  });
}

// ---- Source A: Dotflix (watchkar cache -> dotflix.fit share page) ----

function dooflixDotflix(tmdbId, isTv, season, episode, title, push) {
  var type = isTv ? "tv" : "movie";
  var key = isTv
    ? "tv_" + tmdbId + "_s" + season + "_e" + episode
    : "movie_" + tmdbId;
  var url =
    DOFLIX_CACHE +
    "?type=" +
    encodeURIComponent(type) +
    "&key=" +
    encodeURIComponent(key);
  return dooflixGetJson(url, { "User-Agent": DOFLIX_UA }, DOFLIX_TIMEOUT_MS).then(
    function (j) {
      if (!j || !j.data || !j.data.length) return;
      var seen = {};
      var pages = [];
      for (var i = 0; i < j.data.length; i++) {
        var e = j.data[i] || {};
        if (String(e.provider || "").toUpperCase() !== "DOTFLIX") continue;
        var page = e.stablePageUrl;
        if (!page || seen[page]) continue;
        seen[page] = true;
        pages.push({ page: page, quality: e.quality || "", size: e.size || "" });
      }
      if (!pages.length) return Promise.resolve();
      var jobs = pages.map(function (p) {
        return dooflixGetText(
          p.page,
          { "User-Agent": DOFLIX_UA, Referer: p.page },
          DOFLIX_TIMEOUT_MS
        ).then(function (html) {
          if (!html) return;
          var decoded = dooflixDecodeFlight(html);
          if (!decoded) return;
          var labelBase = {
            title: title,
            source: "DoFlix",
            season: isTv ? season : undefined,
            episode: isTv ? episode : undefined,
            size: p.size || undefined
          };
          // Fast: "cloudflareFileUrl":"https://..."
          var fm = decoded.match(/"cloudflareFileUrl":"(https?:\/\/[^"]+)"/);
          if (fm && fm[1]) {
            var fastUrl = dooflixFixSpaces(fm[1]);
            var fastLabel = formatStreamLabel({
              title: labelBase.title,
              quality: dooflixQualityLabel(p.quality),
              season: labelBase.season,
              episode: labelBase.episode,
              size: labelBase.size,
              source: "DoFlix",
              server: "Fast"
            });
            push({
              name: fastLabel,
              title: fastLabel,
              url: fastUrl,
              quality: dooflixQualityLabel(p.quality),
              headers: {},
              type: "mp4"
            });
          }
          // Direct: parsed (dooflixDirectLink) but DELIBERATELY NOT emitted.
          // The Direct googleusercontent host ignores Range requests and
          // sends Content-Disposition: attachment, so the Nuvio player
          // cannot seek/play these multi-GB MKV files (user-verified: Direct
          // never plays on any quality, Fast always does). Emitting them
          // would only show dead streams. See the header note (v1.0.2).
          dooflixDirectLink(decoded);
        });
      });
      return Promise.all(jobs).then(function () {});
    }
  );
}

// ---- Source B: SuperStream (jerso441ceg.com) ----

function dooflixSuperStream(tmdbId, isTv, season, episode, title, push) {
  return dooflixImdbId(tmdbId, isTv).then(function (imdbId) {
    if (!imdbId) return;
    var playUrl = DOFLIX_SS_ORIGIN + "/play/" + imdbId;
    var playHeaders = {
      "User-Agent": DOFLIX_UA,
      Referer: DOFLIX_SS_ORIGIN + "/"
    };
    return dooflixGetText(playUrl, playHeaders, DOFLIX_TIMEOUT_MS).then(function (
      html
    ) {
      if (!html) return;
      var cfg = dooflixPlayerConfig(html);
      if (!cfg || !cfg.key) return;
      var fileRaw = String(cfg.file || "").split("\\/").join("/");
      if (!fileRaw) return;
      var fileUrl = dooflixResolve(playUrl, fileRaw);
      var origin = dooflixOriginOf(fileUrl) || DOFLIX_SS_ORIGIN;
      var postHeaders = {
        "User-Agent": DOFLIX_UA,
        "X-CSRF-TOKEN": String(cfg.key),
        Referer: playUrl,
        Origin: DOFLIX_SS_ORIGIN
      };
      return dooflixFetch(fileUrl, postHeaders, DOFLIX_TIMEOUT_MS, "POST", "")
        .then(function (resp) {
          if (!resp || resp.status < 200 || resp.status >= 300) return null;
          return resp.text();
        })
        .catch(function () {
          return null;
        })
        .then(function (body) {
          if (!body) return;
          var arr = null;
          try {
            arr = JSON.parse(body);
          } catch (e) {
            return;
          }
          if (!arr || typeof arr.length !== "number") return;
          if (isTv) {
            arr = dooflixChild(arr, "id", String(season));
            if (!arr) return;
            arr = dooflixChild(arr, "episode", String(episode));
            if (!arr) return;
          }
          var jobs = [];
          for (var i = 0; i < arr.length; i++) {
            (function (item) {
              var f = item && item.file ? String(item.file) : "";
              if (f.charAt(0) === "~") f = f.substring(1);
              f = f.replace(/^\s+|\s+$/g, "");
              if (!f) return;
              var plistUrl = origin + "/playlist/" + f + ".txt";
              var ph = {
                "User-Agent": DOFLIX_UA,
                "X-CSRF-TOKEN": String(cfg.key),
                Referer: fileUrl,
                Origin: origin
              };
              jobs.push(
                dooflixFetch(plistUrl, ph, DOFLIX_TIMEOUT_MS, "POST", "")
                  .then(function (resp) {
                    if (!resp || resp.status < 200 || resp.status >= 300)
                      return null;
                    return resp.text();
                  })
                  .catch(function () {
                    return null;
                  })
                  .then(function (t) {
                    if (!t) return;
                    var u = t.replace(/^\s+|\s+$/g, "");
                    if (u.charAt(0) === '"' && u.charAt(u.length - 1) === '"')
                      u = u.substring(1, u.length - 1);
                    if (u.indexOf("http") !== 0) return;
                    var streamTitle =
                      item && item.title ? String(item.title) : "Multi";
                    // The item's "title" is its audio/language label
                    // (e.g. "Hindi"; "Multi" when several), as in the
                    // original provider's "SuperStream [<title>]" name.
                    var label = formatStreamLabel({
                      title: title,
                      quality: "Unknown",
                      season: isTv ? season : undefined,
                      episode: isTv ? episode : undefined,
                      audio: streamTitle && streamTitle !== "Multi" ? streamTitle : undefined,
                      source: "DoFlix",
                      server: "SuperStream"
                    });
                    push({
                      name: label,
                      title: label,
                      url: u,
                      quality: "Unknown",
                      headers: {
                        Referer: origin + "/",
                        Origin: origin,
                        "User-Agent": DOFLIX_UA
                      },
                      type: "hls"
                    });
                  })
              );
            })(arr[i]);
          }
          return Promise.all(jobs).then(function () {});
        });
    });
  });
}

// ---- Nuvio entry point ----

async function getStreams(tmdbId, mediaType, season, episode) {
  var out = [];
  function push(s) {
    if (!s || !s.url) return;
    for (var i = 0; i < out.length; i++) {
      if (out[i].url === s.url) return;
    }
    out.push(s);
  }
  try {
    var id = parseInt(tmdbId, 10);
    if (!id) return [];
    var isTv = mediaType === "tv";
    var sNum = parseInt(season, 10);
    var eNum = parseInt(episode, 10);
    if (isTv) {
      if (!sNum && sNum !== 0) sNum = 1;
      if (!eNum && eNum !== 0) eNum = 1;
    }
    var title = "";
    try {
      title = await dooflixTmdbTitle(id, isTv);
    } catch (e) {}
    var jobs = [
      dooflixDotflix(id, isTv, sNum, eNum, title, push),
      dooflixSuperStream(id, isTv, sNum, eNum, title, push)
    ];
    await Promise.all(
      jobs.map(function (p) {
        return p.catch(function () {});
      })
    );
    return out;
  } catch (e) {
    return out;
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams: getStreams };
}
if (typeof global !== "undefined") {
  global.getStreams = getStreams;
}
