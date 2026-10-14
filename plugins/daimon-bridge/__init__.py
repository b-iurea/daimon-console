"""daimon-bridge — Hermes plugin: the console talks to Daimon's agent socket instead of acting.

SDK surfaces used (and why — see README "Socket adapter"):
  * ``ctx.register_command("daimon", ...)`` — the in-session slash command. It is the one surface
    that works the same in the classic CLI, the Ink TUI and the gateway, and its input comes from
    the *owner's keyboard*: controller questions must be answered by the owner, never by a model.
  * ``ctx.register_hook("pre_tool_call", ...)`` — blocks the console's *own* tool calls, so the
    console never owns an execution loop on the box: the Daimon agent acts, its controller judges.
  * no ``register_tool``: a model-facing tool would put the console's LLM between the owner and
    the controller (it could send prompts or answer confirmations on the owner's behalf).

All protocol logic lives in ``bridge.py`` (stdlib only, tested without Hermes).
"""

from __future__ import annotations

import logging

from . import bridge

logger = logging.getLogger(__name__)

_DEFAULT_WAIT = 300


def register(ctx):
    def setting(key, default):
        try:
            value = ctx.get_config(key, default=default)
        except Exception:  # unreadable settings: keep the safe defaults
            return default
        return default if value is None else value

    try:
        wait = float(setting("turn_wait", _DEFAULT_WAIT))
    except (TypeError, ValueError):
        wait = float(_DEFAULT_WAIT)
    link = bridge.Bridge(wait=max(wait, 1.0))

    def on_daimon(raw_args: str) -> str:
        return link.handle(raw_args)

    def on_pre_tool_call(tool_name: str = "", **kwargs):
        mode = str(setting("guard", "block")).strip().lower()
        allow = setting("allow_tools", [])
        verdict = bridge.guard_decision(tool_name, mode, allow if isinstance(allow, list) else [])
        if verdict is not None:
            logger.info("daimon-bridge: blocked local tool call %s", tool_name)
        return verdict

    ctx.register_command(
        "daimon",
        on_daimon,
        description="Daimon agent: prompt / yes / no / watch / cancel / reset / status",
        args_hint="<prompt|yes|no|watch|cancel|reset|status> [text]",
    )
    ctx.register_hook("pre_tool_call", on_pre_tool_call)
