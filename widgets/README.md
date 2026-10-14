# widgets/ — TUI widget apps (Daimon additions, zero upstream edits)

Docked widget apps for the Hermes Ink TUI (`~/.hermes/tui-widgets/`, see Hermes
docs → tui-widgets). Planned for 0.10:

- `decision-card.mjs` — renders the controller verdicts (question / probability
  bar / threshold / verdict) as a live panel, reading the event flow from
  `agent.sock` via the socket adapter. The Daimon rule: the owner always sees
  *what* was judged and *why*, on every surface.

Status: stub — implementation is the next 0.10 subtask (same slot as the
socket-adapter plugin that feeds it).
