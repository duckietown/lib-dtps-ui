__version__ = "0.0.0"

import logging

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

from .app import App

