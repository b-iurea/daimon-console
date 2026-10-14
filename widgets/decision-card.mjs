/**
 * decision-card — the Daimon controller's verdicts as a docked card stack (Hermes Ink TUI widget app).
 *
 * The Daimon rule: the owner SEES what the controller judged and why — the question, every row's
 * probability against its threshold, the verdict and its score — on every surface. This app is that
 * surface for the TUI: a READ-ONLY window on Daimon's agent socket (daimon-os `daimon/src/link.rs`,
 * one JSON object per line; see plugins/daimon-bridge/bridge.py for the full contract).
 *
 *   consumes  {"ev":"judging"} {"ev":"judge", rows:[{question,p,rule,ok}]} {"ev":"confirm"} {"ev":"answered"}
 *             (+ sync/live framing, turn boundaries); newest card on top, the last KEEP kept
 *   sends     nothing, ever — answers are HUMAN-ONLY, typed by the owner as `/daimon yes|no`
 *
 * Invariants:
 *   * never takes the TUI down: socket missing, refused, dropped or speaking garbage ⇒ a quiet idle
 *     card and a reconnect with backoff; every handler swallows its errors;
 *   * no Daimon on this machine (no DAIMON_SOCK, no /run/daimon) ⇒ register() is a no-op: no
 *     command, no dock, no timers, no sockets — safe to install on dev machines;
 *   * the card paints its own slate background, so its foregrounds are the real Daimon palette
 *     (daimon-os `daimon/src/tui.rs`), not terminal-adapted theme tones that could vanish on slate.
 *
 * Install: scripts/install.sh copies this file to $HERMES_HOME/tui-widgets/. It docks itself in the
 * right rail on load; `/decision-card` toggles it, `/decision-card <socket>` points it elsewhere.
 */

import fs from 'node:fs'
import net from 'node:net'
import { dirname } from 'node:path'

export const DEFAULT_SOCK = '/run/daimon/agent.sock'
export const KEEP = 3 // cards kept (newest first); only the newest is shown in full
export const CARD = 46 // card width in cells — every line is padded to exactly this
export const APP_WIDTH = CARD + 2 // the rail reserves this (it pads its cards by 1 on each side)
export const BACKOFF = [500, 1000, 2000, 5000, 10000] // reconnect delays (ms), last one repeats
const LIVE_TIMEOUT = 5000 // connect → end of the replay, like the bridge
const BAR = 26 // probability bar cells
const LINE_MAX = 1 << 20 // a "line" longer than this without a newline is dropped

// daimon-os daimon/src/tui.rs — the framebuffer UI's theme, used here as Daimon uses it there:
// violet = the controller, sky = the owner (you), green = allowed / up, amber = held for the owner,
// red = failed / offline, strong = the numbers, faint = rules and hints, border = empty bar track
export const PALETTE = {
  bg: '#0f172a',
  surface: '#1e293b',
  border: '#334155',
  text: '#e2e8f0',
  strong: '#f8fafc',
  muted: '#94a3b8',
  faint: '#64748b',
  accent: '#22c55e',
  sky: '#38bdf8',
  violet: '#a78bfa',
  amber: '#f59e0b',
  red: '#ef4444'
}

export const sockPath = (env = process.env) => (env.DAIMON_SOCK || '').trim() || DEFAULT_SOCK

/** Daimon lives here if the owner pointed us at a socket, or its runtime dir exists. */
export function daimonPresent(env = process.env, exists = fs.existsSync) {
  try {
    return Boolean((env.DAIMON_SOCK || '').trim()) || Boolean(exists(dirname(DEFAULT_SOCK)))
  } catch {
    return false
  }
}

// ------------------------------------------------------------------ model (events → cards)

export const initialModel = (path = DEFAULT_SOCK) => ({ path, status: 'idle', note: 'connecting to the agent…', cards: [], seq: 0, armed: false })

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const unit = v => Math.min(1, Math.max(0, num(v)))

function newCard(model, ev, phase) {
  return {
    id: model.seq + 1,
    phase, // judging | judged | void (no verdict came) | asking (a question with no judgment before it)
    kind: clean(ev.kind),
    subject: clean(ev.subject),
    rows: [],
    score: 0,
    allowed: false,
    verdict: '',
    secs: 0,
    ask: null, // the controller's question to the owner, if any
    answer: null // the owner's answer: true | false | null (open, or never asked)
  }
}

