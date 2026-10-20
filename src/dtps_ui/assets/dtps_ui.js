// dtps_ui frontend runtime
//
// Keeps two websockets open with the backend:
//  - `frombackend` (events published by the backend, applied to the page)
//  - `tobackend`   (actions raised by the page, delivered to the backend)
//
// Both sockets reconnect automatically (with exponential backoff) when they drop, e.g. after the
// backend restarts or the browser suspends a background tab. While the connection is down, the
// page is flagged (see `dtps_ui.connected` below) and actions are dropped rather than queued, so
// that stale inputs (e.g. a key press from minutes ago) are never replayed on reconnect.
// When `frombackend` reconnects, the full state is re-fetched from the backend, so that any event
// published while the page was disconnected is not lost.

const dtps_ui_base_path = window.location.pathname.replace(/^\/|\/$/g, '');
const frombackend_ws_url =
    "ws://" + window.location.host + "/" + dtps_ui_base_path + "/__frombackend__/:events/?send_data=true";
const tobackend_ws_url =
    "ws://" + window.location.host + "/" + dtps_ui_base_path + "/__tobackend__/:push/";
const state_url =
    window.location.protocol + "//" + window.location.host + "/" + dtps_ui_base_path + "/__state__/";

const DTPS_UI_RECONNECT_MIN_MS = 500;
const DTPS_UI_RECONNECT_MAX_MS = 5000;

let frombackend = null;
let tobackend = null;

// connection status, exposed to the page as `dtps_ui.connected`
const dtps_ui = {
    connected: false,
    frombackend_connected: false,
    tobackend_connected: false,
    // listeners notified with the new value of `connected`
    on_connection_change: [],
};
window.dtps_ui = dtps_ui;

function _apply_connection_status() {
    const connected = dtps_ui.connected;
    if (document.body) {
        document.body.classList.toggle("dtps-ui-disconnected", !connected);
        document.body.setAttribute("data-dtps-ui-connected", connected ? "true" : "false");
    }
    _show_disconnected_banner(!connected);
}

function _update_connection_status() {
    const connected = dtps_ui.frombackend_connected && dtps_ui.tobackend_connected;
    if (connected === dtps_ui.connected) {
        return;
    }
    dtps_ui.connected = connected;
    _apply_connection_status();
    for (const listener of dtps_ui.on_connection_change) {
        try {
            listener(connected);
        } catch (e) {
            console.error("dtps_ui: error in connection listener", e);
        }
    }
}

function _show_disconnected_banner(show) {
    let banner = document.getElementById("dtps_ui_disconnected_banner");
    if (!show) {
        if (banner) {
            banner.remove();
        }
        return;
    }
    if (banner || !document.body) {
        return;
    }
    banner = document.createElement("div");
    banner.id = "dtps_ui_disconnected_banner";
    banner.textContent = "Connection to the backend lost. Reconnecting...";
    banner.style.cssText =
        "position:fixed;top:0;left:0;right:0;z-index:100000;padding:6px 12px;" +
        "background:#b02a37;color:#fff;font:14px sans-serif;text-align:center;";
    document.body.appendChild(banner);
}

// grows from MIN to MAX, reset on a successful connection
function _next_delay(current) {
    return Math.min(current * 2, DTPS_UI_RECONNECT_MAX_MS);
}


// Cached JQuery

let _jquery_cache = {};
let _jq = $;

function _jqq(s)  {
    if (_jquery_cache.hasOwnProperty(s)) {
        return _jq(_jquery_cache[s]);
    }

    let e = _jq(s);

    if(e.length > 0) {
        return _jq(_jquery_cache[s] = e);
    }

    // no match (yet): return the empty selection instead of `undefined` so that callers do not throw
    return e;
}

$ = _jqq;


// Event handlers


function selector(evt) {
    if (evt.selector === "window") {
        return window;
    } else if (evt.selector === "document") {
        return document;
    } else {
        return evt.selector;
    }
}

