import asyncio
import base64
import contextlib
import glob
import json
import mimetypes
import os
from asyncio import AbstractEventLoop
from collections import defaultdict
from threading import RLock
from typing import Optional, Dict, Callable, Awaitable, Iterable, List, Tuple, cast, Union

from dtps import DTPSContext, context as dtps_context
from dtps_http import RawData, HTTPRequest
from .types import Event, Response, HTML, FrontEnd, EventType, ValuePattern
from .utils import task, setup_file_watcher


Path = str
Selector = str
Key = str


class EventsQueue:

    def __init__(self, state_cxt: DTPSContext, events_cxt: DTPSContext, loop: AbstractEventLoop):
        self._buffer: Optional[List[Event]] = None
        self._buffer_lock: RLock = RLock()
        self._state_cxt: DTPSContext = state_cxt
        self._events_cxt: DTPSContext = events_cxt
        self._loop: AbstractEventLoop = loop

    async def publish(self, evts: Iterable[Event]):
        with self._buffer_lock:
            if self._buffer is None:
                # publish the events immediately
                await self.do_publish(evts)
            else:
                # buffer the events for later
                self._buffer.extend(evts)

    async def do_publish(self, evts: Iterable[Event]):
        # update the state
        patch = []
        for evt in evts:
            path: str = base64.b64encode(f"/{evt.type}/{evt.selector}/{evt.key}".encode("utf-8")).decode("utf-8")
            patch.append({"op": "add", "path": f"/{path}", "value": evt.to_dict()})
        await self._state_cxt.patch(patch)
        # publish out the events
        evts_json: str = json.dumps([evt.to_dict() for evt in evts])
        evts_rd: RawData = RawData(content=evts_json.encode("utf-8"), content_type="application/json")
        await self._events_cxt.publish(evts_rd)

    @contextlib.contextmanager
    async def atomic(self):
        with self._buffer_lock:
            self._buffer = []
        # return control to the caller
        yield
        # get the events collected
        with self._buffer_lock:
            evts = self._buffer
            self._buffer = None
        # publish the events
        await self.do_publish(evts)


