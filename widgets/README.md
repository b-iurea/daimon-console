# widgets/ — TUI widget apps (Daimon additions, zero upstream edits)

Docked widget apps for the Hermes Ink TUI (`$HERMES_HOME/tui-widgets/`, upstream contract in
`ui-tui/src/sdk/userWidgets.ts`): plain ESM, `export default function register(sdk)`, no build
step, hot-loaded. `scripts/install.sh` copies every `*.mjs` here into the Hermes home.

- `decision-card.mjs` — the controller's verdicts (question / probability bars / threshold /
  ALLOW·DENY with score / the owner's answer) as a card stack in the right rail, read-only on
  `agent.sock`. See the main README → *Decision cards*; tests in `tests/decision_card.test.mjs`.

Rules for widgets in this repo: never write to the agent socket (answers are the owner's), never
throw into the TUI (degrade to an idle card), and be a no-op where Daimon is absent.