const push = (model, card, armed = false) => ({
  ...model,
  seq: card.id,
  armed,
  cards: [card, ...model.cards].slice(0, KEEP)
})

const withTop = (model, card, armed = false) => ({ ...model, armed, cards: [card, ...model.cards.slice(1)] })

function judged(ev) {
  const rows = Array.isArray(ev.rows) ? ev.rows : []

  return {
    phase: 'judged',
    score: num(ev.score),
    allowed: ev.allowed === true,
    verdict: clean(ev.verdict),
    secs: num(ev.secs),
    rows: rows
      .filter(r => r && typeof r === 'object')
      .map(r => ({ question: clean(r.question), p: unit(r.p), rule: clean(r.rule), ok: r.ok === true }))
  }
}

/** One wire event → the next model (the same reference when nothing changed). Pure. */
export function applyEvent(model, ev) {
  const top = model.cards[0]

  switch (ev.ev) {
    case 'sync': // new conversation, or the start of a replay that rebuilds the stack
      return { ...model, cards: [], armed: false }

    case 'judging':
      return push(model, newCard(model, ev, 'judging'))

    case 'judge': {
      if (top && top.phase === 'judging' && top.subject === clean(ev.subject)) {
        return withTop(model, { ...top, kind: clean(ev.kind) || top.kind, ...judged(ev) }, true)
      }

      return push(model, { ...newCard(model, ev, 'judged'), ...judged(ev) }, true)
    }

    case 'confirm': {
      // the question that follows a judgment is that judgment's question; anything else gets its own card
      if (model.armed && top && top.ask === null) {
        return withTop(model, { ...top, ask: clean(ev.s) })
      }

      return push(model, { ...newCard(model, { kind: 'controller question' }, 'asking'), ask: clean(ev.s) })
    }

    case 'answered': {
      const i = model.cards.findIndex(c => c.ask !== null && c.answer === null)

      if (i < 0) {
        return model
      }

      const cards = model.cards.slice()
      cards[i] = { ...cards[i], answer: ev.yes === true }

      return { ...model, cards, armed: false }
    }

    case 'user':
    case 'tool':
    case 'done':
    case 'err': {
      // a turn or action boundary: a judgment still pending now never got its verdict
      const stale = ev.ev !== 'tool' && model.cards.some(c => c.phase === 'judging')
      const cards = stale ? model.cards.map(c => (c.phase === 'judging' ? { ...c, phase: 'void' } : c)) : model.cards

      return stale || model.armed ? { ...model, cards, armed: false } : model
    }

    default:
      return model
  }
}

// ------------------------------------------------------------------ layout (model → padded lines)

/** Agent text is untrusted: no control characters (ANSI escapes, newlines) reach the terminal. */
export function clean(s) {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .trim()
}

const len = s => [...s].length
const cut = (s, n) => (n <= 0 ? '' : len(s) <= n ? s : [...s].slice(0, n - 1).join('') + '…')
const seg = (s, fg, bg = PALETTE.bg, bold = false) => ({ s, fg, bg, bold })

/** Fit segments into exactly CARD cells: overflow is cut with …, the rest padded in `fill`. */
function line(segs, fill = PALETTE.bg) {
  const out = []
  let room = CARD

  for (const g of segs) {
    if (room <= 0 || !g.s) {
      continue
    }

    const s = len(g.s) > room ? cut(g.s, room) : g.s
    out.push({ ...g, s })
    room -= len(s)
  }

  if (room > 0) {
    out.push(seg(' '.repeat(room), PALETTE.text, fill))
  }

  return out
}

/** Left and right parts on one line, right-aligned, over one background. */
function spread(left, right, fg, bg, bold = false) {
  const r = cut(right, CARD - 4)
  const l = cut(left, CARD - len(r) - 1)

  return line([seg(l + ' '.repeat(Math.max(1, CARD - len(l) - len(r))) + r, fg, bg, bold)], bg)
}