Object.byString = function(o, s) {
    s = s.replace(/\[(\w+)\]/g, '.$1'); // convert indexes to properties
    s = s.replace(/^\./, '');           // strip a leading dot
    let a = s.split('.');
    for (let i = 0, n = a.length; i < n; ++i) {
        let k = a[i];
        if (k in o) {
            o = o[k];
        } else {
            return;
        }
    }
    return o;
}

// deliver an action to the backend; dropped (with a warning) while disconnected
function send_to_backend(evts) {
    if (tobackend === null || tobackend.readyState !== WebSocket.OPEN) {
        console.warn("dtps_ui: backend not connected, dropping event(s)", evts);
        return false;
    }
    // encode the events as a CBOR payload
    let data = CBOR.encode({
        RawData: {
            content: JSON.stringify(evts),
            content_type: "application/json"
        }
    });
    tobackend.send(data);
    return true;
}

// listeners already registered, so that re-applying the state on reconnect does not bind them twice
let _registered_listeners = new Set();

function on_register_event(evt) {
    let registration_key = evt.selector + "|" + evt.key + "|" + (evt.value === null ? "" : evt.value);
    if (_registered_listeners.has(registration_key)) {
        return;
    }
    let target = $(selector(evt));
    if (target.length === 0) {
        console.warn("dtps_ui: cannot register '" + evt.key + "' on '" + evt.selector + "': element not found");
        return;
    }
    _registered_listeners.add(registration_key);
    target.on(evt.key, async (action) => {
        // navigate to the action path
        if (evt.value !== null) {
            action = Object.byString(action, evt.value);
        }

        // return key
        let key = evt.key + "|" + (evt.value === null ? "" : evt.value)

        // create event
        let evt1 = {
            type: "action",
            selector: evt.selector,
            key: key,
            value: JSON.stringify(action)
        };

        // events are sent as a list
        send_to_backend([evt1]);
    });
}

function on_unregister_event(evt) {
    console.log("Not implemented: on_unregister_event");
}

function on_update_event(evt) {
    if (evt.key === "innerHTML" || evt.key === "innerText") {
        $(selector(evt)).html(evt.value);
    } else {
        $(selector(evt)).attr(evt.key, evt.value);
    }
}

function on_style_event(evt) {
    $(selector(evt)).css(evt.key, evt.value);
}

function on_action_event(evt) {
    console.log("Not implemented: on_action_event");
}

function on_trigger_event(evt) {
    $(selector(evt)).trigger(evt.key, evt.value);
}

function process_event(evt) {
    if (evt.type === "register") {
        on_register_event(evt);
    } else if (evt.type === "unregister") {
        on_unregister_event(evt);
    } else if (evt.type === "update") {
        on_update_event(evt);
    } else if (evt.type === "style") {
        on_style_event(evt);
    } else if (evt.type === "action") {
        on_action_event(evt);
    } else if (evt.type === "trigger") {
        on_trigger_event(evt);
    } else {
        console.log("Unknown event type: " + evt.type);
    }
}

function process_events(evts) {
    // process the events; one faulty event must not prevent the others from being applied
    for (let evt of evts) {
        try {
            process_event(evt);
        } catch (e) {
            console.error("dtps_ui: error while processing event", evt, e);
        }
    }
}


// State synchronization

// events received from `frombackend` while the state is being (re)fetched are held here and
// applied right after the state, so that nothing is lost or applied out of order
let _state_synced = false;
let _pending_events = [];

async function sync_state() {
    _state_synced = false;
    console.log("Fetching state from '" + state_url + "' ...");
    let state = await fetch(state_url, {cache: "no-store"});
    let json = await state.json();
    // process the events defining the state
    for (let evt of Object.values(json)) {
        process_events([evt]);
    }
    console.log("State processed.");
    // apply the events that arrived in the meantime
    _state_synced = true;
    let pending = _pending_events;
    _pending_events = [];
    for (let evts of pending) {
        process_events(evts);
    }
}


// Websockets

const _text_decoder = new TextDecoder("utf-8");

