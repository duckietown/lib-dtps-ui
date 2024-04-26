import asyncio
import logging
import mimetypes
import traceback
from typing import Coroutine

from watchdog.events import FileModifiedEvent
from watchdog.observers import Observer

from dtps import DTPSContext
from dtps_http import RawData

# suppress watchdog logging
for logger in [logging.getLogger(name) for name in logging.root.manager.loggerDict]:
    if logger.name.startswith("watchdog.observers."):
        logger.setLevel(logging.WARNING)


async def task(coro: Coroutine):
    # noinspection PyBroadException
    try:
        await coro
    except Exception:
        print(f"Exception in task: {coro.__name__}")
        traceback.print_exc()


class FileModifiedEventHandler(FileModifiedEvent):

    def __init__(self, path: str, cxt: DTPSContext, loop: asyncio.AbstractEventLoop):
        super().__init__(path)
        self._cxt: DTPSContext = cxt
        self._loop: asyncio.AbstractEventLoop = loop

    def dispatch(self, event):
        if event.event_type != "closed":
            return
        # re-read the file and re-publish it

        async def republish():
            try:
                with open(self.src_path, "rb") as f:
                    data: bytes = f.read()
                    mime: str = mimetypes.guess_type(self.src_path)[0]
                    await self._cxt.publish(RawData(content=data, content_type=mime or "application/octet-stream"))
                    print(f"File {self.src_path} reloaded")
            except Exception as e:
                print(f"Error reading file: {e}")

        self._loop.create_task(task(republish()))


def setup_file_watcher(path: str, cxt: DTPSContext, loop: asyncio.AbstractEventLoop):
    handler = FileModifiedEventHandler(path, cxt, loop)
    observer = Observer()
    observer.schedule(handler, path, recursive=True)
    observer.start()
