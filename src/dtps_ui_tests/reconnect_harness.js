// Regression harness for the reconnection logic in `dtps_ui/assets/dtps_ui.js`.
//
//   node reconnect_harness.js <path to dtps_ui.js>
//
// Exits 0 when every check passes. `test_reconnect.py` runs this under nose2 (and skips when no
// node interpreter is available).
//
// The asset is loaded into a VM context with the browser globals it touches stubbed out, and then
// driven through the behaviour of a real DTPS subscription. The part that matters here: a DTPS
// queue hands its retained last message to *every* new subscriber, so a reconnected socket starts
// by replaying the last batch the previous socket already received.

const fs = require("fs");
const vm = require("vm");

const SRC = process.argv[2];
if (!SRC) {
    console.error("usage: node reconnect_harness.js <path to dtps_ui.js>");
    process.exit(2);
}

function makeContext(state_responses) {
    const dom = {};        // selector -> {key: value}
    const triggers = [];   // every $(sel).trigger(key, value)

    function api(sel) {
        const node = dom[sel] || (dom[sel] = {});
        return {
            __sel: sel,
            length: 1,
            trigger: (key, value) => triggers.push({sel, key, value}),
            html: (v) => { node.innerHTML = v; },
            text: (v) => { node.innerText = v; },
            attr: (k, v) => { node[k] = v; },
            prop: (k, v) => { node[k] = v; },
            css: () => {}, val: () => {},
            on: () => {}, off: () => {},
            append: () => {}, remove: () => {},
            each: () => {}, find: () => api(sel),
            addClass: () => {}, removeClass: () => {},
            ready: () => {},   // page init is driven explicitly below
        };
    }

    function $(sel) {
        // the asset re-wraps cached selections (`$ = _jqq` calls `_jq(cachedSelection)`), so this
        // has to accept one of its own selections as well as a selector string
        if (sel && sel.__sel !== undefined) return api(sel.__sel);
        if (typeof sel === "function") { sel(); return api("__fn__"); }
        if (typeof sel === "object") return api("__node__");
        return api(sel);
    }
    $.fn = {};

    const sockets = [];
    class FakeWebSocket {
        constructor(url) {
            this.url = url; this.readyState = 0; this.sent = [];
            sockets.push(this);
        }
        send(d) { this.sent.push(d); }
        close() { this.readyState = 3; if (this.onclose) this.onclose(); }
        async open() { this.readyState = 1; if (this.onopen) await this.onopen(); }
        deliver(obj) { if (this.onmessage) this.onmessage({data: obj}); }
    }
    FakeWebSocket.OPEN = 1;

    let fetch_calls = 0;   // one entry of `state_responses` per sync_state() call
    const fetch = async () => state_responses[Math.min(fetch_calls++, state_responses.length - 1)]();

    const ctx = {
        console: {log: () => {}, warn: () => {},
                  error: (...a) => { if (process.env.DTPS_UI_TEST_DEBUG) console.error("   [js]", ...a); }},
        window: {location: {host: "h", protocol: "http:", pathname: "/ui/"},
                 addEventListener: () => {}},
        document: {addEventListener: () => {}, getElementById: () => null, body: {}},
        navigator: {userAgent: "node"},
        $, jQuery: $,
        WebSocket: FakeWebSocket,
        fetch,
        setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0,
        TextDecoder: require("util").TextDecoder,
        CBOR: {decode: (x) => x, encode: (x) => x},   // payload objects are passed through as-is
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(SRC, "utf8"), ctx);

    // connect_frombackend() also opens the to-backend socket; pick the one under test by URL
    const lastFrom = () => [...sockets].reverse().find((s) => s.url.includes("__frombackend__"));
    return {ctx, dom, triggers, sockets, lastFrom, fetches: () => fetch_calls};
}

const chunk = (evts, digest) => ({
    Chunk: {digest, i: 0, n: 1, index: 0, data: new TextEncoder().encode(JSON.stringify(evts))},
});
const ok = (json) => () => ({json: async () => json});
const boom = () => () => { throw new Error("state fetch failed"); };
const settle = () => new Promise((r) => setImmediate(r));

