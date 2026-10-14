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
widgets/                 ← TUI widget apps (decision cards from the controller)
scripts/install.sh       ← renders the overlay into a $HERMES_HOME (idempotent)
scripts/sync-upstream.sh ← bump + verify the UPSTREAM.lock pin (the whole upgrade ritual)
UPSTREAM.lock            ← exact upstream commit this overlay was verified against
patches/                 ← LAST RESORT downstream diffs, see patches/README.md
```

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
daimon-console/scripts/install.sh --home /data/daimon/hermes   # skins + config + widgets
# then `daimon console` (supervised module) runs hermes with HERMES_HOME=/data/daimon/hermes
```

Config points the model endpoint at the Daimon brain (llama-server, loopback, OpenAI-compatible):
see `config/base.yaml`. Every mutation still flows through `agent.sock` — the console is a
window, the controller is the judge (Daimon invariants, PLAN 0.3+).
