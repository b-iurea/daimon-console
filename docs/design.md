# Daimon console — design system

Scope: the *look* of the Daimon console (Hermes TUI + desktop GUI) as expressed through the upstream
skin SDK (`skins/daimon.yaml`) and the existing decision-card widget. No new features, no upstream
edits. Built with the `ui-ux-pro-max` design-system pass (style: *Dark Mode (OLED)*, type: monospace,
density: dense/dashboard, motion: minimal). Its web-only outputs (landing pattern, scroll reveals)
do not apply to a terminal and are dropped.

## 1. Principles

1. **One palette, two surfaces.** The console and the framebuffer UI look like the same product.
   Source of truth is `daimon-os/daimon/src/tui.rs` (`const BG … RED: Color::Rgb(…)`). Nothing
   else may introduce a hex; `tests/decision_card.test.mjs` fails on drift.
2. **Color is a role, never decoration.** A hue means one thing everywhere (§3). Green is *reserved*
   for Daimon/ok, so it stays meaningful (hence code keywords are violet, not green).
3. **Never color alone.** Every state also carries a glyph and a word (`✓ ALLOW`, `✗ DENY`, `? ask`),
   so the UI survives 16-color terminals, `NO_COLOR`, and color-blind owners.
4. **Quiet by default, loud when the owner must act.** Chrome is slate; only a held decision (amber)
   or a failure (red) is filled, high-contrast, and bold.
5. **Sovereign.** No web-font fetches, no remote assets, system monospace only.

## 2. Color tokens

All values equal `tui.rs` (`Color::Rgb`). Contrast is WCAG on BG `#0f172a` / on SURFACE `#1e293b`.

| Token | Hex | tui.rs | Role | on BG | on SURFACE |
|---|---|---|---|---|---|
| bg | `#0f172a` | `BG` (15,23,42) | canvas; also the *ink* on filled green/amber/red | – | – |
| surface | `#1e293b` | `SURFACE` | status bar, header strips, raised rows | – | – |
| border | `#334155` | `BORDER` | rules, panel borders, empty bar tracks (decorative, 1.7:1 by design) | 1.72 | 1.41 |
| text | `#e2e8f0` | `TEXT` | body copy | 14.48 | 11.87 |
| strong | `#f8fafc` | `STRONG` | titles, numbers, the threshold marker | 17.06 | 13.98 |
| muted | `#94a3b8` | `MUTED` | labels, status text, secondary copy | 6.96 | 5.71 |
| faint | `#64748b` | `FAINT` | thinking stream, comments, hints — **non-essential only** | 3.75 | 3.07 |
| accent | `#22c55e` | `ACCENT` | Daimon speaking, allowed, ok, response border | 7.83 | 6.42 |
| sky | `#38bdf8` | `SKY` | **the owner**: prompt, answers, commands to type | 8.33 | 6.83 |
| violet | `#a78bfa` | `VIOLET` | **the controller**: ◆ header, judging, code keywords | 6.56 | 5.38 |
| amber | `#f59e0b` | `AMBER` | tool calls, warnings, **held for the owner** | 8.31 | 6.81 |
| red | `#ef4444` | `RED` | errors, deny, offline | 4.74 | 3.89 |

Rules from the numbers:

- Body/label text must be `text`, `strong` or `muted` (≥ 5.7:1 even on SURFACE).
- `faint` (3.75) is below 4.5:1 → only for text the owner can lose without harm (thinking stream, comments,
  the splash tagline). Never for state, never for an instruction.
- `red` on SURFACE is 3.89:1 → a critical state on the status bar must be bold **and** carry glyph+word
  (`✗ …`), or be a filled pill (BG ink on red = 4.74:1). Do not set long red prose on SURFACE.
- Filled chips always use **BG as ink** (green 7.83, amber 8.31, red 4.74), never white.
- Skin key ↔ token pins enforced by tests: `background`=bg, `ui_ok`=accent, `ui_error`=red, `ui_warn`=amber,
  `ui_text`=text, `ui_label`=muted, `ui_border`=border, `ui_thinking`=faint, `status_bar_bg`=surface, `prompt`=sky.

### Semantic roles (who is speaking / what it means)

| Role | Token | Where |
|---|---|---|
| Daimon (agent), ok | accent | response label/border, ok, session label, diff added, banner accent |
| Owner | sky | prompt `❯`, "answer: /daimon yes\|no", owner's recorded answer, code strings |
| Controller | violet | `◆ Controller decisions`, `⋯ judging`, code keywords |
| Tool activity / caution | amber | `┊` tool lines, warnings, held decisions, numbers in code |
| Failure | red | errors, deny, offline, diff removed |
| Chrome | border / surface | rules, status bar |