function _on_frombackend_message(msg) {
    // decode CBOR message
    let payload = CBOR.decode(msg.data);

    // messages of type "Chunk" are used to send data payloads
    if (!("Chunk" in payload)) {
        return;
    }

    // decode the Chunk payload
    let json = _text_decoder.decode(payload.Chunk.data);

    // parse the JSON payload
    let evts = JSON.parse(json);

    if (!_state_synced) {
        _pending_events.push(evts);
        return;
    }

    // process the events
    process_events(evts);
}

let _frombackend_delay = DTPS_UI_RECONNECT_MIN_MS;
let _frombackend_ever_connected = false;
let _frombackend_timer = null;

function connect_frombackend() {
    clearTimeout(_frombackend_timer);
    _frombackend_timer = null;
    if (frombackend !== null && frombackend.readyState <= WebSocket.OPEN) {
        // already connecting or connected
        return;
    }
    console.log("Connecting to backend WS at " + frombackend_ws_url + " ...");
    let ws = new WebSocket(frombackend_ws_url);
    ws.binaryType = "arraybuffer";
    frombackend = ws;

    ws.onopen = async () => {
        console.log("Connected to backend WS at " + frombackend_ws_url);
        _frombackend_delay = DTPS_UI_RECONNECT_MIN_MS;
        dtps_ui.frombackend_connected = true;
        _update_connection_status();
        if (_frombackend_ever_connected) {
            // reconnection: events published while we were away were missed, re-sync the state
            try {
                await sync_state();
            } catch (e) {
                console.error("dtps_ui: failed to re-sync the state, closing to retry", e);
                ws.close();
            }
        }
        _frombackend_ever_connected = true;
    };

    ws.onmessage = _on_frombackend_message;

    ws.onerror = (e) => {
        console.warn("dtps_ui: backend WS error", e);
    };

    ws.onclose = () => {
        console.log("Disconnected from backend WS at " + frombackend_ws_url +
                    ", reconnecting in " + _frombackend_delay + "ms");
        dtps_ui.frombackend_connected = false;
        _update_connection_status();
        if (frombackend === ws && _frombackend_timer === null) {
            _frombackend_timer = setTimeout(connect_frombackend, _frombackend_delay);
            _frombackend_delay = _next_delay(_frombackend_delay);
        }
    };
}

let _tobackend_delay = DTPS_UI_RECONNECT_MIN_MS;
let _tobackend_timer = null;

function connect_tobackend() {
    clearTimeout(_tobackend_timer);
    _tobackend_timer = null;
    if (tobackend !== null && tobackend.readyState <= WebSocket.OPEN) {
        // already connecting or connected
        return;
    }
    console.log("Connecting to frontend WS at " + tobackend_ws_url + " ...");
    let ws = new WebSocket(tobackend_ws_url);
    ws.binaryType = "arraybuffer";
    tobackend = ws;

    ws.onopen = () => {
        console.log("Connected to frontend WS server at " + tobackend_ws_url);
        _tobackend_delay = DTPS_UI_RECONNECT_MIN_MS;
        dtps_ui.tobackend_connected = true;
        _update_connection_status();
    };

    ws.onerror = (e) => {
        console.warn("dtps_ui: frontend WS error", e);
    };

    ws.onclose = () => {
        console.log("Disconnected from frontend WS server at " + tobackend_ws_url +
                    ", reconnecting in " + _tobackend_delay + "ms");
        dtps_ui.tobackend_connected = false;
        _update_connection_status();
        if (tobackend === ws && _tobackend_timer === null) {
            _tobackend_timer = setTimeout(connect_tobackend, _tobackend_delay);
            _tobackend_delay = _next_delay(_tobackend_delay);
        }
    };
}

// open the sockets right away so that no event is missed while the page finishes loading
connect_frombackend();
connect_tobackend();

// when a suspended tab comes back, do not wait for the backoff timer
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
        return;
    }
    connect_frombackend();
    connect_tobackend();
});


// Initial state

$(document).ready(async () => {
    await sync_state();
    _apply_connection_status();
    console.log("Listening for events ...");
});
