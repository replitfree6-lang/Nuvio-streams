// ---------------------------------------------------------------------------
// MeowTV — Nuvio plugin (scraper) for https://meowtv.ru
// Movies, TV shows and anime, keyed directly by TMDB id (no site search).
//
// Flow (mirrors the site's own web client, api.meowtv.ru):
//   1. POST /streams/ticket {}            -> { ticket }
//      The ticket is bound to the caller's User-Agent (the site client
//      retries once on "ticket / signature / UA mismatch" errors), so one
//      fixed desktop UA is used for the ticket, the stream calls and the
//      emitted stream headers.
//   2. GET  /streams/movie/<tmdbId>?s=acme&list=1        (with ticket)
//      GET  /streams/tv/<tmdbId>/<season>/<episode>?s=acme&list=1
//        -> { streams: [{ language, url, headers }] }
//   3. GET  /streams/... ?s=<sourceId> for the site's other sources
//      (dcloud, tik "TCloud", ipcloud, english, hindi, turkce [movies])
//        -> { language, url, headers }
//   4. GET  /subs/movie/<tmdbId>  or  /subs/tv/<tmdbId>/<s>/<e>
//        -> [{ label, file }] — attached to every stream as subtitles.
//      (This endpoint needs no ticket.)
//
// Not used, deliberately:
//   - The site's FebBox source: it requires the viewer's OWN FebBox
//     account token (the API answers "Febbox token not set" without one),
//     and a Nuvio scraper has no way to ask for it.
//   - The VidSrc iframe embed the website shows in browsers: it is an
//     embed page, not a direct stream, so Nuvio cannot play it as-is.
//
// Platform notes (from earlier webOS work): no optional chaining /
// matchAll etc., every setTimeout use is guarded (that runtime has none),
// string season/episode arguments are coerced to numbers.
// ---------------------------------------------------------------------------

var API = "https://api.meowtv.ru";
var SITE = "https://meowtv.ru";
var TMDB_KEY = "1865f43a0549ca50d341dd9ab8b29f49";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
var HTTP_TIMEOUT_MS = 12000;