## 3. Terminal-safe constraints

- **Hex only in the skin** (`#rrggbb`), never named colors; keep the full key set (missing keys inherit
  `default` and reset backgrounds — upstream pitfall, README rule 3).
- **Truecolor → 256 → 16 degradation** is done by Rich/Ink from the hex. Design for the 16-color result
  so nothing depends on near-hue distinctions:

  | Token | 16-color target | Why it still reads |
  |---|---|---|
  | bg / surface | terminal default / bright-black | slate collapses to the terminal's own dark |
  | text / strong | white / bright-white | strong = bold white |
  | muted / faint / border | bright-black or dim white | hierarchy by dim, not hue |
  | accent | green | ✓ glyph + word |
  | sky | cyan | `❯` prompt, "answer:" label |
  | violet | magenta | `◆` marker + the word "Controller" |
  | amber | yellow | `?` + bold on the held card |
  | red | red | `✗` + word |

  Sky/violet can both land near blue-cyan; they are never the only distinction (◆ vs ❯, label text).
- **Filled pills** are `bold <BG> on <hue>` (the splash pill and the card verdict strip) — in 16 colors this
  is bold black on a base color, still legible.
- **Glyphs**: BMP only, one cell wide: `◆ ◇ ● ○ ✓ ✗ ? ⋯ ┊ │ █ ░ ❯ ✦ ⟪ ⟫ ·`. No emoji as UI structure (font-dependent,
  untokenizable); `tool_emojis` stays unset. Provide an ASCII fallback in widget code where `tui.rs` already does
  (`g("│","|")`) — follow-up §7.
- **Never assume a width above 80 columns** for chat content; the decision card is a fixed 46-cell column in
  a 48-col right rail, and must not wrap or reflow. Agent text is stripped of control characters (escape-injection safe).
- **No animation required to understand state.** The spinner (`⟪◆ … ◆⟫`) is progress feedback only.

## 4. Density and spacing

Cell-based 4-step rhythm (a terminal has no px; 1 cell ≈ 1 ch wide, 1 line tall):

| Step | Cells | Use |
|---|---|---|
| 0 | 0 | inside a component (glyph↔label already has one space) |
| 1 | 1 space | between inline items; left gutter inside a card (` ◆ `) |
| 2 | 1 blank line | between messages / cards in the stack |
| 3 | 1 rule line (`─` in border) | between header and body, never double |

- Dense by default (operator console): no blank lines inside a card; one blank line between turns.
- Prefer wrapping to truncation; truncate only with `…` (the card already does, max 2 lines for the question).
- Measure: prose ≤ ~100 cols; the card column is fixed at 46.
- Alignment: numbers right-aligned or in fixed columns (`10%`, `≥60%`, `score 0.40`) so they don't jitter.

## 5. Component patterns

### 5.1 Splash banner (semantics)

```
 ✦ Daimon                 ← banner_logo: green pill, BG ink — identity. Acceptance test matches "✦ Daimon" bytes
 · sovereign · local · yours ·                ← faint tagline (non-essential)
 ◆ every action is judged                     ← violet = controller
 ◆ you have the last word                     ← sky    = owner
 ◆ nothing leaves the box                     ← green  = Daimon / local
```

The three ◆ lines are the product's trust model in the same hue roles used by the decision card, so the first
screen teaches the color language. Static text only: no live status on the splash (liveness belongs to the
card header and status bar). `banner_logo` is frozen — daimon-os acceptance matches it. Hero edits must keep it ≤ 5 lines.

### 5.2 Status line (`status_bar_*`)

SURFACE background, MUTED text. States are word+glyph, color is a reinforcement:

| State | Key | Token | Example |
|---|---|---|---|
| normal | `status_bar_good` | accent | `● online` |
| attention | `status_bar_warn` | amber | `? waiting for you` |
| critical | `status_bar_critical` | red (bold, glyph) | `✗ agent offline` |

Left→right order is stable: link state · model/brain · turn state · context. Critical is the only red on the bar
(3.89:1 on SURFACE → bold + glyph required, see §2).

### 5.3 Decision card (`widgets/decision-card.mjs`)

Header `◆ Controller decisions` (violet) + link state in words: `● agent online` (accent) ·
`○ agent offline` (red; cards shown are last known) · `○ waiting for agent` (amber). Body: kind · timing, 
(amber-free, `text`), checked rows (`✓/✗` accent/red + question, p bar: `█` filled = accent when ok else red, `░` track = border,
`│` threshold marker = strong), then the **verdict strip** and, if held, the owner prompt.

