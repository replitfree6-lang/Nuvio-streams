// ---------------------------------------------------------------------------
// NEPU — Nuvio plugin (scraper) for https://nepu.io ("NEPU Stream")
// Movies, TV shows, cartoons and anime (sub & dub editions are separate
// catalogue entries on the site; matching editions are merged, labelled).
//
// Flow (mirrors the site's own pages and its theme script, detail.js):
//   TMDB id -> TMDB titles -> GET /search/<title> -> result cards
//   -> movie page (is the watch page) or show page + /season/<s>/episode/<e>
//   -> each source button carries data-embed="<id>"
//   -> POST /ajax/embed {id} returns the player HTML (Plyr/PlayerJS markup)
//   -> media URLs are read from <source src>, "file":"..." configs or bare
//      .m3u8/.mp4/.txt URLs in that HTML; <track> elements become subtitles.
//
// Platform notes (learned from the webOS TV runtime during earlier work):
//   - No optional chaining / nullish coalescing / matchAll etc. — the TV
//     QuickJS build is old.
//   - setTimeout may be ABSENT on that runtime: every use is guarded.
//   - Set-Cookie may be hidden from fetch responses there: the cookie jar
//     below tries getSetCookie(), headers.get() and a full header scan,
//     and simply stays empty when the runtime hides them all (the site
//     serves its media without credentials, so this is best-effort).
// ---------------------------------------------------------------------------

var BASE = "https://nepu.io";
var TMDB_KEY = "1865f43a0549ca50d341dd9ab8b29f49";
var DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
var HTTP_TIMEOUT_MS = 12000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isBlank(s) {
    return s == null || String(s).trim() === "";
}

function decodeEntities(s) {
    return String(s)
        .split("&amp;").join("&")
        .split("&lt;").join("<")
        .split("&gt;").join(">")
        .split("&quot;").join('"')
        .split("&#039;").join("'")
        .split("&apos;").join("'");
}

