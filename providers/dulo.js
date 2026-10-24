// ---------------------------------------------------------------------------
// Dulo — Nuvio plugin (scraper) for https://dulo.mov
// Movies, TV shows and anime, keyed directly by TMDB id (no site search).
//
// Flow (mirrors the site's own web client, minus its proxy transport —
// the first-party endpoint below answers plain requests directly):
//   GET https://dulo.mov/api/streams/resolve
//       ?tmdbId=<id>&type=movie|tv&progressive=true
//       [&seasonId=<s>&episodeId=<e>] [&title=&year=&runtime=]
//     -> { found: true, pending: false, sources: [
//          { label, url, type, captions: [
//              { id, url, language, display, format, hearingImpaired } ] } ] }
//
// Source kinds (observed live):
//   - "Pickle · 4K": the site's own CDN (.m3u8 on zcdn.bluevelvet.space).
//     For the titles probed it currently serves a short promo clip
//     rather than the feature, so it is emitted LAST.
//   - The other sources (Prime, Zenith, Chandra, Breeze, ...): HLS
//     playlists served through the site's stream proxy
//     (zstream-proxy.bluevelvet.space/?payload=...&headers=...). The
//     proxy URLs are plain GETs: the master playlist and its segments
//     are all proxy URLs, so any HLS player can follow them.
// Captions from the response are attached to every stream as subtitles.
//
// Platform notes (from earlier webOS work): no optional chaining /
// matchAll etc., every setTimeout use is guarded (that runtime has
// none), string season/episode arguments are coerced to numbers.
// ---------------------------------------------------------------------------

var API = "https://dulo.mov";
var TMDB_KEY = "1865f43a0549ca50d341dd9ab8b29f49";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
var RESOLVE_TIMEOUT_MS = 24000;
var TMDB_TIMEOUT_MS = 12000;

function isBlank(s) {
    return s == null || String(s).trim() === "";
}

function qualityFromLabel(label) {
    var m = String(label || "").match(/\b(2160|1440|1080|720|480|360)\s*p\b/i);
    if (m) return m[1] + "p";
    if (/\b4K\b/i.test(String(label || ""))) return "2160p";
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

function sleepGuarded(ms) {
    return new Promise(function (resolve) {
        try {
            if (typeof setTimeout === "function") { setTimeout(resolve, ms); return; }
        } catch (e) {}
        var end = Date.now() + ms;
        while (Date.now() < end) { /* spin-wait: webOS has no setTimeout */ }
        resolve();
    });
}

async function httpJson(url, timeoutMs, referer) {
    var headers = {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Referer": referer || API + "/",
    };
    var res = await fetch(url, {
        method: "GET",
        headers: headers,
        redirect: "follow",
        signal: timeoutSignal(timeoutMs),
    });
    var text = await res.text();
    var json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { status: res.status, text: text, json: json };
}

async function tmdbDetails(tmdbId, type) {
    try {
        var kind = type === "movie" ? "movie" : "tv";
        var r = await httpJson("https://api.themoviedb.org/3/" + kind + "/" + tmdbId + "?api_key=" + TMDB_KEY, TMDB_TIMEOUT_MS, "");
        if (r.json) return r.json;
    } catch (e) {}
    return null;
}

async function resolveStreams(tmdbId, type, season, episode, meta) {
    var qs = "tmdbId=" + encodeURIComponent(tmdbId) + "&type=" + type + "&progressive=true";
    if (type === "tv") {
        qs += "&seasonId=" + season + "&episodeId=" + episode;
    }
    if (meta) {
        if (meta.title) qs += "&title=" + encodeURIComponent(meta.title);
        if (meta.year) qs += "&year=" + encodeURIComponent(meta.year);
        if (meta.runtime) qs += "&runtime=" + encodeURIComponent(Math.round(meta.runtime));
    }
    var url = API + "/api/streams/resolve?" + qs;
    var referer = API + "/watch/" + type + "/" + tmdbId;
    // The endpoint long-polls while pending: like the site's client, keep
    // polling and merge sources by label until it stops pending (bounded
    // so the app's Test is never left hanging).
    var merged = [];
    var mergedLabels = {};
    var deadline = Date.now() + 15000;
    var pending = true;
    while (pending && Date.now() < deadline) {
        var r = null;
        try { r = await httpJson(url, RESOLVE_TIMEOUT_MS, referer); } catch (e) { r = null; }
        if (r && r.json && Array.isArray(r.json.sources)) {
            for (var i = 0; i < r.json.sources.length; i++) {
                var s = r.json.sources[i];
                if (s && s.label && !mergedLabels[s.label]) {
                    mergedLabels[s.label] = true;
                    merged.push(s);
                }
            }
        }
        pending = !!(r && r.json && r.json.pending);
        if (!pending) break;
        if (Date.now() + 2000 >= deadline) break;
        await sleepGuarded(2000);
    }
    return { found: merged.length > 0, sources: merged };
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

        var details = await tmdbDetails(tmdbId, type);
        var meta = null;
        var displayTitle = "TMDB " + tmdbId;
        if (details) {
            var t = details.title || details.name || null;
            var y = null;
            var rd = details.release_date || details.first_air_date || "";
            if (rd && rd.length >= 4) y = rd.slice(0, 4);
            meta = { title: t, year: y, runtime: details.runtime || null };
            if (t) displayTitle = t + (type === "movie" ? "" : " S" + sNum + "E" + eNum);
        }

        var data = await resolveStreams(tmdbId, type, sNum, eNum, meta);
        if (!data || !Array.isArray(data.sources)) return out;

        // Emit the proxy sources first (verified to carry the feature);
        // Pickle last — for the titles probed it serves a short promo.
        var ordered = [];
        var pickle = [];
        for (var i = 0; i < data.sources.length; i++) {
            var s = data.sources[i];
            if (!s || typeof s.url !== "string" || !s.url) continue;
            if (/^Pickle\b/i.test(s.label || "")) pickle.push(s);
            else ordered.push(s);
        }
        var all = ordered.concat(pickle);

        var seen = {};
        for (var j = 0; j < all.length; j++) {
            var src = all[j];
            if (seen[src.url]) continue;
            seen[src.url] = true;
            var st = {
                name: "Dulo • " + (src.label || "Stream"),
                title: displayTitle,
                url: src.url,
                quality: qualityFromLabel(src.label),
                headers: { "User-Agent": UA, "Referer": API + "/" },
            };
            var t2 = src.type;
            if (t2 === "mp4" || t2 === "mkv" || t2 === "webm") st.type = t2;
            else st.type = "m3u8";
            if (Array.isArray(src.captions) && src.captions.length) {
                var subs = [];
                for (var k = 0; k < src.captions.length; k++) {
                    var c = src.captions[k];
                    if (c && typeof c.url === "string" && c.url) {
                        subs.push({ url: c.url, language: c.display || c.language || "Unknown" });
                    }
                }
                if (subs.length) st.subtitles = subs;
            }
            out.push(st);
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
