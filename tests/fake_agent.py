"""A fake Daimon agent socket — the hub side of daimon-os ``daimon/src/link.rs`` with a scripted agent.

Speaks the real wire format (one JSON object per line): a new window gets {"ev":"sync"}, the
history, {"ev":"live"}; every event goes to every window; commands are
{"prompt":..} {"confirm":bool} {"reset":true} {"cancel":true}.

Script: every prompt gets think/text deltas; a prompt containing "reboot" makes the agent call
the mutating ``power`` tool, the controller judge it and ask the owner (``confirm``) — like
agent.rs ``controller_allows``: yes runs it, no / cancel / timeout denies it.

Manual use against a real console:  python tests/fake_agent.py /tmp/agent.sock
"""

from __future__ import annotations

import json
import os
import queue
import socket
import sys
import threading
import time


class FakeAgent:
    def __init__(self, path: str, confirm_timeout: float = 10.0, step_delay: float = 0.0):
        self.path = path
        self.confirm_timeout = confirm_timeout
        self.step_delay = step_delay
        self.commands: list[dict] = []  # every command received, in order
        self.stray_confirms: list[dict] = []  # answers sent while no question was open
        self.history: list[str] = []
        self.windows: list[socket.socket] = []
        self._lock = threading.Lock()
        self._cmds: queue.Queue = queue.Queue()
        self._cancel = threading.Event()
        self._asking = threading.Event()
        self._stop = threading.Event()
        self._listener: socket.socket | None = None

    # -- lifecycle

    def start(self) -> "FakeAgent":
        if os.path.exists(self.path):
            os.unlink(self.path)
        ls = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        ls.bind(self.path)
        ls.listen(8)
        self._listener = ls
        threading.Thread(target=self._accept, daemon=True).start()
        threading.Thread(target=self._agent, daemon=True).start()
        return self

    def stop(self) -> None:
        """The agent dies: listener closed, every window dropped, socket file removed."""
        self._stop.set()
        if self._listener is not None:
            self._listener.close()
        with self._lock:
            for w in self.windows:
                try:
                    w.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                w.close()
            self.windows.clear()
        if os.path.exists(self.path):
            os.unlink(self.path)

    def emit(self, ev: dict) -> None:
        line = json.dumps(ev) + "\n"
        with self._lock:
            if ev["ev"] == "sync":
                self.history.clear()
            elif ev["ev"] != "progress":
                self.history.append(line)
            alive = []
            for w in self.windows:
                try:
                    w.sendall(line.encode())
                    alive.append(w)
                except OSError:
                    w.close()
            self.windows = alive

    # -- hub

    def _accept(self) -> None:
        assert self._listener is not None
        while not self._stop.is_set():
            try:
                s, _ = self._listener.accept()
            except OSError:
                return
            with self._lock:
                s.sendall(('{"ev":"sync"}\n' + "".join(self.history) + '{"ev":"live"}\n').encode())
                self.windows.append(s)
            threading.Thread(target=self._window, args=(s,), daemon=True).start()

    def _window(self, s: socket.socket) -> None:
        try:
            for raw in s.makefile("rb"):
                try:
                    cmd = json.loads(raw)
                except ValueError:
                    continue
                self.commands.append(cmd)
                if cmd.get("cancel") is True:
                    self._cancel.set()
                elif "confirm" in cmd and not self._asking.is_set():
                    self.stray_confirms.append(cmd)
                else:
                    self._cmds.put(cmd)
        except OSError:
            pass

    # -- scripted agent

    def _agent(self) -> None:
        while not self._stop.is_set():
            try:
                cmd = self._cmds.get(timeout=0.1)
            except queue.Empty:
                continue
            if cmd.get("reset") is True:
                self.emit({"ev": "sync"})
                self.emit({"ev": "ctx", "n": 0})
                self.emit({"ev": "ready", "ok": True})
            elif isinstance(cmd.get("prompt"), str):
                self._turn(cmd["prompt"])

    def _step(self) -> None:
        if self.step_delay:
            time.sleep(self.step_delay)

    def _turn(self, prompt: str) -> None:
        self._cancel.clear()
        self.emit({"ev": "user", "s": prompt})
        self.emit({"ev": "progress", "done": 1, "total": 2})
        for d in ("The owner ", "wants this."):
            self.emit({"ev": "think", "s": d})
        self._step()
        if "reboot" in prompt:
            for d in ("Rebooting ", "now."):
                self.emit({"ev": "text", "s": d})
            args = '{"action":"reboot"}'
            self.emit({"ev": "tool", "name": "power", "args": args})
            self.emit({"ev": "judging", "kind": "action check", "subject": f"power {args}"})
            self.emit({"ev": "judge", "kind": "action check", "subject": f"power {args}", "score": 0.4,
                       "allowed": False, "verdict": "asks", "secs": 1.5,
                       "rows": [{"question": "Is it reversible?", "p": 0.1, "rule": "needs >= 60%", "ok": False}]})
            yes = self._ask(f"risky: power {args}  -- allow? [y/n]")
            self.emit({"ev": "tool_out", "s": "rebooting in 5 s" if yes else
                       "denied by the owner: do not retry this action, ask what they want instead"})
            self._step()
            self.emit({"ev": "text", "s": "Done." if yes else "Not rebooting."})
        else:
            self.emit({"ev": "tool", "name": "read", "args": '{"path":"/etc/hostname"}'})
            self.emit({"ev": "tool_out", "s": "daimon\n"})
            self._step()
            for d in ("The host", "name is daimon."):
                self.emit({"ev": "text", "s": d})
        self.emit({"ev": "ctx", "n": 321})
        self.emit({"ev": "done", "tok_s": 14.5})

    def _ask(self, q: str) -> bool:
        self._asking.set()
        self.emit({"ev": "confirm", "s": q})
        start = time.monotonic()
        yes = False
        while True:
            if self._cancel.is_set():
                break
            if time.monotonic() - start >= self.confirm_timeout:
                self.emit({"ev": "info", "s": f"-- no answer within {self.confirm_timeout:.0f} s"})
                break
            try:
                cmd = self._cmds.get(timeout=0.05)
            except queue.Empty:
                continue
            if "confirm" in cmd:
                yes = cmd["confirm"] is True
                break
        self._asking.clear()
        self.emit({"ev": "answered", "yes": yes})
        return yes


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/daimon-fake-agent.sock"
    agent = FakeAgent(path, confirm_timeout=120.0, step_delay=0.5).start()
    print(f"fake daimon agent on {path} (Ctrl-C to stop)")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        agent.stop()