let failures = 0;
function check(name, cond, detail) {
    if (!cond) failures++;
    console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${cond ? "" : "  <- " + detail}`);
}

// A trigger is delivered live, the socket drops, and the reconnected socket is handed that same
// batch again as the queue's retained message. It must not fire a second time.
async function retained_trigger_is_not_replayed() {
    console.log("a retained trigger is not replayed on reconnect");
    const TRIG = [{type: "trigger", selector: "#btn", key: "click", value: 1}];
    const RESYNC_STATE = {"trigger|#btn|click": TRIG[0]};
    const h = makeContext([ok({}), ok(RESYNC_STATE)]);

    h.ctx.connect_frombackend();
    const s1 = h.lastFrom();
    await s1.open();
    await h.ctx.sync_state(false);            // initial sync, as page load does
    s1.deliver(chunk(TRIG, "digest-A"));      // the trigger arrives live
    const before = h.triggers.length;

    s1.close();
    h.ctx.connect_frombackend();
    const s2 = h.lastFrom();
    await s2.open();                          // onopen re-syncs the state
    s2.deliver(chunk(TRIG, "digest-A"));      // retained replay: same payload, same digest
    await settle();

    check("fires once while connected", before === 1, `got ${before}`);
    check("retained replay does not re-fire it", h.triggers.length === 1,
          `fired ${h.triggers.length} times -> duplicate action sent to the backend`);

    // a genuinely new trigger on that same socket must still get through
    s2.deliver(chunk([{type: "trigger", selector: "#btn", key: "click", value: 2}], "digest-B"));
    await settle();
    check("a new trigger still fires", h.triggers.length === 2,
          `got ${h.triggers.length}, expected 2`);
}

// The retained message is also how a trigger published *while we were away* reaches us. Suppressing
// the duplicate must not suppress that one: it carries a digest that was never applied.
async function missed_trigger_still_arrives() {
    console.log("a trigger published while disconnected still arrives");
    const SEEN = [{type: "trigger", selector: "#btn", key: "click", value: 1}];
    const MISSED = [{type: "trigger", selector: "#btn", key: "click", value: 99}];
    const h = makeContext([ok({}), ok({})]);

    h.ctx.connect_frombackend();
    const s1 = h.lastFrom();
    await s1.open();
    await h.ctx.sync_state(false);
    s1.deliver(chunk(SEEN, "digest-A"));
    s1.close();

    h.ctx.connect_frombackend();
    const s2 = h.lastFrom();
    await s2.open();
    s2.deliver(chunk(MISSED, "digest-C"));    // retained, but published while we were away
    await settle();

    check("the missed trigger is delivered", h.triggers.length === 2,
          `fired ${h.triggers.length} times, expected 2 (it was swallowed as a duplicate)`);
    check("and it is the missed one", h.triggers[h.triggers.length - 1].value === 99,
          `last trigger value ${h.triggers[h.triggers.length - 1].value}`);
}

// An event is buffered while the state is being fetched, that fetch fails, and the retry applies a
// newer authoritative snapshot. The stale buffered event must not land on top of it.
async function abandoned_sync_does_not_overwrite_snapshot() {
    console.log("events of an abandoned sync do not overwrite the snapshot");
    const OLD = [{type: "update", selector: "#v", key: "innerHTML", value: "older event"}];
    const SNAP = {"update|#v|innerHTML":
                  {type: "update", selector: "#v", key: "innerHTML", value: "authoritative snapshot"}};
    const OTHER = [{type: "update", selector: "#w", key: "innerHTML", value: "unrelated"}];
    const h = makeContext([ok({}), boom(), ok(SNAP)]);

    h.ctx.connect_frombackend();
    const s1 = h.lastFrom();
    await s1.open();
    await h.ctx.sync_state(false);

    s1.close();
    h.ctx.connect_frombackend();              // reconnect #1: its re-sync will fail
    const s2 = h.lastFrom();
    const opening2 = s2.open();
    s2.deliver(chunk(OLD, "digest-OLD"));     // buffered: the re-sync is in flight
    await opening2;                           // ... and then the fetch throws

    h.ctx.connect_frombackend();              // reconnect #2: this one succeeds
    const s3 = h.lastFrom();
    const opening3 = s3.open();
    s3.deliver(chunk(OTHER, "digest-OTHER"));
    await opening3;
    await settle();

    const shown = h.dom["#v"] && h.dom["#v"].innerHTML;
    check("the snapshot value survives the failed sync", shown === "authoritative snapshot",
          `#v shows ${JSON.stringify(shown)} -> stale UI while dtps_ui.connected is true`);
}

(async () => {
    await retained_trigger_is_not_replayed();
    await missed_trigger_still_arrives();
    await abandoned_sync_does_not_overwrite_snapshot();
    console.log(failures === 0 ? "\nALL CHECKS PASS" : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})();
