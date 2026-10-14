# daimon-console — the Daimon skin of Hermes Agent (overlay repo, no fork)

Daimon's console is **upstream [Hermes Agent](https://github.com/NousResearch/hermes-agent) (MIT),
pinned and unmodified**, plus this overlay. Everything Daimon-specific lives here, in files the
upstream code is designed to load from the outside (skins, widgets, plugins, config). This is
what makes upgrading free: `scripts/sync-upstream.sh <ref>` moves the pin, verifies the skin
contract, re-applies the (empty, hopefully) patch queue — and that's it.

## Why not a fork

A re-skinned fork re-creates itself on every upstream release and silently diverges. Hermes
already ships a theme SDK — palette, `banner_logo`/`banner_hero` ASCII art, `branding`
(agent name, welcome, prompt symbol, help header), per-tool emoji, `custom_css` for the GUI —
so **the entire Daimon visual identity is a YAML file**, not a diff. Code-level Daimon hooks
(socket adapter, decision cards) attach through the plugin/widget surfaces, also external.
Trademark rule from the PLAN stays satisfied: the binary remains Hermes internally, the user
sees only Daimon.

## Layout

```
skins/daimon.yaml        ← the whole visual identity (palette + branding + banner)
config/base.yaml         ← Hermes config for the Daimon box (brain endpoint, skin, prefs)
widgets/decision-card.mjs ← TUI widget app: the controller's verdicts as a docked card stack
plugins/daimon-bridge/   ← Hermes plugin: the socket adapter to Daimon's agent.sock
tests/                   ← fake agent socket + adapter/widget tests (pytest + node:test, no Hermes needed)
.github/workflows/ci.yml ← the PR gate: sync-upstream.sh contract check + pytest (incl. the node suite)
scripts/install.sh       ← renders the overlay into a $HERMES_HOME (idempotent)
scripts/sync-upstream.sh ← bump + verify the UPSTREAM.lock pin (the whole upgrade ritual)
UPSTREAM.lock            ← exact upstream commit this overlay was verified against
patches/                 ← LAST RESORT downstream diffs, see patches/README.md
```

## Socket adapter — `plugins/daimon-bridge` (PLAN 0.10)

On the box the console **does not own an execution loop**: the Daimon agent does, and its
controller judges every mutation. The adapter is a plain Hermes plugin (`plugin.yaml` +
`register(ctx)`), installed into `$HERMES_HOME/plugins/daimon-bridge/` and enabled by
`config/base.yaml` (`plugins.enabled`).

**SDK surfaces — the choice:**

| Surface | Used | Why |
|---|---|---|
| `ctx.register_command` → `/daimon` | **yes** | the only surface identical in the CLI, the Ink TUI and the gateway; its input is the *owner's keyboard*, which is what a controller question needs |
| `ctx.register_hook("pre_tool_call")` | **yes** | blocks the console's *own* tool calls (`{"action":"block"}`), so nothing on the box executes outside the Daimon agent |
| `ctx.register_tool` | no | would put the console's LLM between the owner and the controller (it could prompt the agent or answer confirmations on the owner's behalf) |
| `ctx.inject_message` | no | starts a turn of the *console's* model — the opposite of the goal |

**Commands** (`/daimon …`):

