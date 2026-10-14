"""daimon-bridge core: the console as a *window* on Daimon's agent socket.

Pure stdlib, no Hermes import — the plugin wiring lives in ``__init__.py`` and the tests import
this module directly. Wire format (daimon-os ``daimon/src/link.rs``): a Unix stream socket, one
JSON object per line, both directions.

  in  (window → agent):  {"prompt":"..."}  {"confirm":true|false}  {"reset":true}  {"cancel":true}
  out (agent → window):  {"ev":"user|think|text|tool|tool_out|info|confirm|answered|ctx|progress|
                          judging|judge|done|err|ready|sync", ...}
  A window that connects first gets {"ev":"sync"}, the conversation so far, then {"ev":"live"}.

Invariants this module enforces:
  * fail closed — no socket, a dead socket, or a lost connection means *refuse*; nothing here
    can execute anything locally, it only relays text to the agent;
  * a ``confirm`` answer is sent only while a controller question is open: the agent reads a
    stray answer as the answer to the *next* question (agent.rs ``controller_allows``);
  * the console is one window among others: leaving it (timeout, Ctrl-C, crash) never stops
    the agent's turn — only an explicit cancel does.
"""

from __future__ import annotations

import collections
import json
import os
import socket
import stat
import threading
import time

DEFAULT_SOCK = "/run/daimon/agent.sock"
LIVE_TIMEOUT = 5.0  # connect → end of the replay
TOOL_OUT_MAX = 1200  # chars of a tool's output shown in the console
BUFFER_MAX = 5000  # live events kept for the next command; oldest dropped first

# events that end a wait on the agent (the turn ended, or the owner must decide)
_TURN_END = ("done", "err")


class BridgeDown(Exception):
    """The agent socket is missing, not a socket, or the connection broke."""


def sock_path() -> str:
    return os.environ.get("DAIMON_SOCK") or DEFAULT_SOCK


# ------------------------------------------------------------------ wire format (link.rs cmd_json)

def cmd_prompt(text: str) -> dict:
    return {"prompt": text}


def cmd_confirm(yes: bool) -> dict:
    return {"confirm": bool(yes)}


def cmd_reset() -> dict:
    return {"reset": True}


def cmd_cancel() -> dict:
    return {"cancel": True}


# ------------------------------------------------------------------ the connection (one window)

class Link:
    """One connection to the agent. A reader thread keeps the window's view of the agent (open
    question, turn in progress) and buffers live events until a command consumes them."""

    def __init__(self, path: str):
        self.path = path
        self.pending: str | None = None  # the open controller question, if any
        self.busy = False  # a turn is in progress
        self.dropped = 0  # live events lost to the buffer cap
        self._sock: socket.socket | None = None
        self._up = False
        self._live = threading.Event()
        self._cv = threading.Condition()
        self._events: collections.deque = collections.deque()
        self._wlock = threading.Lock()

    @property
    def up(self) -> bool:
        return self._up

    def connect(self, timeout: float = LIVE_TIMEOUT) -> "Link":
        try:
            st = os.stat(self.path)
        except FileNotFoundError:
            raise BridgeDown(f"no agent socket at {self.path} (is module `agent` running?)") from None
        except OSError as e:
            raise BridgeDown(f"{self.path}: {e.strerror or e}") from None
        if not stat.S_ISSOCK(st.st_mode):
            raise BridgeDown(f"{self.path} is not a socket")
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(timeout)
        try:
            s.connect(self.path)
        except OSError as e:
            s.close()
            raise BridgeDown(f"cannot reach the agent at {self.path}: {e.strerror or e}") from None
        s.settimeout(None)
        self._sock, self._up = s, True
        threading.Thread(target=self._read, name="daimon-bridge-reader", daemon=True).start()
        if not self._live.wait(timeout):
            self.close()
            raise BridgeDown(f"the agent at {self.path} did not finish its replay in {timeout:.0f} s")
        return self

    def close(self) -> None:
        self._up = False
        if self._sock is not None:
            try:
                self._sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self._sock.close()

    def send(self, cmd: dict) -> None:
        if not self._up or self._sock is None:
            raise BridgeDown("lost the agent (module agent)")
        line = (json.dumps(cmd, ensure_ascii=False) + "\n").encode()
        try:
            with self._wlock:
                self._sock.sendall(line)
        except OSError as e:
            self._down()
            raise BridgeDown(f"lost the agent: {e.strerror or e}") from None

    def next(self, timeout: float) -> dict | None:
        """The next live event, or None after ``timeout`` s. After the link drops: ``{"ev":"_down"}``."""
        with self._cv:
            if not self._events and self._up:
                self._cv.wait(timeout)
            if self._events:
                return self._events.popleft()
            return None if self._up else {"ev": "_down"}

    def drain(self) -> list:
        """Every buffered live event, without waiting."""
        with self._cv:
            evs = list(self._events)
            self._events.clear()
            return evs

    # -- reader thread

    def _read(self) -> None:
        assert self._sock is not None
        try:
            for raw in self._sock.makefile("rb"):
                try:
                    ev = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(ev, dict) or not isinstance(ev.get("ev"), str):
                    continue
                if ev["ev"] == "live":
                    self._live.set()
                    continue
                self._track(ev)
                # the replay only rebuilds state; the owner saw it already in whichever window was open
                if self._live.is_set():
                    with self._cv:
                        if len(self._events) >= BUFFER_MAX:
                            self._events.popleft()
                            self.dropped += 1
                        self._events.append(ev)
                        self._cv.notify_all()
        except (OSError, ValueError):
            pass
        self._down()

    def _down(self) -> None:
        with self._cv:
            self._up = False
            self._cv.notify_all()

    def _track(self, ev: dict) -> None:
        kind = ev["ev"]
        if kind == "sync":
            self.pending, self.busy = None, False
        elif kind == "user":
            self.busy = True
        elif kind == "confirm":
            self.pending = str(ev.get("s", ""))
        elif kind == "answered":
            self.pending = None
        elif kind in _TURN_END:
            self.busy = False


