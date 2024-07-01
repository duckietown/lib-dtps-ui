__version__ = "0.1.3"

import logging

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

from .app import App