| State | Strip (BG ink, bold) | Glyph/word | Then | Owner line |
|---|---|---|---|---|
| **Allow** | accent fill | `✓ A L L O W 0.91` | nothing to do | collapsed to `✓ ALLOW 0.91 · subject` |
| **Ask** (held for the owner) | amber fill | `✗ D E N Y 0.40 · asks` (+ rows) | `? <question>` in amber, `answer: /daimon yes\|no` (sky) | after answer: `owner: ✓ allowed` (accent) / `✗ denied` (red) |
| **Deny** (final / no verdict) | red fill | `✗ D E N Y` / `no verdict` | no prompt | – |
| Judging | surface fill, violet text | `⋯ J U D G I N G` | – | – |
| Idle/offline | no strip | `○ waiting for agent · …` | reconnects (0.5 → 10 s backoff) | – |

Layout rules: newest on top, full; last 3 kept, older ones collapse to one strip line (`✓ ALLOW 0.91 · …`);
the widget never answers (read-only), the owner types `/daimon yes|no`. Verdict strips use the same fill/ink
pair as the banner pill, so "filled = Daimon decided something" is one visual idea.

### 5.4 Messages, tools and diffs

- Daimon reply: label ` ◆ Daimon ` (accent), response border accent. Owner input: `❯` in sky.
- Tool lines: `┊` prefix, amber; thinking: faint (collapsible, never required reading).
- Diff: added = accent, removed = red; always keep the `+`/`-` marks (not color-only).
- Errors: red, `✗` prefix, state cause + the recovery action ("`✗ brain unreachable — retry with /daimon status`").
- Destructive prompts are the Ask card — the only place amber is filled.

### 5.5 Desktop GUI (`customCSS`) — proposal, not yet in the skin

Upstream loads the skin key `customCSS` (injected as a `<style>` tag, 32 KiB cap; the TUI ignores it; `custom_css` is only
the Python field name). It is **not shipped** yet because `scripts/sync-upstream.sh` validates skin keys against
`SkinConfig` field names and would reject `customCSS` (see §7.6). Minimal, palette-only block to add to
`skins/daimon.yaml` once the check accepts it: selection in accent/BG, a 2 px sky focus ring (8.33:1; focus is never
removed), system mono stack with no web fonts, BORDER/BG scrollbar, a `prefers-reduced-motion` guard. It does not restyle
components — upstream owns layout; we only add the a11y floor and identity.

```yaml
customCSS: |-
  ::selection { background: #22c55e; color: #0f172a; }
  :focus-visible { outline: 2px solid #38bdf8; outline-offset: 2px; }
  code, pre, kbd, samp { font-family: ui-monospace, "JetBrains Mono", "DejaVu Sans Mono", monospace; }
  * { scrollbar-color: #334155 #0f172a; }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  }
```

## 6. What changed in `skins/daimon.yaml`

- `banner_title`/`ui_primary` → STRONG (titles one step above body text); body stays TEXT.
- `syntax_keyword` green → VIOLET (green is reserved for Daimon/ok; code is not Daimon speaking).
- `banner_hero`: tagline kept; three role-coded ◆ lines add the trust model. `banner_logo` byte-identical to
  the current `✦ Daimon` pill (note: HEAD still carried the older 3-line `╔═╗` glyph logo; the pill is what daimon-os
  `tests/acceptance.py` matches and what the working tree already had).
- No new hex; all pins in §2 unchanged. `customCSS` is proposed in §5.5, not shipped.

## 7. Follow-ups (not done here — widget/plugin code is out of scope)

1. **ASCII fallback in the widget**: `tui.rs` has a glyph helper `g("│","|")` that substitutes ASCII; the widget
   renders fixed glyphs. Mirror that fallback (trigger to match `tui.rs`).
2. **Red-on-SURFACE**: if the widget ever sets red text on the SURFACE strip (judging/offline header), render it as a BG-ink red pill.
3. **Ask vs Deny wording**: the held strip reads `✗ D E N Y … asks`; consider `? H E L D` in amber so the strip alone says "your turn"
   (word change only; keep the glyph and the score).
4. **Reduced noise**: the `⋯ JUDGING` strip could drop letter-spacing under `NO_COLOR` for screen readers (the spaced `A L L O W` reads as letters).
5. Align README wording: the skin key is `customCSS`, not `custom_css`.
6. **Contract check**: make `scripts/sync-upstream.sh`'s skin-key check accept the loader's `customCSS` (it reads `data.get("customCSS")`), then ship §5.5.