# ------------------------------------------------------------------ plain-text rendering

class Transcript:
    """Events → plain text. ``think``/``text`` arrive as stream deltas and are joined."""

    def __init__(self) -> None:
        self.parts: list[str] = []
        self._run: str | None = None  # "think" | "text" while a delta run is open

    def add(self, ev: dict) -> None:
        kind = ev.get("ev")
        if kind in ("think", "text"):
            s = str(ev.get("s", ""))
            if self._run != kind:
                self._run = kind
                self.parts.append("\n(thinking) " if kind == "think" else "\n")
            self.parts.append(s)
            return
        line = render(ev)
        if line is not None:
            self._run = None
            self.parts.append("\n" + line)

    def note(self, line: str) -> None:
        self._run = None
        self.parts.append("\n" + line)

    def text(self) -> str:
        return "".join(self.parts).strip("\n")


def render(ev: dict) -> str | None:
    """One non-delta event as a line; None for events the console does not show."""
    kind, s = ev.get("ev"), str(ev.get("s", ""))
    if kind == "user":
        return f"› {s}"
    if kind == "tool":
        return f"⚙ {ev.get('name', '?')} {ev.get('args', '')}"
    if kind == "tool_out":
        return "  → " + (s if len(s) <= TOOL_OUT_MAX else s[:TOOL_OUT_MAX] + f" … ({len(s)} chars)")
    if kind == "info":
        return f"· {s}"
    if kind == "confirm":
        return question(s)
    if kind == "answered":
        return "✓ allowed by the owner" if ev.get("yes") else "✗ denied"
    if kind == "judging":
        return f"⚖ controller judging {ev.get('kind', '')}: {ev.get('subject', '')}"
    if kind == "judge":
        rows = "".join(
            f"\n    {'✓' if r.get('ok') else '✗'} {r.get('p', 0):.2f} {r.get('question', '')} ({r.get('rule', '')})"
            for r in ev.get("rows") or [])
        return (f"⚖ {ev.get('kind', '')} — {ev.get('subject', '')}: {ev.get('verdict', '')} "
                f"(score {ev.get('score', 0):.2f}, {'allowed' if ev.get('allowed') else 'not allowed'}, "
                f"{ev.get('secs', 0):.1f} s){rows}")
    if kind == "done":
        return f"— done ({ev.get('tok_s', 0):.1f} tok/s)"
    if kind == "err":
        return f"✗ {s}"
    if kind == "ready":
        return "· the brain is ready" if ev.get("ok") else "✗ the brain's warm-up gave up"
    if kind == "sync":
        return "· new conversation"
    return None  # ctx, progress: live gauges, nothing to print


def question(s: str) -> str:
    return (f"⚠ THE CONTROLLER ASKS: {s}\n"
            "  answer with  /daimon yes  or  /daimon no   (no answer in 120 s counts as no)")


# ------------------------------------------------------------------ guard (pre_tool_call)

GUARD_MESSAGE = ("daimon-bridge: on the Daimon box the console does not execute tools — the Daimon "
                 "agent does, and its controller judges every mutation. Ask it with "
                 "`/daimon prompt <request>`.")


def guard_decision(tool_name: str, mode: str = "block", allow: list | tuple = ()) -> dict | None:
    """The ``pre_tool_call`` verdict for a *local* tool call. Anything but an explicit ``off``
    blocks (fail closed); ``allow`` names tools the owner trusts to run locally."""
    if mode == "off" or tool_name in set(allow or ()):
        return None
    return {"action": "block", "message": GUARD_MESSAGE}


# ------------------------------------------------------------------ the bridge (commands)

HELP = """/daimon — the console's link to the Daimon agent (socket {path})
  /daimon prompt <text>   send a request; shows the agent's work until the turn ends or the controller asks
  /daimon yes | no        answer the open controller question
  /daimon watch           keep following the agent (after a timeout, or another window's turn)
  /daimon cancel          stop the current turn (an open question counts as no)
  /daimon reset           start a new conversation
  /daimon status          socket, turn, open question"""