/** "needs >= 60%" → 0.6, "p >= 0.75" → 0.75; null when the rule names no threshold. */
export function threshold(rule) {
  const pct = /(\d+(?:\.\d+)?)\s*%/.exec(rule)

  if (pct) {
    return unit(Number(pct[1]) / 100)
  }

  const frac = /(?:^|[^\d.])(0?\.\d+|1\.0+)(?![\d.])/.exec(rule)

  return frac ? unit(Number(frac[1])) : null
}

/** The probability bar: filled to p (green if the row passed, red if not), │ at the threshold. */
export function bar(p, thr, ok) {
  const filled = Math.round(unit(p) * BAR)
  const mark = thr === null ? -1 : Math.min(BAR - 1, Math.round(thr * BAR))
  const segs = []

  for (let i = 0; i < BAR; i++) {
    const [ch, fg] = i === mark ? ['│', PALETTE.strong] : i < filled ? ['█', ok ? PALETTE.accent : PALETTE.red] : ['░', PALETTE.border]
    const last = segs.at(-1)

    if (last && last.fg === fg) {
      last.s += ch
    } else {
      segs.push(seg(ch, fg, PALETTE.bg, i === mark))
    }
  }

  return segs
}

function wrap(text, width, max) {
  const chars = [...text]
  const out = []

  while (chars.length && out.length < max) {
    out.push(chars.splice(0, width).join('').trimStart())
  }

  if (chars.length) {
    out[max - 1] = cut(out[max - 1] + 'x', width) // signal the cut with …
  }

  return out
}

function phaseText(c) {
  if (c.phase === 'judging') {
    return 'judging…'
  }

  if (c.phase === 'judged') {
    return `judged in ${c.secs.toFixed(1)} s`
  }

  return c.phase === 'void' ? 'no verdict' : 'asks the owner'
}

function strip(c, subject = '') {
  const tail = subject ? ` · ${subject}` : ''

  if (c.phase === 'judged') {
    // as tui.rs: allowed is green, stopped for the owner is amber, a verdict with no rows behind it is red
    const bg = c.allowed ? PALETTE.accent : c.rows.length ? PALETTE.amber : PALETTE.red
    const big = c.allowed ? '✓ A L L O W' : '✗ D E N Y'

    if (subject) {
      return line([seg(` ${c.allowed ? '✓ ALLOW' : '✗ DENY'} ${c.score.toFixed(2)}${tail}`, PALETTE.bg, bg, true)], bg)
    }

    return spread(`  ${big}`, `score ${c.score.toFixed(2)}${c.verdict ? ` · ${c.verdict}` : ''}  `, PALETTE.bg, bg, true)
  }

  if (c.phase === 'judging') {
    return line([seg(subject ? ` ⋯ judging${tail}` : '  ⋯ J U D G I N G', PALETTE.violet, PALETTE.surface, true)], PALETTE.surface)
  }

  if (c.phase === 'void') {
    return line([seg(` · no verdict${tail}`, PALETTE.muted, PALETTE.surface)], PALETTE.surface)
  }

  return null // a bare question has no controller verdict to show
}

function askLines(c, full) {
  if (c.ask === null) {
    return []
  }

  if (c.answer === null) {
    const q = full ? wrap(c.ask, CARD - 3, 2).map((s, i) => line([seg(`${i ? '   ' : ' ? '}${s}`, PALETTE.amber, PALETTE.bg, true)])) : []

    return [...q, line([seg(' answer: ', PALETTE.muted), seg('/daimon yes|no', PALETTE.sky, PALETTE.bg, true)])]
  }

  const owner = c.answer
    ? line([seg(' owner: ', PALETTE.sky), seg('✓ allowed', PALETTE.accent, PALETTE.bg, true)])
    : line([seg(' owner: ', PALETTE.sky), seg('✗ denied', PALETTE.red, PALETTE.bg, true)])

  return full ? [line([seg(` ? ${c.ask}`, PALETTE.muted)]), owner] : [owner]
}

