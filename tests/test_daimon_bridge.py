"""Integration tests: the daimon-bridge adapter against a fake agent socket. No Hermes needed.

    pytest tests/
"""

from __future__ import annotations

import importlib.util
import json
import os
import socket
import sys
import tempfile
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "plugins" / "daimon-bridge"
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fake_agent import FakeAgent  # noqa: E402


def _load_plugin():
    spec = importlib.util.spec_from_file_location(
        "daimon_bridge_plugin", PLUGIN / "__init__.py", submodule_search_locations=[str(PLUGIN)])
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


plugin = _load_plugin()
bridge = plugin.bridge


@pytest.fixture
def sock(monkeypatch):
    d = tempfile.mkdtemp(prefix="daimon-bridge-")
    path = os.path.join(d, "agent.sock")
    monkeypatch.setenv("DAIMON_SOCK", path)
    yield path
    if os.path.exists(path):
        os.unlink(path)
    os.rmdir(d)


@pytest.fixture
def agent(sock):
    a = FakeAgent(sock).start()
    yield a
    a.stop()


def wait_for(cond, what, timeout=5.0):
    t = time.monotonic()
    while not cond():
        assert time.monotonic() - t < timeout, f"timed out: {what}"
        time.sleep(0.02)


# ---------------------------------------------------------------- wire format

def test_commands_match_link_rs_cmd_json():
    # daimon-os daimon/src/link.rs cmd_json / parse_cmd
    assert bridge.cmd_prompt("hi") == {"prompt": "hi"}
    assert bridge.cmd_confirm(True) == {"confirm": True}
    assert bridge.cmd_confirm(0) == {"confirm": False}
    assert bridge.cmd_reset() == {"reset": True}
    assert bridge.cmd_cancel() == {"cancel": True}


def test_default_socket_path(monkeypatch):
    monkeypatch.delenv("DAIMON_SOCK", raising=False)
    assert bridge.sock_path() == "/run/daimon/agent.sock"
    monkeypatch.setenv("DAIMON_SOCK", "/tmp/x.sock")
    assert bridge.sock_path() == "/tmp/x.sock"


def test_render_joins_stream_deltas():
    t = bridge.Transcript()
    for ev in ({"ev": "user", "s": "q"}, {"ev": "think", "s": "a"}, {"ev": "think", "s": "b"},
               {"ev": "text", "s": "x"}, {"ev": "text", "s": "y"}, {"ev": "ctx", "n": 3},
               {"ev": "progress", "done": 1, "total": 2}, {"ev": "done", "tok_s": 2.0}):
        t.add(ev)
    assert t.text() == "› q\n(thinking) ab\nxy\n— done (2.0 tok/s)"


# ---------------------------------------------------------------- a full turn with a controller question

def test_prompt_confirm_yes_flow(agent):
    b = bridge.Bridge(wait=5)
    out = b.handle("prompt please reboot")
    assert agent.commands == [{"prompt": "please reboot"}]
    assert "› please reboot" in out
    assert "(thinking) The owner wants this." in out
    assert "Rebooting now." in out
    assert '⚙ power {"action":"reboot"}' in out
    assert "⚖ action check" in out and "✗ 0.10 Is it reversible?" in out
    assert out.rstrip().endswith("(no answer in 120 s counts as no)")  # stops at the question
    assert "THE CONTROLLER ASKS: risky: power" in out
    assert b.link.pending.startswith("risky: power")

    out = b.handle("yes")
    assert agent.commands[-1] == {"confirm": True}
    assert "✓ allowed by the owner" in out
    assert "→ rebooting in 5 s" in out
    assert out.rstrip().endswith("— done (14.5 tok/s)")
    assert b.link.pending is None and not b.link.busy
    assert agent.stray_confirms == []


def test_prompt_confirm_no_flow(agent):
    b = bridge.Bridge(wait=5)
    b.handle("prompt reboot it")
    out = b.handle("no")
    assert agent.commands[-1] == {"confirm": False}
    assert "✗ denied" in out and "Not rebooting." in out


def test_plain_turn_ends_at_done(agent):
    b = bridge.Bridge(wait=5)
    out = b.handle("prompt hostname?")
    assert "⚙ read" in out and "→ daimon" in out and "The hostname is daimon." in out
    assert out.endswith("— done (14.5 tok/s)")
    assert "ASKS" not in out


def test_answer_without_open_question_sends_nothing(agent):
    b = bridge.Bridge(wait=5)
    assert "no controller question is open" in b.handle("yes")
    assert "no controller question is open" in b.handle("confirm no")
    b.handle("prompt hostname?")
    assert "no controller question is open" in b.handle("y")
    assert all("confirm" not in c for c in agent.commands)
    assert agent.stray_confirms == []


def test_prompt_refused_while_question_open(agent):
    b = bridge.Bridge(wait=5)
    b.handle("prompt reboot")
    out = b.handle("prompt something else")
    assert "answer it before" in out
    assert [c for c in agent.commands if "prompt" in c] == [{"prompt": "reboot"}]


def test_cancel_during_question_denies(agent):
    b = bridge.Bridge(wait=5)
    b.handle("prompt reboot")
    out = b.handle("cancel")
    assert {"cancel": True} in agent.commands
    assert "✗ denied" in out and "done" in out
    assert b.link.pending is None


def test_cancel_when_idle_sends_nothing(agent):
    b = bridge.Bridge(wait=5)
    assert "idle" in b.handle("cancel")
    assert agent.commands == []