// Sources in the site's own server-list order, with Dcloud first (it is
// the site's default server). The "acme" list call returns that source's
// language variants (Hindi / Tamil / Telugu dubs) in one response.
// turkce is movie-only.
var SOURCES = [
    { id: "dcloud", label: "Dcloud" },
    { id: "acme", label: "Acme", list: true },
    { id: "tik", label: "TCloud" },
    { id: "ipcloud", label: "IPcloud" },
    { id: "turkce", label: "Türkçe", movieOnly: true },
    { id: "hindi", label: "Hindi" },
    { id: "english", label: "English" },
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isBlank(s) {
    return s == null || String(s).trim() === "";
}

function qualityFromText(text, url) {
    var hay = (String(text || "") + " " + String(url || "")).toLowerCase();
    if (hay.indexOf("2160") > -1 || hay.indexOf("4k") > -1) return "2160p";
    if (hay.indexOf("1440") > -1) return "1440p";
    if (hay.indexOf("1080") > -1) return "1080p";
    if (hay.indexOf("720") > -1) return "720p";
    if (hay.indexOf("480") > -1) return "480p";
    if (hay.indexOf("360") > -1) return "360p";
    return "Auto";
}

function timeoutSignal(ms) {
    try {
        if (typeof AbortController === "undefined") return undefined;
        var ctl = new AbortController();
        if (typeof setTimeout === "function") {
            setTimeout(function () { try { ctl.abort(); } catch (e) {} }, ms);
        }
        return ctl.signal;
    } catch (e) {
        return undefined;
    }
}

async function httpJson(url, opts) {
    opts = opts || {};
    var headers = {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Origin": SITE,
        "Referer": SITE + "/",
    };
    if (opts.headers) for (var k in opts.headers) headers[k] = opts.headers[k];
    var init = {
        method: opts.method || "GET",
        headers: headers,
        redirect: "follow",
        signal: timeoutSignal(opts.timeoutMs || HTTP_TIMEOUT_MS),
    };
    if (opts.body != null) {
        headers["Content-Type"] = "application/json";
        init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    }
    var res = await fetch(url, init);
    var text = await res.text();
    var json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { status: res.status, text: text, json: json };
}

// ---------------------------------------------------------------------------
// Stream ticket (UA-bound; retry once on ticket/signature/UA errors —
// the same recovery the site's own client performs)
// ---------------------------------------------------------------------------

var __ticket = null;

async function mintTicket() {
    try {
        var r = await httpJson(API + "/streams/ticket", { method: "POST", body: {} });
        if (r.json && typeof r.json.ticket === "string" && r.json.ticket) {
            __ticket = r.json.ticket;
            return __ticket;
        }
    } catch (e) {}
    return null;
}

async function streamsCall(path) {
    if (!__ticket) await mintTicket();
    var attempt = async function () {
        return await httpJson(API + path, {
            headers: __ticket ? { "x-stream-ticket": __ticket } : {},
        });
    };
    var r = await attempt();
    var msg = "";
    if (r.json && typeof r.json.error === "string") msg = r.json.error;
    else if (r.text) msg = r.text.slice(0, 120);
    if ((r.status === 401 || r.status === 403) && /ticket|signature|ua mismatch/i.test(msg)) {
        __ticket = null;
        await mintTicket();
        r = await attempt();
    }
    return r;
}

// ---------------------------------------------------------------------------
// Response shapes (from the site's client code):
//   list:   { streams: [{ language, url, headers }] }
//   single: { language, url, headers } (possibly wrapped in data/stream)
//   subs:   [{ label, file }]
// ---------------------------------------------------------------------------

function unwrapStream(obj) {
    if (!obj || typeof obj !== "object") return null;
    if (typeof obj.url === "string" && obj.url) return obj;
    if (obj.stream && typeof obj.stream === "object") return unwrapStream(obj.stream);
    if (obj.data && typeof obj.data === "object") return unwrapStream(obj.data);
    return null;
}

function collectStreams(json, sourceLabel) {
    var out = [];
    if (!json || typeof json !== "object") return out;
    var arr = null;
    if (Array.isArray(json.streams)) arr = json.streams;
    else if (Array.isArray(json)) arr = json;
    if (arr) {
        for (var i = 0; i < arr.length; i++) {
            var u = unwrapStream(arr[i]);
            if (u) out.push({ url: u.url, language: u.language || sourceLabel, headers: u.headers || {} });
        }
        return out;
    }
    var single = unwrapStream(json);
    if (single) out.push({ url: single.url, language: single.language || sourceLabel, headers: single.headers || {} });
    return out;
}

async function fetchSubtitles(type, tmdbId, season, episode) {
    var path = type === "movie"
        ? "/subs/movie/" + tmdbId
        : "/subs/tv/" + tmdbId + "/" + season + "/" + episode;
    try {
        var r = await httpJson(API + path, {});
        if (r.status === 200 && Array.isArray(r.json)) {
            var subs = [];
            for (var i = 0; i < r.json.length && subs.length < 50; i++) {
                var it = r.json[i];
                if (it && typeof it.file === "string" && it.file) {
                    subs.push({ url: it.file, language: it.label || "Unknown" });
                }
            }
            return subs;
        }
    } catch (e) {}
    return [];
}

async function tmdbDisplayTitle(tmdbId, type) {
    try {
        var kind = type === "movie" ? "movie" : "tv";
        var r = await httpJson("https://api.themoviedb.org/3/" + kind + "/" + tmdbId + "?api_key=" + TMDB_KEY, {
            headers: { "Origin": "", "Referer": "" },
        });
        if (r.json) return r.json.title || r.json.name || null;
    } catch (e) {}
    return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function getStreams(tmdbId, mediaType, season, episode) {
    var out = [];
    try {
        var type = mediaType === "movie" ? "movie" : "tv";
        var sNum = season == null || season === "" ? 1 : parseInt(season, 10);
        var eNum = episode == null || episode === "" ? 1 : parseInt(episode, 10);
        if (isNaN(sNum)) sNum = 1;
        if (isNaN(eNum)) eNum = 1;

        var base = type === "movie"
            ? "/streams/movie/" + tmdbId
            : "/streams/tv/" + tmdbId + "/" + sNum + "/" + eNum;

        var title = await tmdbDisplayTitle(tmdbId, type);
        var displayTitle = title
            ? title + (type === "movie" ? "" : " S" + sNum + "E" + eNum)
            : "TMDB " + tmdbId + (type === "movie" ? "" : " S" + sNum + "E" + eNum);

        var subtitles = await fetchSubtitles(type, tmdbId, sNum, eNum);

        var seen = {};
        function emit(item, sourceLabel) {
            if (!item || !item.url || seen[item.url]) return;
            seen[item.url] = true;
            var headers = { "User-Agent": UA, "Referer": SITE + "/" };
            if (item.headers && typeof item.headers === "object") {
                for (var k in item.headers) headers[k] = item.headers[k];
            }
            var lang = item.language && item.language !== sourceLabel ? item.language : null;
            var st = {
                name: "MeowTV • " + sourceLabel + (lang ? " • " + lang : ""),
                title: displayTitle,
                url: item.url,
                quality: qualityFromText(lang || "", item.url),
                headers: headers,
            };
            if (/\.m3u8(\?|#|$)/i.test(item.url)) st.type = "m3u8";
            if (subtitles.length) st.subtitles = subtitles;
            out.push(st);
        }

        for (var i = 0; i < SOURCES.length; i++) {
            var src = SOURCES[i];
            if (src.movieOnly && type !== "movie") continue;
            var path = base + "?s=" + encodeURIComponent(src.id) + (src.list ? "&list=1" : "");
            var r = null;
            try { r = await streamsCall(path); } catch (e) { r = null; }
            if (!r || r.status !== 200 || !r.json) continue;
            var items = collectStreams(r.json, src.label);
            for (var j = 0; j < items.length; j++) emit(items[j], src.label);
        }
    } catch (err) {
        // Return whatever was collected; a scraper must not throw.
    }
    return out;
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { getStreams: getStreams };
} else {
    global.getStreams = getStreams;
}