/** The newest card: what was judged, every row against its threshold, the verdict, the question. */
function fullCard(c) {
  const out = [
    line([seg(' ◆ ', PALETTE.violet, PALETTE.bg, true), seg(c.kind || 'controller', PALETTE.text, PALETTE.bg, true), seg(` · ${phaseText(c)}`, PALETTE.muted)])
  ]

  if (c.subject) {
    out.push(line([seg(` ${c.subject}`, PALETTE.muted)]))
  }

  for (const r of c.rows) {
    const thr = threshold(r.rule)
    out.push(line([seg(` ${r.ok ? '✓' : '✗'} `, r.ok ? PALETTE.accent : PALETTE.red, PALETTE.bg, true), seg(r.question || '(unnamed)', PALETTE.text)]))
    out.push(
      line([
        seg('   '),
        ...bar(r.p, thr, r.ok),
        seg(` ${String(Math.round(r.p * 100)).padStart(3)}%`, PALETTE.strong, PALETTE.bg, true),
        seg(thr === null ? (r.rule ? `  ${r.rule}` : '') : `  ≥${Math.round(thr * 100)}%`, PALETTE.faint)
      ])
    )
  }

  const s = strip(c)

  return [...out, ...(s ? [s] : []), ...askLines(c, true)]
}

/** An older card, collapsed under the newest: its verdict strip and the owner's answer. */
function compactCard(c) {
  const s = strip(c, c.subject || c.kind) ?? line([seg(` ? ${c.ask ?? ''}`, PALETTE.amber, PALETTE.surface)], PALETTE.surface)

  return [s, ...askLines(c, false)]
}

/** The link to the agent, in words: online, lost (the cards shown are the last known), or not reached yet. */
export function linkState(model) {
  if (model.status === 'live') {
    return { text: '● agent online', fg: PALETTE.accent }
  }

  return model.cards.length ? { text: '○ agent offline', fg: PALETTE.red } : { text: '○ waiting for agent', fg: PALETTE.amber }
}

/** The title line: what this window shows (left, in the controller's violet) and the link state (right). */
function header(model) {
  const title = [seg(' ◆ ', PALETTE.violet, PALETTE.bg, true), seg('Controller decisions', PALETTE.violet, PALETTE.bg, true)]
  const { text, fg } = linkState(model)
  const room = CARD - title.reduce((n, g) => n + len(g.s), 0) - len(text) - 1

  return line([...title, seg(' '.repeat(Math.max(1, room))), seg(`${text} `, fg, PALETTE.bg, true)])
}

/** The whole stack as lines of colored segments, each exactly CARD cells. Pure. */
export function linesOf(model) {
  const live = model.status === 'live'
  const out = [header(model)]

  if (!model.cards.length) {
    out.push(line([seg(' · ', PALETTE.faint), seg(live ? 'no decisions yet' : model.note || 'waiting for the agent', PALETTE.muted)]))

    return out
  }

  model.cards.forEach((c, i) => {
    out.push(line([]))
    out.push(...(i === 0 ? fullCard(c) : compactCard(c)))
  })

  return out
}

/** Plain text of the stack (snapshots, logs). */
export const textOf = model => linesOf(model).map(l => l.map(g => g.s).join('')).join('\n')

// ------------------------------------------------------------------ feed (the socket, read-only)

function noteFor(err) {
  switch (err && err.code) {
    case 'ENOENT':
      return 'agent not started yet — waiting for it'
    case 'ECONNREFUSED':
      return 'agent not answering — trying again'
    case 'EACCES':
      return 'no permission to reach the agent'
    default:
      return 'lost the agent — reconnecting'
  }
}

/**
 * Follow the agent socket at `path`; `onModel(model)` gets every change. The replay after a
 * (re)connect rebuilds the stack silently and lands as one update at {"ev":"live"}. Never writes to
 * the socket. Returns { close(), model }.
 */