function stripTags(s) {
    return decodeEntities(String(s).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function normaliseTitle(s) {
    return String(s == null ? "" : s)
        .toLowerCase()
        .replace(/\[[^\]]*\]/g, " ")           // [SUB] [DUB] [4K] ...
        .replace(/\((?:19|20)\d{2}\)/g, " ")   // trailing (year)
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function editionTag(rawTitle) {
    var m = /\[([^\]]+)\]/.exec(String(rawTitle == null ? "" : rawTitle));
    if (!m) return null;
    var t = m[1].trim().toUpperCase();
    if (t === "SUB" || t === "DUB" || t === "4K" || t === "3D" || t === "FULL HD" || t === "HD") return t;
    return null;
}

function absolutise(url, baseUrl) {
    if (isBlank(url)) return null;
    var u = String(url).trim();
    if (/^https?:\/\//i.test(u)) return u;
    if (u.indexOf("//") === 0) return "https:" + u;
    var origin = /^https?:\/\/[^/]+/.exec(baseUrl || BASE);
    var o = origin ? origin[0] : BASE;
    if (u.charAt(0) === "/") return o + u;
    return o + "/" + u;
}

function qualityFromText(text, url) {
    var hay = (String(text || "") + " " + String(url || "")).toLowerCase();
    if (hay.indexOf("2160") > -1 || hay.indexOf("4k") > -1) return "2160p";
    if (hay.indexOf("1440") > -1) return "1440p";
    if (hay.indexOf("1080") > -1 || hay.indexOf("full hd") > -1 || hay.indexOf("fullhd") > -1) return "1080p";
    if (hay.indexOf("720") > -1 || /\bhd\b/.test(hay)) return "720p";
    if (hay.indexOf("480") > -1) return "480p";
    if (hay.indexOf("360") > -1) return "360p";
    return "Auto";
}

// ---------------------------------------------------------------------------
// HTTP with a best-effort cookie jar and a guarded timeout
// ---------------------------------------------------------------------------

var cookieJar = {}; // host -> { name: value }

function jarStore(url, res) {
    try {
        var host = (/^https?:\/\/([^/]+)/.exec(url) || [])[1];
        if (!host || !res || !res.headers) return;
        var raw = [];
        if (typeof res.headers.getSetCookie === "function") {
            var arr = res.headers.getSetCookie();
            for (var i = 0; i < arr.length; i++) raw.push(arr[i]);
        }
        var single = null;
        try { single = res.headers.get("set-cookie"); } catch (e) {}
        if (single) raw.push(single);
        if (!raw.length && typeof res.headers.forEach === "function") {
            res.headers.forEach(function (v, k) {
                if (String(k).toLowerCase() === "set-cookie") raw.push(String(v));
            });
        }
        if (!cookieJar[host]) cookieJar[host] = {};
        for (var j = 0; j < raw.length; j++) {
            var pair = String(raw[j]).split(";")[0];
            var eq = pair.indexOf("=");
            if (eq > 0) cookieJar[host][pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
        }
    } catch (e) {}
}

function jarHeader(url) {
    var host = (/^https?:\/\/([^/]+)/.exec(url) || [])[1];
    var jar = host ? cookieJar[host] : null;
    if (!jar) return null;
    var parts = [];
    for (var k in jar) parts.push(k + "=" + jar[k]);
    return parts.length ? parts.join("; ") : null;
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

async function httpRequest(url, opts) {
    opts = opts || {};
    var headers = { "User-Agent": DESKTOP_UA, "Accept": "*/*" };
    if (opts.headers) for (var k in opts.headers) headers[k] = opts.headers[k];
    var cookie = jarHeader(url);
    if (cookie && !headers["Cookie"]) headers["Cookie"] = cookie;
    var init = {
        method: opts.method || "GET",
        headers: headers,
        redirect: "follow",
        signal: timeoutSignal(opts.timeoutMs || HTTP_TIMEOUT_MS),
    };
    if (opts.body != null) init.body = opts.body;
    var res = await fetch(url, init);
    jarStore(url, res);
    var text = await res.text();
    return { status: res.status, url: res.url || url, text: text };
}

async function httpGetText(url, opts) {
    try {
        var r = await httpRequest(url, opts || {});
        return r;
    } catch (e) {
        return null;
    }
}

// ---------------------------------------------------------------------------
// TMDB — resolve the id Nuvio hands us into candidate titles + year
// ---------------------------------------------------------------------------

async function tmdbTitles(tmdbId, mediaType) {
    var kind = mediaType === "movie" ? "movie" : "tv";
    var out = [];
    var seen = {};
    function push(title, year) {
        if (isBlank(title)) return;
        var key = normaliseTitle(title);
        if (!key || seen[key]) return;
        seen[key] = true;
        out.push({ title: String(title).trim(), year: year || null });
    }
    try {
        var det = await httpGetText("https://api.themoviedb.org/3/" + kind + "/" + tmdbId + "?api_key=" + TMDB_KEY, {});
        if (det && det.text) {
            var j = JSON.parse(det.text);
            var dateStr = j.release_date || j.first_air_date || "";
            var yearM = /^(\d{4})/.exec(dateStr);
            var year = yearM ? parseInt(yearM[1], 10) : null;
            push(j.title || j.name, year);
            push(j.original_title || j.original_name, year);
        }
    } catch (e) {}
    try {
        var alt = await httpGetText("https://api.themoviedb.org/3/" + kind + "/" + tmdbId + "/alternative_titles?api_key=" + TMDB_KEY, {});
        if (alt && alt.text) {
            var aj = JSON.parse(alt.text);
            var list = aj.titles || aj.results || [];
            var latin = [], other = [];
            for (var i = 0; i < list.length; i++) {
                var t = list[i] && (list[i].title || list[i].name);
                if (isBlank(t)) continue;
                if (/[^\x00-\x7F]/.test(t)) other.push(t); else latin.push(t);
            }
            var yr = out.length ? out[0].year : null;
            for (var a = 0; a < latin.length; a++) push(latin[a], yr);
            for (var b = 0; b < other.length; b++) push(other[b], yr);
        }
    } catch (e) {}
    return out.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Site search — result cards
// Card markup (from the site's listing template):
//   <a class="list-title" href="https://nepu.io/movie/<slug>">Title (YYYY)</a>
//   hrefs point at /movie/<slug>, /show/<slug> or /serie/<slug>.
// ---------------------------------------------------------------------------

function parseSearchCards(html) {
    var cards = [];
    if (!html) return cards;
    var seen = {};
    function addCard(href, km, text) {
        var abs = absolutise(href, BASE);
        if (!abs || seen[abs]) return;
        seen[abs] = true;
        var yearM = /\(((?:19|20)\d{2})\)/.exec(text);
        var slugYearM = /-((?:19|20)\d{2})(?:-|$)/.exec(km[2]);
        cards.push({
            href: abs,
            kind: km[1].toLowerCase() === "movie" ? "movie" : "tv",
            rawTitle: text,
            title: text.replace(/\s*\((?:(?:19|20)\d{2}|unknown)\)\s*$/i, "").trim(),
            year: yearM ? parseInt(yearM[1], 10) : (slugYearM ? parseInt(slugYearM[1], 10) : null),
            edition: editionTag(text),
        });
    }
    var m;
    // Pass 1: the caption anchors (class "list-title") carry the real
    // "Title (YYYY)" text. The poster anchor for the same card comes first
    // in the markup but its text is just the IMDb rating — never use it.
    var reTitle = /<a\b[^>]*class="[^"]*list-title[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    var reHref = /href="([^"]+)"/;
    while ((m = reTitle.exec(html)) !== null) {
        var openTag = m[0].slice(0, m[0].indexOf(">") + 1);
        var hm = reHref.exec(openTag);
        if (!hm) continue;
        var href1 = decodeEntities(hm[1]);
        var km1 = /\/(movie|show|serie)\/([a-z0-9][a-z0-9-]*)/i.exec(href1);
        if (!km1) continue;
        var text1 = stripTags(m[1]);
        if (isBlank(text1)) continue;
        addCard(href1, km1, text1);
    }
    if (cards.length) return cards;
    // Pass 2 (fallback for markup variants): any content anchor whose text
    // looks like a title (not a rating number, not a button label).
    var re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = re.exec(html)) !== null) {
        var href = decodeEntities(m[1]);
        var km = /\/(movie|show|serie)\/([a-z0-9][a-z0-9-]*)/i.exec(href);
        if (!km) continue;
        var text = stripTags(m[2]);
        if (isBlank(text) || text.length < 3) continue;
        if (/^\d+(\.\d+)?$/.test(text)) continue;
        if (/^(play|watch|view|details)$/i.test(text)) continue;
        addCard(href, km, text);
    }
    return cards;
}

async function searchSite(query) {
    var r = await httpGetText(BASE + "/search/" + encodeURIComponent(query), {
        headers: { "Accept": "text/html,application/xhtml+xml" },
    });
    if (!r || r.status >= 400) return [];
    if (r.text && r.text.indexOf("Just a moment") > -1 && r.text.indexOf("list-title") === -1) return [];
    return parseSearchCards(r.text);
}

// Pick the catalogue entries that match the requested title/type/year.
// [SUB]/[DUB] editions of the same work are separate entries — keep them
// all (streams get labelled), but never cross movie<->series.
function pickEntries(cards, wantTitle, wantYear, mediaType) {
    var wantKind = mediaType === "movie" ? "movie" : "tv";
    var wantNorm = normaliseTitle(wantTitle);
    var exact = [];
    for (var i = 0; i < cards.length; i++) {
        var c = cards[i];
        if (c.kind !== wantKind) continue;
        if (normaliseTitle(c.title) !== wantNorm) continue;
        if (wantYear != null && c.year != null && c.year !== wantYear) continue;
        exact.push(c);
    }
    return exact;
}

// ---------------------------------------------------------------------------
// Watch page -> source buttons (data-embed ids with labels)
// ---------------------------------------------------------------------------

function parseEmbedSources(html) {
    var out = [];
    if (!html) return out;
    var seen = {};
    var re = /<a\b[^>]*data-embed="(\d+)"[^>]*>([\s\S]*?)<\/a>/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
        var id = m[1];
        if (seen[id]) continue;
        seen[id] = true;
        var chunk = m[2] || "";
        var label = null;
        var nameM = /class="name"[^>]*>([^<]+)</.exec(chunk);
        if (nameM) label = stripTags(nameM[1]);
        if (isBlank(label)) {
            var selM = /class="source-selected"[^>]*>([\s\S]*?)<\//.exec(chunk);
            if (selM) label = stripTags(selM[1]);
        }
        if (isBlank(label)) {
            var plain = stripTags(chunk)
                .replace(/source\s*:/gi, " ")
                .replace(/available\s*:[^]*?(?=\s{2,}|$)/gi, " ")
                .replace(/\s+/g, " ").trim();
            if (plain && plain.length <= 40) label = plain;
        }
        out.push({ id: id, label: label || ("Source " + (out.length + 1)) });
    }
    // Fallback: bare data-embed attributes outside anchors.
    if (!out.length) {
        var re2 = /data-embed="(\d+)"/g;
        while ((m = re2.exec(html)) !== null) {
            if (!seen[m[1]]) {
                seen[m[1]] = true;
                out.push({ id: m[1], label: "Source " + (out.length + 1) });
            }
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// /ajax/embed response -> media URLs + subtitles
// ---------------------------------------------------------------------------

function parseEmbedMedia(html, baseUrl) {
    var media = [];
    var subs = [];
    var seen = {};
    if (!html) return { media: media, subs: subs, iframe: null };
    function pushMedia(u, hint) {
        var abs = absolutise(u, baseUrl);
        if (!abs || seen[abs]) return;
        if (!/\.(m3u8|mp4|txt)(\?|#|$)/i.test(abs) && abs.indexOf("/hls/") === -1 && abs.indexOf("playlist") === -1) return;
        seen[abs] = true;
        media.push({ url: abs, hint: hint || "" });
    }
    var m;
    var reSrc = /<source\b[^>]*\b(?:src|data-src)="([^"]+)"/gi;
    while ((m = reSrc.exec(html)) !== null) pushMedia(m[1], m[0]);
    var reFile = /["']?file["']?\s*:\s*["']([^"']+)["']/g;
    while ((m = reFile.exec(html)) !== null) pushMedia(m[1], "file");
    var reBare = /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4|txt)(?:\?[^\s"'<>\\]*)?/gi;
    while ((m = reBare.exec(html)) !== null) pushMedia(m[0], "bare");
    var reTrack = /<track\b[^>]*>/gi;
    while ((m = reTrack.exec(html)) !== null) {
        var tag = m[0];
        if (!/kind="(subtitles|captions)"/i.test(tag) && tag.indexOf("kind=") > -1) continue;
        var srcM = /\bsrc="([^"]+)"/.exec(tag);
        if (!srcM) continue;
        var labM = /\blabel="([^"]+)"/.exec(tag);
        var langM = /\bsrclang="([^"]+)"/.exec(tag);
        var absSub = absolutise(srcM[1], baseUrl);
        if (absSub) subs.push({ url: absSub, language: labM ? decodeEntities(labM[1]) : (langM ? langM[1] : "Unknown") });
    }
    var iframe = null;
    var reIframe = /<iframe\b[^>]*\bsrc="([^"]+)"/i.exec(html);
    if (reIframe) iframe = absolutise(reIframe[1], baseUrl);
    return { media: media, subs: subs, iframe: iframe };
}