| | sends | then shows |
|---|---|---|
| `prompt <text>` | `{"prompt":"<text>"}` | the agent's events until *that* turn's `done`/`err`, a controller question, or `turn_wait` s |
| `yes` / `no` | `{"confirm":true\|false}` — **only while a question is open** | the rest of the turn |
| `cancel` | `{"cancel":true}` (only while busy; an open question counts as no) | the end of the turn |
| `reset` | `{"reset":true}` | `new conversation` … `the brain is ready` |
| `watch` | nothing | buffered + live events (after a timeout, or another window's turn) |
| `status` | nothing | socket up/down, turn in progress, open question |

**Wire contract** (daimon-os `daimon/src/link.rs`, verified against it): Unix stream socket, one
JSON object per line. A new connection receives `{"ev":"sync"}`, the conversation so far, then
`{"ev":"live"}`; the adapter uses the replay only to rebuild state (open question, busy turn),
and prints live events: `user`, `think`/`text` (stream deltas, joined), `tool` (`name`,`args`),
`tool_out`, `info`, `confirm`, `answered`, `judging`, `judge` (rows printed as text — the
visual form is the decision-card widget below), `done`, `err`, `ready`, `sync`; `ctx`/`progress`
are not printed.

**Invariants:**
- **Fail closed.** Socket path missing, not a socket, refusing connections, or dropped mid-turn ⇒
  `/daimon` answers `✗ daimon-bridge refused: …` and sends nothing; it never falls back to
  executing locally. The console itself (chat, skins, other slash commands) keeps working; the
  next `/daimon` reconnects on its own when the agent is back.
- **No stray confirmations.** `yes`/`no` are sent only while a `confirm` is open (tracked from
  `confirm`/`answered`/`sync`, including the replay): the agent would read a stray answer as the
  answer to its *next* question.
- **The console is a window.** Leaving `/daimon` (timeout, Ctrl-C, console crash) never stops the
  agent's turn; only `cancel` does.
- **Guard.** `guard: block` (default; anything but an explicit `off` blocks) refuses every local
  tool call; `allow_tools` lists tools the owner explicitly lets the console run.
- **No secrets, no root.** The only input is `DAIMON_SOCK` (default `/run/daimon/agent.sock`);
  the plugin needs read/write on that socket, nothing else.

Settings (`plugins.entries.daimon-bridge.settings`): `guard` (`block`|`off`), `allow_tools`
(list), `turn_wait` (s, default 300).

Tests: `pytest tests/` — `tests/fake_agent.py` is a scripted agent socket (hub replay, broadcast,
a `power` call the controller asks about); `python tests/fake_agent.py /tmp/agent.sock` runs it
standalone for trying a real console with `DAIMON_SOCK=/tmp/agent.sock`.

## Decision cards — `widgets/decision-card.mjs` (PLAN 0.10)

The Daimon rule: the owner **sees** what the controller judged and why — on every surface. In the
Ink TUI that surface is a widget app (upstream's `$HERMES_HOME/tui-widgets/` contract: an ESM file
default-exporting `register(sdk)`, hot-loaded, no build step). `install.sh` copies it there.

```
 ◆ DAIMON · decisions                  ● live
 ◆ action check · judged in 1.5 s
 power {"action":"reboot"}
 ✗ Is it reversible?
   ███░░░░░░░░░░░░░│░░░░░░░░░  10%  ≥60%      ← p bar, │ = the rule's threshold
  ✗ D E N Y                score 0.40 · asks   ← red/green strip: verdict + score
 ? risky: power {"action":"reboot"}  -- allow? [y/n]
 answer: /daimon yes|no                         ← the owner types it; the widget never does
 ✓ ALLOW 0.91 · read {"path":"/etc/hostname"}   ← older cards, collapsed to their verdict
```

- **Read-only window** on `DAIMON_SOCK` (default `/run/daimon/agent.sock`): consumes `judging`,
  `judge` (+ `rows`: `question`/`p`/`rule`/`ok`), `confirm`, `answered` (and `sync`/`live` + turn
  boundaries). It **writes nothing** to the socket: answers are human-only, via `/daimon yes|no`.
- **Stack**: newest card on top, shown in full; the last 3 are kept, older ones collapse to their
  verdict strip and the owner's answer. The replay after a (re)connect rebuilds the stack.
- **Never breaks the TUI**: missing/refusing/dropped socket or garbage on the wire ⇒ a quiet idle
  card (`○ idle · no agent socket yet — waiting`) and reconnects with backoff (0.5 → 10 s); every
  handler swallows its errors; agent text is stripped of control characters (no escape injection).
- **No Daimon, no widget**: without `DAIMON_SOCK` and `/run/daimon`, `register()` is a no-op (no
  command, no dock, no timers) — installing on a dev machine is harmless.
- **Placement**: docks itself in the right rail on load (`zone: top-right`, 48 cols reserved);
  `/decision-card` toggles it, `/decision-card <socket>` points it at another socket.
- **Palette**: the card paints its own slate `#0f172a` background, so it uses the matching
  `skins/daimon.yaml` hexes (green `#22c55e`, red `#f87171`, …) rather than terminal-adapted theme
  tones; a test asserts they equal the skin's values.

Try it: `python tests/fake_agent.py /tmp/agent.sock`, then `DAIMON_SOCK=/tmp/agent.sock hermes --tui`
and `/daimon prompt please reboot`. Tests: `node --test tests/decision_card.test.mjs` (also run by
`pytest tests/`) — card snapshots from scripted judge+confirm sequences, the idle/backoff path with
no socket, a scripted hub proving the widget never writes, and a round-trip against
`tests/fake_agent.py` with the owner answering from another window.

## CI

`.github/workflows/ci.yml` runs on every push and PR: `scripts/sync-upstream.sh` (the skin and
widget contract against the pinned upstream), then `python3 -m pytest tests/ -q`, which includes the
node widget suite (node is required in CI). It must be green to merge.

## Rules (breaking these is what fork-sickness looks like — don't)

1. **Never edit upstream source.** If a change cannot be expressed as a skin key, a widget,
   a plugin or a config value, write it in `patches/` as a `git format-patch` file *and open
   an upstream PR* — the patch must be upstreamable or it dies in review.
2. `sync-upstream.sh` must go green before the lock is bumped. The checks are the contract:
   if they fail, upstream renamed something and the overlay must adapt first.
3. Skins only contain `#rrggbb` hexes and keep the full key set; missing keys silently
   inherit `default` and that resets backgrounds (known Hermes pitfall).
4. Daimon product code (`daimon-os` repo) stays separate: this repo ships the *console*,
   `daimon-os` supervises it as a module on `/data` (integration shape A, PLAN 0.10).

## On the Daimon box (shape A, first boot)

```
python -m venv /data/console/venv
/data/console/venv/bin/pip install git+<mirror>/hermes-agent.git@<UPSTREAM.lock#commit>
daimon-console/scripts/install.sh --home /data/daimon/hermes   # skins + config + widgets + plugins
# then `daimon console` (supervised module) runs hermes with HERMES_HOME=/data/daimon/hermes
```

Config points the model endpoint at the Daimon brain (llama-server, loopback, OpenAI-compatible):
see `config/base.yaml`. Every mutation still flows through `agent.sock` — the console is a
window, the controller is the judge (Daimon invariants, PLAN 0.3+).
