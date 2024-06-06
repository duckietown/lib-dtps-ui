import dataclasses
import os
from types import NoneType
from typing import Union, Literal, TYPE_CHECKING, Callable, Awaitable, Dict, Tuple

from aiohttp import web
from jinja2 import Template

from dtps_http import RawData, HTTPResponse

Response = Union[RawData, HTTPResponse, 'HTML']
EventType = Literal["register", "unregister", "update", "style", "action"]
ValueType = Union[int, float, str, list, dict, None]
AllowedValueTypes = (int, float, str, list, dict, NoneType)
ValuePattern = str

if TYPE_CHECKING:
    import dtps_ui


@dataclasses.dataclass
class Event:
    type: EventType
    selector: str
    key: str
    value: ValueType

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)


class Style:
    """
    The style of an element.
    """
    __cache__: Dict[Tuple[int, str, str], 'Style'] = {}

    def __init__(self, app: 'dtps_ui.App', path: str, selector: str):
        cache_key = (id(app), path, selector)
        if cache_key in Style.__cache__:
            raise ValueError(f"Style already exists: {cache_key}, use Style.get() instead.")
        self._app = app
        self._path = path
        self._selector = selector

    @staticmethod
    def get(app: 'dtps_ui.App', path: str, selector: str) -> 'Style':
        cache_key = (id(app), path, selector)
        if cache_key in Style.__cache__:
            return Style.__cache__[cache_key]
        elem = Style(app, path, selector)
        Style.__cache__[cache_key] = elem
        return elem

    def __setattr__(self, key, value):
        if key.startswith("_"):
            super().__setattr__(key, value)
        else:
            if not isinstance(value, AllowedValueTypes):
                raise ValueError(f"Value type not allowed: '{type(value)}'; "
                                 f"Allowed types: {', '.join(map(str, AllowedValueTypes))}")
            self._app.publish_events(self._path, [Event(type="style", selector=self._selector, key=key, value=value)])


class Element:
    """
    Any element that can generate and react to events.
    """
    __cache__: Dict[Tuple[int, str, str], 'Element'] = {}

    def __init__(self, app: 'dtps_ui.App', path: str, selector: str):
        cache_key = (id(app), path, selector)
        if cache_key in Element.__cache__:
            raise ValueError(f"Element already exists: {cache_key}, use Element.get() instead.")
        self._app = app
        self._path = path
        self._selector = selector

    @staticmethod
    def get(app: 'dtps_ui.App', path: str, selector: str) -> 'Element':
        cache_key = (id(app), path, selector)
        if cache_key in Element.__cache__:
            return Element.__cache__[cache_key]
        elem = Element(app, path, selector)
        Element.__cache__[cache_key] = elem
        return elem

    @property
    def style(self) -> Style:
        return Style.get(self._app, self._path, self._selector)

    def on(self, key: str, handler: Callable[[Event], Awaitable], value: ValuePattern = None) -> None:
        """
        Register a handler for an event.
        """
        # register listener with the app
        self._app.listen_for(self._path, self._selector, "action", key, value, handler)
        # register listener on the frontend
        self._app.publish_events(self._path, [Event(type="register", selector=self._selector, key=key, value=value)])

    def __setattr__(self, key, value):
        if key.startswith("_"):
            super().__setattr__(key, value)
        else:
            if not isinstance(value, AllowedValueTypes):
                raise ValueError(f"Value type not allowed: '{type(value)}'; "
                                 f"Allowed types: {', '.join(map(str, AllowedValueTypes))}")
            self._app.publish_events(self._path, [Event(type="update", selector=self._selector, key=key, value=value)])


@dataclasses.dataclass
class HTML:
    content: str

    @classmethod
    def from_file(cls, path: str) -> 'HTML':
        return cls.from_template(path, None)

    @classmethod
    def from_template(cls, path: str, context: dict = None) -> 'HTML':
        content: str
        with open(path, "rt") as f:
            content = f.read()
        # apply context using jinja2
        context = context.copy() if context else {}
        # add dtps include html
        dtps_ui_include_fpath = os.path.join(os.path.dirname(__file__), "assets", "dtps_ui_include.html")
        with open(dtps_ui_include_fpath, "rt") as f:
            dtps_ui_include_html = f.read()
        context["dtps_ui_include"] = dtps_ui_include_html
        # render template
        template = Template(content)
        content = template.render(**context)
        # return HTML
        return HTML(content=content)

    def to_response(self) -> web.Response:
        return web.Response(body=self.content, content_type="text/html")


class FrontEnd:
    __cache__: Dict[Tuple[int, str], 'FrontEnd'] = {}

    def __init__(self, app: 'dtps_ui.App', path: str):
        cache_key = (id(app), path)
        if cache_key in FrontEnd.__cache__:
            raise ValueError(f"FrontEnd already exists: {cache_key}, use FrontEnd.get() instead.")
        self._app = app
        self._path = path

    @staticmethod
    def get(app: 'dtps_ui.App', path: str):
        cache_key = (id(app), path)
        if cache_key in FrontEnd.__cache__:
            return FrontEnd.__cache__[cache_key]
        fe = FrontEnd(app, path)
        FrontEnd.__cache__[cache_key] = fe
        return fe

    @property
    def document(self) -> Element:
        """
        Stub for the document element.
        """
        return Element.get(self._app, self._path, "document")

    @property
    def window(self) -> Element:
        """
        Stub for the window element.
        """
        return Element.get(self._app, self._path, "window")

    def element(self, selector: str) -> Element:
        """
        Stub for an element.
        """
        return Element.get(self._app, self._path, selector)
