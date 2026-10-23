// ---------------------------------------------------------------------------
// MeowTV Diag — TEMPORARY staged diagnostic for the MeowTV plugin.
// Its Test run ignores the requested title and probes TMDB 603 (movie)
// step by step, returning exactly TWO summary entries (the app's result
// list collapses/truncates anything beyond the first entries):
//   S0 runtime/fetch sanity     S2 POST /streams/ticket (plugin's call)
//   S3 GET streams ?s=dcloud    S4 GET streams ?s=acme&list=1
//   S5 GET /subs (no ticket)    S6 ticket POST without Origin/Referer
//   S7 dcloud GET with the S6 ticket (only when S2 failed)
// The raw response bodies are included so the actual API response shape
// is visible, not just status codes.
// ---------------------------------------------------------------------------

var API = "https://api.meowtv.ru";
var SITE = "https://meowtv.ru";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

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

function snip(text, n) {
    var t = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
}

async function raw(url, opts) {
    opts = opts || {};
    var headers = { "User-Agent": UA, "Accept": "application/json, text/plain, */*" };
    if (!opts.bare) { headers["Origin"] = SITE; headers["Referer"] = SITE + "/"; }
    if (opts.headers) for (var k in opts.headers) headers[k] = opts.headers[k];
    var init = { method: opts.method || "GET", headers: headers, redirect: "follow", signal: timeoutSignal(10000) };
    if (opts.body != null) { headers["Content-Type"] = "application/json"; init.body = opts.body; }
    var res = await fetch(url, init);
    var text = await res.text();
    return { status: res.status, text: text };
}

async function getStreams(tmdbId, mediaType, season, episode) {
    var L = {};   // stage results
    var ticket = null, ticketB = null;

    // S0 — environment
    L.env = "fetch:" + (typeof fetch === "function" ? "y" : "N")
        + " AC:" + (typeof AbortController !== "undefined" ? "y" : "N")
        + " sT:" + (typeof setTimeout === "function" ? "y" : "N");

    // S2 — ticket POST, exactly as the plugin does it
    try {
        var r2 = await raw(API + "/streams/ticket", { method: "POST", body: "{}" });
        L.tkt = r2.status;
        L.tktBody = snip(r2.text, 150);
        try { var j = JSON.parse(r2.text); if (j && j.ticket) { ticket = j.ticket; L.tktLen = String(j.ticket).length; } } catch (e) {}
    } catch (e) { L.tkt = "ERR " + snip(e && e.message ? e.message : e, 60); L.tktBody = ""; }

    // S3 — dcloud single with ticket; RAW body is the key evidence
    try {
        var r3 = await raw(API + "/streams/movie/603?s=dcloud", { headers: ticket ? { "x-stream-ticket": ticket } : {} });
        L.dc = r3.status;
        L.dcBody = snip(r3.text, 300);
    } catch (e) { L.dc = "ERR " + snip(e && e.message ? e.message : e, 60); L.dcBody = ""; }

    // S4 — acme list with ticket
    try {
        var r4 = await raw(API + "/streams/movie/603?s=acme&list=1", { headers: ticket ? { "x-stream-ticket": ticket } : {} });
        L.ac = r4.status;
        L.acBody = snip(r4.text, 220);
    } catch (e) { L.ac = "ERR " + snip(e && e.message ? e.message : e, 60); L.acBody = ""; }

    // S5 — subs, no ticket
    try {
        var r5 = await raw(API + "/subs/movie/603", {});
        var n = -1;
        try { var j5 = JSON.parse(r5.text); if (Array.isArray(j5)) n = j5.length; } catch (e) {}
        L.subs = r5.status + " n=" + n;
    } catch (e) { L.subs = "ERR " + snip(e && e.message ? e.message : e, 60); }

    // S6/S7 — only when the normal ticket failed: bare-header variant
    L.var6 = "skipped";
    L.var7 = "skipped";
    if (!ticket) {
        try {
            var r6 = await raw(API + "/streams/ticket", { method: "POST", body: "{}", bare: true });
            L.var6 = "barePOST " + r6.status + " " + snip(r6.text, 80);
            try { var j6 = JSON.parse(r6.text); if (j6 && j6.ticket) ticketB = j6.ticket; } catch (e) {}
        } catch (e) { L.var6 = "barePOST ERR " + snip(e && e.message ? e.message : e, 50); }
        if (ticketB) {
            try {
                var r7 = await raw(API + "/streams/movie/603?s=dcloud", { headers: { "x-stream-ticket": ticketB }, bare: true });
                L.var7 = "bareDC " + r7.status + " " + snip(r7.text, 120);
            } catch (e) { L.var7 = "bareDC ERR " + snip(e && e.message ? e.message : e, 50); }
        }
    }

    var e1 = {
        name: "DIAG tkt:" + L.tkt + " dc:" + L.dc + " ac:" + L.ac,
        title: "S3 dcloud body: " + (L.dcBody || "(empty)") + " || S2 ticket body: " + (L.tktBody || "(empty)") + (L.tktLen ? " tkLen=" + L.tktLen : ""),
        url: SITE + "/",
        quality: "Auto",
        headers: { "User-Agent": UA },
    };
    var e2 = {
        name: "DIAG2 subs:" + L.subs,
        title: "S4 acme body: " + (L.acBody || "(empty)") + " || S6 " + L.var6 + " || S7 " + L.var7 + " || " + L.env,
        url: SITE + "/",
        quality: "Auto",
        headers: { "User-Agent": UA },
    };
    return [e1, e2];
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { getStreams: getStreams };
} else {
    global.getStreams = getStreams;
}