export function createFeed({
  path = sockPath(),
  onModel,
  backoff = BACKOFF,
  connect = p => net.createConnection(p),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  liveTimeout = LIVE_TIMEOUT
} = {}) {
  let model = initialModel(path)
  let sock = null
  let retry = null
  let waitLive = null
  let attempt = 0
  let closed = false

  const emit = () => {
    try {
      onModel?.(model)
    } catch {
      // the consumer's problem, never the feed's
    }
  }

  const unref = t => (t && typeof t.unref === 'function' ? t.unref() : undefined, t)

  function open() {
    retry = null

    if (closed) {
      return
    }

    let s
    let lastErr = null
    let buf = ''
    let live = false

    const down = () => {
      if (sock !== s) {
        return
      }

      sock = null

      if (waitLive) {
        clearTimer(waitLive)
        waitLive = null
      }

      try {
        s.destroy()
      } catch {
        // already gone
      }

      if (closed) {
        return
      }

      const note = noteFor(lastErr)

      if (model.status !== 'idle' || model.note !== note) {
        model = { ...model, status: 'idle', note }
        emit()
      }

      retry = unref(setTimer(open, backoff[Math.min(attempt++, backoff.length - 1)]))
    }

    const take = raw => {
      let ev

      try {
        ev = JSON.parse(raw)
      } catch {
        return
      }

      if (!ev || typeof ev !== 'object' || Array.isArray(ev) || typeof ev.ev !== 'string') {
        return
      }

      if (ev.ev === 'live') {
        live = true
        attempt = 0
        clearTimer(waitLive)
        waitLive = null
        model = { ...model, status: 'live', note: '' }
        emit()

        return
      }

      const next = applyEvent(model, ev)

      if (next !== model) {
        model = next

        if (live) {
          emit()
        }
      }
    }

    try {
      s = connect(path)
      sock = s
      unref(s)
      s.setEncoding?.('utf8')
      s.on('error', e => {
        lastErr = e
      })
      s.on('close', down)
      s.on('data', chunk => {
        try {
          buf += chunk

          let i

          while ((i = buf.indexOf('\n')) >= 0) {
            const raw = buf.slice(0, i)
            buf = buf.slice(i + 1)
            take(raw)
          }

          if (buf.length > LINE_MAX) {
            buf = ''
          }
        } catch {
          // a bad chunk never stops the feed
        }
      })
      waitLive = unref(
        setTimer(() => {
          waitLive = null
          down()
        }, liveTimeout)
      )
    } catch (e) {
      lastErr = e
      sock = s = s || {}
      down()
    }
  }

  open()

  return {
    get model() {
      return model
    },
    close() {
      closed = true

      for (const t of [retry, waitLive]) {
        if (t) {
          clearTimer(t)
        }
      }

      retry = waitLive = null

      try {
        sock?.destroy?.()
      } catch {
        // already gone
      }

      sock = null
    }
  }
}

// ------------------------------------------------------------------ the widget app (Hermes SDK)

/** Lines → Ink elements: one row Box per line, one Text per colored segment. */
export function view(sdk, model) {
  const { Box, Text, h } = sdk

  return h(
    Box,
    { flexDirection: 'column', width: CARD },
    ...linesOf(model).map((segs, i) =>
      h(
        Box,
        { flexDirection: 'row', key: i },
        ...segs.map((g, j) => h(Text, { backgroundColor: g.bg, bold: g.bold, color: g.fg, key: j, wrap: 'truncate-end' }, g.s))
      )
    )
  )
}

export function registerWith(sdk, { env = process.env, exists = fs.existsSync } = {}) {
  try {
    if (!sdk || typeof sdk.defineWidgetApp !== 'function' || !daimonPresent(env, exists)) {
      return null // no Daimon here: a no-op file
    }

    const { React, h } = sdk

    function DecisionCards({ path }) {
      const [model, setModel] = React.useState(() => initialModel(path))

      React.useEffect(() => {
        const feed = createFeed({ path, onModel: setModel })

        return () => feed.close()
      }, [path])

      try {
        return view(sdk, model)
      } catch {
        return view(sdk, initialModel(path))
      }
    }

    const def = {
      id: 'decision-card',
      help: 'Daimon controller decisions (question · probabilities · verdict), read-only',
      mode: 'ambient',
      zone: 'top-right',
      width: APP_WIDTH,
      usage: 'usage: /decision-card [socket path]   (default $DAIMON_SOCK or /run/daimon/agent.sock)',
      init: arg => ({ path: clean(arg) || sockPath(env) }),
      reduce: (state, input) => (input?.key?.escape || input?.ch === 'q' ? null : state),
      render: ({ state }) => h(DecisionCards, { path: state?.path || sockPath(env) })
    }

    const app = sdk.defineWidgetApp(def) || def

    // dock on load: the owner must see the controller's judgments without asking for them
    sdk.openWidget?.(app, app.init(''))

    return app
  } catch {
    return null
  }
}

export default function register(sdk) {
  registerWith(sdk)
}