class App:

    def __init__(self, host: str, port: int, root: str = None, static_dirs: Union[str, Iterable[str]] = None,
                 loop: AbstractEventLoop = None):
        self._host = host
        self._port = port
        self._root = (root or "").strip("/")
        self._static_dirs: Iterable[str] = \
            (static_dirs if isinstance(static_dirs, list) else [static_dirs]) if static_dirs else None
        self._root_cxt: Optional[DTPSContext] = None
        self._loop = loop or asyncio.get_event_loop()
        self._routes: Dict[Path, DTPSContext] = {}
        self._event_queues: Dict[Path, EventsQueue] = {}
        self._event_listeners: Dict[Tuple[Path, Selector, EventType, Key], List[Callable[[Event], Awaitable]]] = \
            defaultdict(list)
        self._ready: asyncio.Event = asyncio.Event()

    async def astart(self):
        self._loop = asyncio.get_event_loop()
        await self._init()
        self._ready.set()
        await self._run()

    async def _init(self):
        url0: str = f"create:http://{self._host}:{self._port}/"
        self._root_cxt = (await dtps_context("app", urls=[url0])).navigate(self._root)

    async def _run(self):
        # load static files
        if self._static_dirs is not None:
            for static_dir in self._static_dirs:
                for file in glob.glob(os.path.join(static_dir, "**", "*"), recursive=True):
                    rel_path: str = os.path.relpath(file, static_dir)
                    route: DTPSContext = await (self._root_cxt / "static" / rel_path).queue_create()
                    self._routes[rel_path] = route
                    with open(file, "rb") as f:
                        data: bytes = f.read()
                        mime: str = mimetypes.guess_type(file)[0]
                        await route.publish(RawData(content=data, content_type=mime or "application/octet-stream"))
                    setup_file_watcher(file, route, self._loop)
        # load dtps_ui assets
        assets_dir: str = os.path.join(os.path.dirname(__file__), "assets")
        # noinspection PyUnresolvedReferences
        for file in glob.glob(os.path.join(assets_dir, "**", "*"), recursive=True):
            rel_path: str = os.path.relpath(file, assets_dir)
            route: DTPSContext = await (self._root_cxt / "assets" / rel_path).queue_create()
            self._routes[rel_path] = route
            with open(file, "rb") as f:
                data: bytes = f.read()
                mime: str = mimetypes.guess_type(file)[0]
                await route.publish(RawData(content=data, content_type=mime or "application/octet-stream"))
            setup_file_watcher(file, route, self._loop)
        # wait until the app is shutdown
        try:
            while True:
                await asyncio.sleep(1)
        except asyncio.CancelledError:
            print("Event loop stopping...")

    async def event_queue(self, path: str) -> EventsQueue:
        await self._ready.wait()
        evt_queue: EventsQueue = self._event_queues.get(path, None)
        if evt_queue is not None:
            return evt_queue
        _path: str = path.strip("/")
        # create empty events queue
        state_cxt = await (self._root_cxt / _path / "__state__").queue_create()
        await state_cxt.publish(RawData.cbor_from_native_object({}))
        # create empty events queues
        our_events_cxt = await (self._root_cxt / _path / "__frombackend__").queue_create()
        await our_events_cxt.publish(RawData.cbor_from_native_object([]))
        their_events_cxt = await (self._root_cxt / _path / "__tobackend__").queue_create()
        await their_events_cxt.publish(RawData.cbor_from_native_object([]))

        async def _process_events(rd: RawData):
            evts = [
                Event(**evt) for evt in cast(list, rd.get_as_native_object())
            ]
            await self._process_events(path, evts)
        await their_events_cxt.subscribe(_process_events)
        # create the events queue handler object
        events_queue = EventsQueue(state_cxt, our_events_cxt, self._loop)
        self._event_queues[path] = events_queue
        return events_queue

    def publish_events(self, path: Path, evts: Iterable[Event]):
        self._loop.create_task(task(self.apublish_events(path, evts)))

    async def apublish_events(self, path: Path, evts: Iterable[Event]):
        evt_queue: EventsQueue = await self.event_queue(path)
        await evt_queue.publish(evts)

    def listen_for(self, path: Path, selector: Selector, event: EventType, key: str, value: ValuePattern,
                   handler: Callable[[Event], Awaitable]) -> None:
        # return key
        rkey: str = f"{key}|{value or ''}"
        self._event_listeners[(path, selector, event, rkey)].append(handler)

    async def _process_events(self, path: Path, evts: Iterable[Event]):
        for evt in evts:
            handlers: List[Callable[[Event], Awaitable]] = self._event_listeners.get(
                (path, evt.selector, evt.type, evt.key), []
            )
            for handler in handlers:
                await handler(evt)

    async def atomic(self, path: Path):
        evt_queue: EventsQueue = await self.event_queue(path)
        return evt_queue.atomic

    def route(self, path: Path):
        if path in self._routes:
            raise ValueError(f"Route {path} already exists")

        def wrapper(f: Callable[[HTTPRequest], Awaitable[Response]]):
            async def _setup_route():
                await self._ready.wait()

                # create empty events queue
                await self.event_queue(path)

                async def serve(request: HTTPRequest) -> Response:
                    rs = await f(request)
                    if isinstance(rs, HTML):
                        rs = rs.to_response()
                    return rs

                _path: str = path.strip("/")
                route: DTPSContext = await (self._root_cxt / _path).queue_create(serve=serve)
                self._routes[path] = route

            self._loop.create_task(task(_setup_route()))

        return wrapper

    def background(self, f: Callable[[], Awaitable[None]]):
        async def _setup_background_task():
            # wait until the app is ready
            await self._ready.wait()
            # run background task
            await f()

        self._loop.create_task(task(_setup_background_task()))

    def frontend(self, path: Path) -> FrontEnd:
        return FrontEnd.get(self, path)

    def serve_forever(self):
        try:
            if self._loop.is_running():
                raise ValueError("The event loop is already running. Use the async entrypoint `App.arun()` instead.")
            self._loop.run_until_complete(self.astart())
        except KeyboardInterrupt:
            pass