class Bridge:
    """The ``/daimon`` command. One persistent link, (re)connected on demand; every failure is a
    refusal message, never an exception into the console and never a local fallback."""

    def __init__(self, wait: float = 300.0):
        self.wait = wait
        self.link: Link | None = None
        self._lock = threading.Lock()

    def handle(self, raw: str) -> str:
        verb, _, rest = (raw or "").strip().partition(" ")
        verb, rest = verb.lower(), rest.strip()
        with self._lock:
            try:
                if verb == "prompt":
                    return self.prompt(rest) if rest else "usage: /daimon prompt <text>"
                if verb in ("yes", "y", "no", "n"):
                    return self.confirm(verb.startswith("y"))
                if verb == "confirm" and rest.lower() in ("yes", "y", "no", "n", "true", "false"):
                    return self.confirm(rest.lower() in ("yes", "y", "true"))
                if verb == "cancel":
                    return self.cancel()
                if verb == "reset":
                    return self.reset()
                if verb in ("watch", "follow"):
                    return self.watch()
                if verb == "status":
                    return self.status()
                return HELP.format(path=sock_path())
            except BridgeDown as e:
                self._drop()
                return f"✗ daimon-bridge refused: {e}. Nothing was executed; the console itself still works."

    # -- verbs

    def prompt(self, text: str) -> str:
        link = self._ensure()
        if link.pending is not None:
            return question(link.pending) + "\n(answer it before sending a new request)"
        out = Transcript()
        earlier = link.drain()
        if earlier:
            out.note("(earlier, while nobody was watching)")
            for ev in earlier:
                out.add(ev)
            out.note("(now)")
        link.send(cmd_prompt(text))
        return self._pump(link, mine=text, out=out)

    def confirm(self, yes: bool) -> str:
        link = self._ensure()
        if link.pending is None:
            # a stray answer would be taken as the answer to the agent's *next* question
            return "no controller question is open — nothing sent"
        link.send(cmd_confirm(yes))
        return self._pump(link)

    def cancel(self) -> str:
        link = self._ensure()
        if not link.busy and link.pending is None:
            return "the agent is idle — nothing to cancel"
        link.send(cmd_cancel())
        return self._pump(link, wait=min(self.wait, 30.0))

    def reset(self) -> str:
        link = self._ensure()
        link.send(cmd_reset())
        return self._pump(link, until=("ready",), wait=min(self.wait, 200.0))

    def watch(self) -> str:
        link = self._ensure()
        if link.pending is not None:
            return question(link.pending)
        if not link.busy:
            out = self._pump(link, wait=0.2)
            return out or "the agent is idle"
        return self._pump(link)

    def status(self) -> str:
        path = sock_path()
        try:
            link = self._ensure()
        except BridgeDown as e:
            self._drop()
            return f"✗ agent: DOWN ({e}) — /daimon refuses until it is back"
        state = "a turn is in progress" if link.busy else "idle"
        lines = [f"agent: up at {path} — {state}"]
        if link.pending is not None:
            lines.append(question(link.pending))
        if link.dropped:
            lines.append(f"({link.dropped} events were dropped while nobody was watching)")
        return "\n".join(lines)

    # -- plumbing

    def _ensure(self) -> Link:
        path = sock_path()
        if self.link is not None and self.link.up and self.link.path == path:
            return self.link
        self._drop()
        self.link = Link(path).connect()
        return self.link

    def _drop(self) -> None:
        if self.link is not None:
            self.link.close()
        self.link = None

    def _pump(self, link: Link, mine: str | None = None, until: tuple = (), wait: float | None = None,
              out: Transcript | None = None) -> str:
        """Show live events until the turn ends (``done``/``err``), the controller asks, ``until``
        arrives, the link drops or ``wait`` s pass. With ``mine``, the turn that ends the wait is
        the one started by that prompt (an earlier turn from another window may finish first)."""
        out = out or Transcript()
        deadline = time.monotonic() + (self.wait if wait is None else wait)
        seen_mine = mine is None
        try:
            while True:
                left = deadline - time.monotonic()
                if left <= 0:
                    if link.busy or link.pending is not None:
                        out.note("… still running — /daimon watch to keep following, /daimon cancel to stop")
                    return out.text()
                ev = link.next(min(left, 0.5))
                if ev is None:
                    continue
                kind = ev["ev"]
                if kind == "_down":
                    self._drop()
                    out.note("✗ lost the agent (module agent). Nothing runs locally; /daimon refuses until it is back.")
                    return out.text()
                out.add(ev)
                if kind == "user" and not seen_mine and ev.get("s") == mine:
                    seen_mine = True
                if kind == "confirm" or kind in until:
                    return out.text()
                if kind == "sync" and not until:
                    return out.text()
                if kind in _TURN_END and seen_mine:
                    return out.text()
        except KeyboardInterrupt:
            out.note("… stopped following; the agent's turn goes on — /daimon watch | /daimon cancel")
            return out.text()
