const frombackend_ws_url =
    "ws://" + window.location.host + "/" + window.location.pathname.replace(/^\/|\/$/g, '') + "/__frombackend__/:events/?send_data=true";
console.log("Connecting to backend WS at " + frombackend_ws_url + " ...")

const frombackend = new WebSocket(frombackend_ws_url);
frombackend.binaryType = "arraybuffer";

frombackend.onopen = () => {
    console.log("Connected to backend WS at " + frombackend_ws_url);
};

frombackend.onclose = () => {
    console.log("Disconnected from backend WS at " + frombackend_ws_url);
};



const tobackend_ws_url =
    "ws://" + window.location.host + "/" + window.location.pathname.replace(/^\/|\/$/g, '') + "/__tobackend__/:push/";
console.log("Connecting to frontend WS at " + tobackend_ws_url + " ...")

const tobackend = new WebSocket(tobackend_ws_url);
tobackend.binaryType = "arraybuffer";

tobackend.onopen = () => {
    console.log("Connected to frontend WS server at " + tobackend_ws_url);
};

tobackend.onclose = () => {
    console.log("Disconnected from frontend WS server at " + tobackend_ws_url);
};


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


function on_register_event(evt) {
    $(selector(evt)).on(evt.key, async (action) => {
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
        let evts = [evt1];

        // encode the event as a CBOR payload
        let data = CBOR.encode({
            RawData: {
                content: JSON.stringify(evts),
                content_type: "application/json"
            }
        });

        // send the event to the backend
        tobackend.send(data);
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

function process_events(evts) {
    // process the events
    for (let evt of evts) {
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
        } else {
            console.log("Unknown event type: " + evt.type);
        }
    }
}


// Websocket events listener

$(document).ready(async () => {
    let state_url =
        window.location.protocol + "//" + window.location.host + "/" + window.location.pathname.replace(/^\/|\/$/g, '') + "/__state__/";

    console.log("Fetching initial state from '" + state_url + "' ...")
    // fetch the initial state
    let state = await fetch(state_url);
    let json = await state.json();

    // process the events defining in the initial state
    for (let evt of Object.values(json)) {
        process_events([evt]);
    }
    console.log("Initial state processed.")

    console.log("Listening for events ...")
    let text_decoder = new TextDecoder("utf-8");
    frombackend.onmessage = (msg) => {
        // decode CBOR message
        let payload = CBOR.decode(msg.data);

        // messages of type "Chunk" are used to send data payloads
        if (!("Chunk" in payload)) {
            return;
        }

        // decode the Chunk payload
        let json = text_decoder.decode(payload.Chunk.data);

        // parse the JSON payload
        let evts = JSON.parse(json);

        // process the events
        process_events(evts);
    };
});
