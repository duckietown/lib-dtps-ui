"""Regressions for the reconnection logic of the `dtps_ui.js` asset.

The asset is browser code, so the checks live in `reconnect_harness.js` and run under a node
interpreter: it loads the real asset with the browser globals stubbed and drives it through the
behaviour of a DTPS subscription (every new subscriber is handed the queue's retained last message).

The test is skipped where no node interpreter is installed, so it does not make node a requirement
of this package; run `make test` on a machine that has one to exercise it.
"""

import os
import shutil
import subprocess
import unittest

HARNESS = os.path.join(os.path.dirname(__file__), "reconnect_harness.js")
ASSET = os.path.join(os.path.dirname(os.path.dirname(__file__)), "dtps_ui", "assets", "dtps_ui.js")


def test_reconnection_regressions() -> None:
    node = shutil.which("node") or shutil.which("nodejs")
    if node is None:
        raise unittest.SkipTest("no node interpreter found; skipping the dtps_ui.js regressions")

    completed = subprocess.run(
        [node, HARNESS, ASSET],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert completed.returncode == 0, (
        "dtps_ui.js reconnection regressions failed:\n" + completed.stdout + completed.stderr
    )