async function fetchEmbedMedia(embedId, watchUrl) {
    var r = null;
    try {
        r = await httpRequest(BASE + "/ajax/embed", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "X-Requested-With": "XMLHttpRequest",
                "Referer": watchUrl,
                "Accept": "text/html, */*",
            },
            body: "id=" + encodeURIComponent(embedId),
        });
    } catch (e) {
        return { media: [], subs: [] };
    }
    if (!r || r.status >= 400 || !r.text) return { media: [], subs: [] };
    var parsed = parseEmbedMedia(r.text, watchUrl);
    if (!parsed.media.length && parsed.iframe) {
        // Some sources answer with a nested player page — scan one level in.
        var inner = await httpGetText(parsed.iframe, { headers: { "Referer": watchUrl } });
        if (inner && inner.text) {
            var again = parseEmbedMedia(inner.text, parsed.iframe);
            parsed.media = again.media;
            if (!parsed.subs.length) parsed.subs = again.subs;
        }
    }
    return parsed;
}

// ---------------------------------------------------------------------------
// Collect streams for one catalogue entry
// ---------------------------------------------------------------------------

async function streamsForEntry(entry, mediaType, season, episode, displayTitle) {
    var watchUrl = entry.href;
    if (mediaType !== "movie") {
        // Series entries link at /serie/<slug> or /show/<slug>; the show
        // page's canonical URL is the base for episode paths.
        var showPage = await httpGetText(entry.href, { headers: { "Accept": "text/html,application/xhtml+xml" } });
        var base = showPage && showPage.url ? showPage.url : entry.href;
        base = base.split("?")[0].replace(/\/+$/, "");
        base = base.replace("/serie/", "/show/");
        watchUrl = base + "/season/" + season + "/episode/" + episode;
    }
    var page = await httpGetText(watchUrl, { headers: { "Accept": "text/html,application/xhtml+xml", "Referer": BASE + "/" } });
    if (!page || page.status >= 400 || !page.text) return [];
    var finalWatchUrl = page.url || watchUrl;

    var streams = [];
    var seenUrls = {};
    function emit(url, name, quality, subs) {
        if (seenUrls[url]) return;
        seenUrls[url] = true;
        var st = {
            name: name,
            title: displayTitle,
            url: url,
            quality: quality || "Auto",
            headers: { "Referer": finalWatchUrl, "User-Agent": DESKTOP_UA },
        };
        if (/\.(m3u8|txt)(\?|#|$)/i.test(url) || url.indexOf("/hls/") > -1) st.type = "m3u8";
        if (subs && subs.length) st.subtitles = subs;
        streams.push(st);
    }

    var sources = parseEmbedSources(page.text);
    if (!sources.length) {
        // Some pages may carry the player inline — scan the page itself.
        var inline = parseEmbedMedia(page.text, finalWatchUrl);
        for (var i = 0; i < inline.media.length; i++) {
            emit(inline.media[i].url, "NEPU" + (entry.edition ? " " + entry.edition : ""), qualityFromText(entry.rawTitle, inline.media[i].url), inline.subs);
        }
        return streams;
    }

    var capped = sources.slice(0, 6);
    for (var s = 0; s < capped.length; s++) {
        var got = await fetchEmbedMedia(capped[s].id, finalWatchUrl);
        for (var j = 0; j < got.media.length; j++) {
            var labelParts = ["NEPU"];
            if (entry.edition) labelParts.push(entry.edition);
            if (capped[s].label && capped[s].label.indexOf("Source") !== 0) labelParts.push(capped[s].label);
            if (got.media.length > 1) labelParts.push("Part " + (j + 1));
            emit(
                got.media[j].url,
                labelParts.join(" • "),
                qualityFromText(capped[s].label + " " + entry.rawTitle, got.media[j].url),
                got.subs
            );
        }
    }
    return streams;
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

        var titles = await tmdbTitles(tmdbId, type);
        if (!titles.length) return out;

        var entries = [];
        var seenHref = {};
        for (var t = 0; t < titles.length && entries.length < 3; t++) {
            var cards = await searchSite(titles[t].title);
            var picked = pickEntries(cards, titles[t].title, titles[t].year, type);
            for (var p = 0; p < picked.length; p++) {
                if (!seenHref[picked[p].href]) {
                    seenHref[picked[p].href] = true;
                    entries.push(picked[p]);
                }
            }
            if (entries.length) break; // exact match found — don't search on
        }
        if (!entries.length) return out;

        var displayTitle = titles[0].title + (type === "movie" ? "" : " S" + sNum + "E" + eNum);
        entries = entries.slice(0, 3);
        for (var e = 0; e < entries.length; e++) {
            var got = await streamsForEntry(entries[e], type, sNum, eNum, displayTitle);
            for (var g = 0; g < got.length; g++) out.push(got[g]);
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

// ---------------------------------------------------------------------------
// TEMPORARY DIAGNOSTIC v2 — TMDB 603 flow, summary split so nothing
// important truncates off the phone screen:
//   entry 1 = the nepu.to mirror path + full flow result
//   entry 2 = the nepu.io stages (already known: 403 CF) + environment
//   entry 3 = extra probes: are /feeds, /ajax or full-browser-header
//             requests exempt from the challenge on nepu.io?
// ---------------------------------------------------------------------------

var __origGetStreams = getStreams;

function __isCF(text) {
    if (!text) return false;
    return text.indexOf("Just a moment") > -1 || text.indexOf("challenges.cloudflare.com") > -1 || text.indexOf("Verify you are human") > -1;
}

async function __probe(url, opts) {
    try {
        var r = await httpRequest(url, opts || {});
        return { ok: true, status: r.status, url: r.url, text: r.text || "", cf: __isCF(r.text) };
    } catch (e) {
        return { ok: false, status: 0, url: url, text: "", cf: false, err: String(e && e.message ? e.message : e).slice(0, 40) };
    }
}

function __short(p) {
    if (!p.ok) return "ERR";
    return String(p.status) + (p.cf ? "CF" : "");
}

async function __diagGetStreams(tmdbId, mediaType, season, episode) {
    var e1 = "", e2 = "", e3 = "";
    var realStreams = [];
    try {
        var titles = await tmdbTitles("603", "movie");
        var tmdbOk = titles.length ? ("TMDB ok " + (titles[0].year || "?")) : "TMDB FAIL";

        // nepu.io stages (settled last run, re-checked cheaply via search)
        var c = await __probe("https://nepu.io/search/The%20Matrix", { headers: { "Accept": "text/html" }, timeoutMs: 10000 });
        var cCards = c.ok && !c.cf ? parseSearchCards(c.text) : [];

        // nepu.to mirror stages
        var d = await __probe("https://nepu.to/", { headers: { "Accept": "text/html" }, timeoutMs: 10000 });
        var e = await __probe("https://nepu.to/search/The%20Matrix", { headers: { "Accept": "text/html" }, timeoutMs: 10000 });
        var eCards = e.ok && !e.cf ? parseSearchCards(e.text) : [];

        var host = null, cards = null;
        if (cCards.length) { host = "https://nepu.io"; cards = cCards; }
        else if (eCards.length) { host = "https://nepu.to"; cards = eCards; }

        var fTxt = "F:-", gTxt = "G:-", hTxt = "H:-";
        var detail3 = [];
        if (d.err) detail3.push("Derr:" + d.err);
        if (e.err) detail3.push("Eerr:" + e.err);
        if (host) {
            var movie = null;
            for (var i = 0; i < cards.length; i++) if (cards[i].kind === "movie") { movie = cards[i]; break; }
            if (movie) {
                var f = await __probe(movie.href, { headers: { "Accept": "text/html" }, timeoutMs: 10000 });
                var embeds = f.ok ? parseEmbedSources(f.text) : [];
                fTxt = "F watch " + __short(f) + " emb" + embeds.length;
                detail3.push("Furl:" + f.url);
                if (embeds.length) {
                    var g = null;
                    try {
                        g = await httpRequest(host + "/ajax/embed", {
                            method: "POST",
                            headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest", "Referer": f.url, "Accept": "text/html, */*" },
                            body: "id=" + encodeURIComponent(embeds[0].id),
                            timeoutMs: 10000,
                        });
                    } catch (err) { g = { status: 0, text: "", err: String(err && err.message ? err.message : err).slice(0, 40) }; }
                    var media = g.text ? parseEmbedMedia(g.text, f.url).media : [];
                    gTxt = "G ajax " + (g.err ? "ERR" : g.status) + " media" + media.length;
                    if (media.length) detail3.push("media0:" + media[0].url.slice(0, 70));
                    else detail3.push("Gbody:" + (g.text || "").slice(0, 120).replace(/\s+/g, " "));
                }
            }
            var savedBase = BASE;
            BASE = host;
            try { realStreams = await __origGetStreams("603", "movie", null, null); } catch (err2) { realStreams = []; }
            BASE = savedBase;
            hTxt = "H real" + realStreams.length + "(" + (host.indexOf(".to") > -1 ? "to" : "io") + ")";
        }

        e1 = "D to " + __short(d) + " | E srch " + __short(e) + " cards" + eCards.length + " | " + fTxt + " | " + gTxt + " | " + hTxt;
        e2 = "C ioSrch " + __short(c) + " cards" + cCards.length + " | " + tmdbOk + " | sT=" + (typeof setTimeout) + " args " + tmdbId + "/" + mediaType;

        // Extra probes on .io: exempt paths / header shape
        var p1 = await __probe("https://nepu.io/feeds/movies.php", { timeoutMs: 10000 });
        var p2 = null;
        try {
            p2 = await httpRequest("https://nepu.io/ajax/embed", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest", "Referer": "https://nepu.io/", "Accept": "text/html, */*" },
                body: "id=1",
                timeoutMs: 10000,
            });
        } catch (err3) { p2 = { status: 0, text: "" }; }
        var p2cf = __isCF(p2.text || "");
        var p3 = await __probe("https://nepu.io/search/The%20Matrix", {
            headers: {
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "none",
                "Upgrade-Insecure-Requests": "1",
            },
            timeoutMs: 10000,
        });
        e3 = "P feeds " + __short(p1) + " | ajaxDirect " + p2.status + (p2cf ? "CF" : "") + " | fullHdr " + __short(p3) + " || " + detail3.join(" | ");
    } catch (e9) {
        e1 = "DIAG THREW: " + String(e9 && e9.message ? e9.message : e9).slice(0, 80);
    }

    var out = [];
    out.push({ name: "DIAG2 MIRROR+FLOW", title: e1, url: "https://nepu.io/", quality: "Auto", headers: {} });
    out.push({ name: "DIAG2 IO+ENV", title: e2, url: "https://nepu.io/", quality: "Auto", headers: {} });
    out.push({ name: "DIAG2 PROBES", title: e3.slice(0, 400), url: "https://nepu.io/", quality: "Auto", headers: {} });
    for (var r = 0; r < realStreams.length; r++) out.push(realStreams[r]);
    return out;
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { getStreams: __diagGetStreams };
}
try { global.getStreams = __diagGetStreams; } catch (e) {}
