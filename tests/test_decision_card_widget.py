"""The decision-card TUI widget's node:test suite, run under pytest so the CI gate covers it.

    pytest tests/          (or directly: node --test tests/decision_card.test.mjs)

Node is required in CI (``CI`` set); on a dev machine without node the suite is skipped.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SUITE = ROOT / "tests" / "decision_card.test.mjs"


def test_decision_card_widget_node_suite():
    node = shutil.which("node")
    if node is None:
        if os.environ.get("CI"):
            pytest.fail("node is required in CI to test widgets/decision-card.mjs")
        pytest.skip("node not installed")
    # the suite drives tests/fake_agent.py: give it this interpreter
    env = {**os.environ, "PYTHON": sys.executable}
    r = subprocess.run([node, "--test", "--test-reporter=spec", str(SUITE)], cwd=ROOT, env=env,
                       capture_output=True, text=True, timeout=180)
    assert r.returncode == 0, f"node --test failed ({r.returncode}):\n{r.stdout}\n{r.stderr}"
