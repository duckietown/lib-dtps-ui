import logging
import os.path
from typing import Optional

import argparse

from dtps_http import HTTPRequest
from dtps_ui import App
from dtps_ui.types import HTML

DEFAULT_STATIC_DIR = "./static"

logging.basicConfig()
logger = logging.getLogger("dtps-ui-server")
logger.setLevel(logging.INFO)


def default_static_dir() -> Optional[str]:
    return DEFAULT_STATIC_DIR if os.path.isdir(DEFAULT_STATIC_DIR) else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", type=str, default="localhost", help="Host to bind to")
    parser.add_argument("--port", type=int, default=8000, help="Port to bind to")
    parser.add_argument("--root", type=str, default="/app/", help="Root URL")
    parser.add_argument("--static-dir", type=str, default=default_static_dir(), help="Static files directory")
    parser.add_argument("--log-level", type=str, default="INFO", help="Log level")
    parser.add_argument("html", type=str, help="HTML file to serve")

    args = parser.parse_args()

    logger.setLevel(args.log_level)

    app = App(host=args.host, port=args.port, root=args.root, static_dirs=args.static_dir)

    @app.route("/")
    async def index(request: HTTPRequest) -> HTML:
        logger.debug(f"GET: {request.url}")
        return HTML.from_file(args.html)

    app.serve_forever()


if __name__ == "__main__":
    main()