def test_reset(agent):
    b = bridge.Bridge(wait=5)
    b.handle("prompt hostname?")
    out = b.handle("reset")
    assert agent.commands[-1] == {"reset": True}
    assert "· new conversation" in out and "· the brain is ready" in out


def test_timeout_hands_back_and_watch_resumes(sock):
    a = FakeAgent(sock, step_delay=0.6).start()
    try:
        b = bridge.Bridge(wait=0.3)
        out = b.handle("prompt hostname?")
        assert "still running" in out and "done" not in out
        b.wait = 5
        out = b.handle("watch")
        assert "The hostname is daimon." in out and out.endswith("— done (14.5 tok/s)")
        assert "idle" in b.handle("watch")
    finally:
        a.stop()


def test_other_windows_turn_is_shown_and_mine_waited_for(sock):
    a = FakeAgent(sock, step_delay=0.3).start()
    try:
        other = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        other.connect(sock)
        other.sendall(b'{"prompt":"hostname?"}\n')
        b = bridge.Bridge(wait=5)
        wait_for(lambda: a.commands, "other window's prompt")
        out = b.handle("prompt what time is it")
        # the earlier turn's done does not end the wait: it ends at *this* prompt's done
        assert out.index("› what time is it") < out.rindex("— done")
        other.close()
    finally:
        a.stop()


# ---------------------------------------------------------------- reconnect / replay

def test_replay_restores_open_question_without_reprinting(agent):
    first = bridge.Bridge(wait=5)
    first.handle("prompt reboot")
    second = bridge.Bridge(wait=5)  # e.g. the console restarted mid-question
    status = second.handle("status")
    assert "a turn is in progress" in status and "THE CONTROLLER ASKS" in status
    out = second.handle("yes")  # the replay itself is not printed again
    assert "› reboot" not in out and "✓ allowed by the owner" in out
    assert agent.stray_confirms == []


# ---------------------------------------------------------------- fail closed

def test_missing_socket_refuses(sock):
    b = bridge.Bridge(wait=1)
    for cmd in ("prompt reboot", "yes", "cancel", "reset", "watch"):
        out = b.handle(cmd)
        assert out.startswith("✗ daimon-bridge refused: no agent socket at " + sock), out
        assert "Nothing was executed" in out
    assert "DOWN" in b.handle("status")


def test_not_a_socket_refuses(sock):
    Path(sock).write_text("not a socket")
    assert "is not a socket" in bridge.Bridge(wait=1).handle("prompt hi")


def test_dead_socket_file_refuses(sock):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(sock)  # bound, never listening: a stale socket from a crashed agent
    s.close()
    out = bridge.Bridge(wait=1).handle("prompt hi")
    assert "cannot reach the agent" in out


def test_agent_dies_mid_turn(sock):
    a = FakeAgent(sock, confirm_timeout=30).start()
    b = bridge.Bridge(wait=5)
    b.handle("prompt reboot")
    a.stop()
    out = b.handle("yes")
    assert "refused" in out or "lost the agent" in out
    assert "refused: no agent socket" in b.handle("prompt again")
    # it comes back: the bridge reconnects on its own
    a2 = FakeAgent(sock).start()
    try:
        assert "The hostname is daimon." in b.handle("prompt hostname?")
    finally:
        a2.stop()


def test_help_and_usage(agent):
    b = bridge.Bridge(wait=1)
    assert "/daimon prompt <text>" in b.handle("")
    assert b.handle("prompt") == "usage: /daimon prompt <text>"
    # an unknown verb is never treated as a prompt
    assert "/daimon prompt <text>" in b.handle("reboot the box")
    assert agent.commands == []


# ---------------------------------------------------------------- guard + plugin registration

def test_guard_blocks_local_tools_fail_closed():
    assert bridge.guard_decision("terminal")["action"] == "block"
    assert bridge.guard_decision("terminal", "garbage")["action"] == "block"
    assert bridge.guard_decision("read_file", "block", ["read_file"]) is None
    assert bridge.guard_decision("terminal", "off") is None


class FakeCtx:
    def __init__(self, settings=None):
        self.settings = settings or {}
        self.commands, self.hooks = {}, {}

    def get_config(self, key, default=None):
        return self.settings.get(key, default)

    def register_command(self, name, handler, description="", args_hint=""):
        self.commands[name] = handler

    def register_hook(self, name, cb):
        self.hooks[name] = cb


def test_register_wires_command_and_guard(sock):
    ctx = FakeCtx({"allow_tools": ["skills_list"]})
    plugin.register(ctx)
    assert set(ctx.commands) == {"daimon"} and set(ctx.hooks) == {"pre_tool_call"}
    guard = ctx.hooks["pre_tool_call"]
    assert guard(tool_name="terminal", args={"command": "reboot"}, task_id="t")["action"] == "block"
    assert guard(tool_name="skills_list", args={}, task_id="t") is None
    # no socket: the command refuses, it does not raise into the console
    assert "refused" in ctx.commands["daimon"]("prompt hi")


def test_register_end_to_end(agent):
    ctx = FakeCtx()
    plugin.register(ctx)
    out = ctx.commands["daimon"]("prompt reboot")
    assert "THE CONTROLLER ASKS" in out
    assert "✓ allowed" in ctx.commands["daimon"]("yes")
    assert [json.dumps(c) for c in agent.commands] == ['{"prompt": "reboot"}', '{"confirm": true}']
