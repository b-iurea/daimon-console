// Tests for widgets/decision-card.mjs — node:test, no Hermes, no npm deps.
//
//   node --test tests/decision_card.test.mjs      (pytest runs it too: tests/test_decision_card_widget.py)
//
// The widget is exercised against real unix sockets: a node-side scripted hub (exact bytes, and
// proof the widget never writes), and tests/fake_agent.py driven by a second window (the owner).

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import register, * as w from '../widgets/decision-card.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const REBOOT = 'power {"action":"reboot"}'
const HOSTNAME = 'read {"path":"/etc/hostname"}'

// a turn the controller allows, then one it asks the owner about (the shape agent.rs emits)
const SCRIPT = [
  { ev: 'user', s: 'what is the hostname' },
  { ev: 'tool', name: 'read', args: '{"path":"/etc/hostname"}' },
  { ev: 'judging', kind: 'action check', subject: HOSTNAME },
  { ev: 'judge', kind: 'action check', subject: HOSTNAME, score: 0.91, allowed: true, verdict: 'allows', secs: 0.8,
    rows: [{ question: 'Is it read-only?', p: 0.97, rule: 'needs >= 60%', ok: true }] },
  { ev: 'tool_out', s: 'daimon\n' },
  { ev: 'done', tok_s: 14.5 },
  { ev: 'user', s: 'reboot the box' },
  { ev: 'think', s: 'The owner wants this.' },
  { ev: 'tool', name: 'power', args: '{"action":"reboot"}' },
  { ev: 'judging', kind: 'action check', subject: REBOOT },
  { ev: 'judge', kind: 'action check', subject: REBOOT, score: 0.4, allowed: false, verdict: 'asks', secs: 1.5,
    rows: [
      { question: 'Is it reversible?', p: 0.1, rule: 'needs >= 60%', ok: false },
      { question: 'Did the owner ask for exactly this?', p: 0.88, rule: 'p >= 0.5', ok: true }
    ] },
  { ev: 'confirm', s: `risky: ${REBOOT}  -- allow? [y/n]` }
]

const ASKING = `
 ◆ Controller decisions        ● agent online

 ◆ action check · judged in 1.5 s
 power {"action":"reboot"}
 ✗ Is it reversible?
   ███░░░░░░░░░░░░░│░░░░░░░░░  10%  ≥60%
 ✓ Did the owner ask for exactly this?
   █████████████│█████████░░░  88%  ≥50%
  ✗ D E N Y                score 0.40 · asks
 ? risky: power {"action":"reboot"}  -- allow?
   [y/n]
 answer: /daimon yes|no

 ✓ ALLOW 0.91 · read {"path":"/etc/hostname"}`

const DENIED = `
 ◆ Controller decisions        ● agent online

 ◆ action check · judged in 1.5 s
 power {"action":"reboot"}
 ✗ Is it reversible?
   ███░░░░░░░░░░░░░│░░░░░░░░░  10%  ≥60%
 ✓ Did the owner ask for exactly this?
   █████████████│█████████░░░  88%  ≥50%
  ✗ D E N Y                score 0.40 · asks
 ? risky: power {"action":"reboot"}  -- allow…
 owner: ✗ denied

 ✓ ALLOW 0.91 · read {"path":"/etc/hostname"}`

const snap = model => w.textOf(model).split('\n').map(l => l.trimEnd()).join('\n')
const expected = s => s.slice(1)
const play = (events, model = w.initialModel('/x')) => events.reduce(w.applyEvent, model)
const live = model => ({ ...model, status: 'live', note: '' })

async function until(cond, what, ms = 5000) {
  const t0 = Date.now()

  while (!cond()) {
    if (Date.now() - t0 > ms) {
      throw new Error(`timed out: ${what}`)
    }

    await new Promise(r => setTimeout(r, 20))
  }
}

// every socket test releases what it opened in t.after, so a failing assertion can never hang the run

function tmpSock(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daimon-card-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  return path.join(dir, 'agent.sock')
}

/** A link.rs-shaped hub: replay = sync + history + live; records every byte a window sends.
 *  `history: null` = a hub that accepts and never says anything. */
async function hub(t, sock, history) {
  const windows = []
  const received = []
  const server = net.createServer(s => {
    windows.push(s)
    s.on('data', d => received.push(String(d)))
    s.on('error', () => {})

    if (history) {
      s.write([{ ev: 'sync' }, ...history, { ev: 'live' }].map(e => JSON.stringify(e) + '\n').join(''))
    }
  })
  const drop = () => windows.splice(0).forEach(s => s.destroy())

  await new Promise(r => server.listen(sock, r))
  t.after(() => (drop(), server.close()))

  return { windows, received, drop, send: ev => windows.forEach(s => s.write(JSON.stringify(ev) + '\n')) }
}

function feedFor(t, opts) {
  const feed = w.createFeed(opts)
  t.after(() => feed.close())

  return feed
}

// ------------------------------------------------------------------ the card (pure)

test('judge + confirm sequence renders the card stack (snapshot)', () => {
  const m = live(play(SCRIPT))
  assert.equal(snap(m), expected(ASKING))
  assert.equal(m.cards.length, 2)
  assert.equal(m.cards[0].ask, `risky: ${REBOOT}  -- allow? [y/n]`)
  assert.equal(snap(w.applyEvent(m, { ev: 'answered', yes: false })), expected(DENIED))

  const allowed = w.textOf(w.applyEvent(m, { ev: 'answered', yes: true }))
  assert.match(allowed, /owner: ✓ allowed/)
  assert.doesNotMatch(allowed, /answer: \/daimon/)
})

test('every line is exactly the card width; verdicts are green/amber strips on slate', () => {
  const m = live(play(SCRIPT))
  const lines = w.linesOf(m)

  for (const l of lines) {
    assert.equal([...l.map(g => g.s).join('')].length, w.CARD)
  }

  const deny = lines.find(l => l.some(g => g.s.includes('D E N Y')))
  const allow = lines.find(l => l.some(g => g.s.includes('✓ ALLOW')))
  assert.ok(deny.every(g => g.bg === w.PALETTE.amber && g.fg === w.PALETTE.bg), 'stopped for the owner is amber, as in tui.rs')
  assert.ok(allow.every(g => g.bg === w.PALETTE.accent))

  const bar = lines.find(l => l.some(g => g.s.includes('│')))
  assert.equal(bar.find(g => g.s.includes('█')).fg, w.PALETTE.red, 'a failed row fills red')
  assert.equal(bar.find(g => g.s === '│').fg, w.PALETTE.strong, 'threshold marker')
  assert.equal(bar.find(g => g.s.includes('░')).fg, w.PALETTE.border, 'empty track')
  assert.ok(lines.filter(l => l !== deny && l !== allow).every(l => l.every(g => g.bg === w.PALETTE.bg)))

  const color = (l, s) => l.find(g => g.s.includes(s)).fg
  assert.equal(color(lines[0], 'Controller'), w.PALETTE.violet, 'the controller is violet')
  assert.equal(color(lines[0], '● agent online'), w.PALETTE.accent)
  assert.equal(color(lines.find(l => l.some(g => g.s.includes('/daimon yes|no'))), '/daimon'), w.PALETTE.sky, 'what the owner types is sky')
  assert.equal(color(lines.find(l => l.some(g => g.s.includes('10%'))), '10%'), w.PALETTE.strong)

  const bare = w.linesOf(live(play([{ ev: 'judge', kind: 'k', subject: 's', allowed: false, verdict: 'error', rows: [] }])))
  assert.ok(bare.find(l => l.some(g => g.s.includes('D E N Y'))).every(g => g.bg === w.PALETTE.red), 'a verdict with no rows is red')
})

test('the header says what the window is and the link state, in words', () => {
  const judged = play(SCRIPT.slice(0, 4))
  const head = m => w.textOf(m).split('\n')[0]

  assert.equal(head(live(w.initialModel('/x'))), ' ◆ Controller decisions        ● agent online ')
  assert.equal(head({ ...judged, status: 'idle' }), ' ◆ Controller decisions       ○ agent offline ')
  assert.equal(head(w.initialModel('/x')), ' ◆ Controller decisions   ○ waiting for agent ')
  assert.equal(w.linkState({ ...judged, status: 'idle' }).fg, w.PALETTE.red)
  assert.equal(w.linkState(w.initialModel('/x')).fg, w.PALETTE.amber)
  assert.equal(snap(live(w.initialModel('/x'))), ' ◆ Controller decisions        ● agent online\n · no decisions yet')
})

// daimon-os daimon/src/tui.rs, lines 28-39 (BG SURFACE BORDER TEXT STRONG MUTED FAINT ACCENT SKY VIOLET AMBER RED)
const TUI_RS = {
  bg: [15, 23, 42],
  surface: [30, 41, 59],
  border: [51, 65, 85],
  text: [226, 232, 240],
  strong: [248, 250, 252],
  muted: [148, 163, 184],
  faint: [100, 116, 139],
  accent: [34, 197, 94],
  sky: [56, 189, 248],
  violet: [167, 139, 250],
  amber: [245, 158, 11],
  red: [239, 68, 68]
}
const hex = rgb => '#' + rgb.map(n => n.toString(16).padStart(2, '0')).join('')

test('the palette is daimon-os tui.rs', () => {
  assert.deepEqual(w.PALETTE, Object.fromEntries(Object.entries(TUI_RS).map(([k, v]) => [k, hex(v)])))

  // with a daimon-os checkout next to this repo, check the source itself too
  const src = path.join(ROOT, '../daimon-os/daimon/src/tui.rs')

  if (fs.existsSync(src)) {
    const rs = Object.fromEntries(
      [...fs.readFileSync(src, 'utf8').matchAll(/^const (\w+): Color = Color::Rgb\((\d+), (\d+), (\d+)\);/gm)].map(m => [m[1].toLowerCase(), m.slice(2).map(Number)])
    )
    assert.deepEqual(rs, TUI_RS)
  }
})

test('the skin uses only tui.rs colors, and the keys the card shares with it agree', () => {
  const skin = Object.fromEntries(
    [...fs.readFileSync(path.join(ROOT, 'skins/daimon.yaml'), 'utf8').matchAll(/^\s+(\w+):\s*"(#[0-9a-fA-F]{6})"/gm)].map(m => [m[1], m[2].toLowerCase()])
  )
  const allowed = new Set(Object.values(w.PALETTE))

  for (const [key, v] of Object.entries(skin)) {
    assert.ok(allowed.has(v), `skin ${key} ${v} is not a tui.rs color`)
  }

  const map = { bg: 'background', accent: 'ui_ok', red: 'ui_error', amber: 'ui_warn', text: 'ui_text', muted: 'ui_label', border: 'ui_border', faint: 'ui_thinking', surface: 'status_bar_bg', sky: 'prompt' }

  for (const [k, key] of Object.entries(map)) {
    assert.equal(w.PALETTE[k], skin[key], `${k} ≠ skin ${key}`)
  }
})

test('more than three decisions keep the newest three, newest on top', () => {
  const evs = []

  for (let i = 1; i <= 5; i++) {
    evs.push({ ev: 'judging', kind: 'action check', subject: `act ${i}` })
    evs.push({ ev: 'judge', kind: 'action check', subject: `act ${i}`, score: 0.9, allowed: true, verdict: 'allows', rows: [] })
  }

  const m = play(evs)
  assert.deepEqual(m.cards.map(c => c.subject), ['act 5', 'act 4', 'act 3'])
})

test('a judgment cut short by the end of the turn says so; sync clears the stack', () => {
  const m = play([{ ev: 'judging', kind: 'action check', subject: 'x' }, { ev: 'err', s: 'brain died' }])
  assert.equal(m.cards[0].phase, 'void')
  assert.match(w.textOf(m), /no verdict/)
  assert.equal(w.applyEvent(m, { ev: 'sync' }).cards.length, 0)
})

test('a question with no judgment before it gets its own card', () => {
  const m = play([
    { ev: 'judging', kind: 'action check', subject: 'a' },
    { ev: 'judge', kind: 'action check', subject: 'a', score: 0.9, allowed: true, verdict: 'allows', rows: [] },
    { ev: 'tool', name: 'other' },
    { ev: 'confirm', s: 'something else?' }
  ])
  assert.equal(m.cards.length, 2)
  assert.equal(m.cards[1].ask, null)
  assert.equal(m.cards[0].ask, 'something else?')
  assert.match(w.textOf(m), /answer: \/daimon yes\|no/)
})

test('agent text cannot smuggle terminal escapes; junk rows and values are tamed', () => {
  const m = play([
    { ev: 'judge', subject: 'evil\u001b[2J\u001b]0;pwn\u0007\nline', score: 'x', rows: [null, { question: 7, p: 9, ok: 1 }, { p: -3 }] }
  ])
  for (const l of w.textOf(m).split('\n')) {
    assert.doesNotMatch(l, /[\u0000-\u001f\u007f-\u009f]/)
  }

  assert.deepEqual(m.cards[0].rows.map(r => r.p), [1, 0])
  assert.equal(m.cards[0].allowed, false)
})

test('threshold parsing', () => {
  assert.equal(w.threshold('needs >= 60%'), 0.6)
  assert.equal(w.threshold('p >= 0.75'), 0.75)
  assert.equal(w.threshold('rule 3: owner asked'), null)
  assert.equal(w.threshold(''), null)
})

// ------------------------------------------------------------------ the feed (real sockets)

test('idle path: no socket ⇒ quiet idle card, reconnect with growing backoff, close stops it', async t => {
  const sock = tmpSock(t)
  const retries = []
  const models = []
  const feed = feedFor(t, {
    path: sock,
    onModel: m => models.push(m),
    setTimer: (fn, ms) => (ms === 99999 ? 0 : retries.push({ fn, ms })),
    clearTimer: () => {},
    liveTimeout: 99999
  })

  await until(() => retries.length === 1, 'idle model')
  assert.equal(feed.model.status, 'idle')
  assert.equal(snap(feed.model), ' ◆ Controller decisions   ○ waiting for agent\n · agent not started yet — waiting for it')

  for (let i = 1; i <= 4; i++) {
    retries.at(-1).fn()
    await until(() => retries.length === i + 1, `retry ${i}`)
  }

  assert.deepEqual(retries.map(r => r.ms), [500, 1000, 2000, 5000, 10000])
  assert.equal(models.length, 1, 'a socket that stays missing is not re-announced')
  feed.close()
  retries.at(-1).fn() // a late timer after close does nothing
  await new Promise(r => setTimeout(r, 50))
  assert.equal(retries.length, 5)
})

test('scripted hub: replay rebuilds the stack, live events update it, the widget never writes', async t => {
  const sock = tmpSock(t)
  const h = await hub(t, sock, [...SCRIPT.slice(0, 6), { ev: 'garbage' }])
  const updates = []
  const feed = feedFor(t, { path: sock, onModel: m => updates.push(m) })

  await until(() => feed.model.status === 'live', 'live')
  assert.equal(updates.length, 1, 'the replay lands as one update')
  assert.equal(feed.model.cards.length, 1)

  h.windows[0].write('not json\n[1,2]\n{"no":"ev"}\n')

  for (const ev of SCRIPT.slice(6)) {
    h.send(ev)
  }

  await until(() => feed.model.cards[0]?.ask, 'question')
  assert.equal(snap(feed.model), expected(ASKING))
  h.send({ ev: 'answered', yes: false })
  await until(() => feed.model.cards[0].answer === false, 'answer')
  assert.equal(snap(feed.model), expected(DENIED))

  assert.deepEqual(h.received, [], 'read-only window: nothing sent to the agent')
})

test('agent drops ⇒ idle card keeps the stack, then reconnects and replays', async t => {
  const sock = tmpSock(t)
  const h = await hub(t, sock, SCRIPT.slice(0, 6))
  const feed = feedFor(t, { path: sock, backoff: [30] })

  await until(() => feed.model.status === 'live', 'live')
  h.drop()
  await until(() => feed.model.status === 'idle', 'idle after drop')
  assert.equal(feed.model.cards.length, 1)
  assert.match(w.textOf(feed.model), /○ agent offline/)
  await until(() => feed.model.status === 'live' && h.windows.length === 1, 'reconnected')
  assert.equal(feed.model.cards.length, 1, 'replay rebuilt, not duplicated')
})

test('a socket that never finishes its replay times out into idle', async t => {
  const sock = tmpSock(t)
  await hub(t, sock, null)
  const feed = feedFor(t, { path: sock, liveTimeout: 100, backoff: [60000] })

  await until(() => feed.model.note === 'lost the agent — reconnecting', 'replay timeout')
  assert.equal(feed.model.status, 'idle')
})

test('against tests/fake_agent.py: the owner, in another window, answers — the card follows', async t => {
  const sock = tmpSock(t)
  const py = spawn(process.env.PYTHON || 'python3', [path.join(ROOT, 'tests/fake_agent.py'), sock], { stdio: 'ignore' })
  t.after(async () => {
    py.kill('SIGKILL')
    await new Promise(r => (py.exitCode !== null || py.signalCode !== null ? r() : py.on('exit', r)))
  })

  await until(() => fs.existsSync(sock), 'fake agent socket')
  const feed = feedFor(t, { path: sock })
  await until(() => feed.model.status === 'live', 'live')

  const owner = net.createConnection(sock)
  owner.on('error', () => {})
  t.after(() => owner.destroy())
  owner.write(JSON.stringify({ prompt: 'please reboot' }) + '\n')
  await until(() => feed.model.cards[0]?.ask && feed.model.cards[0].answer === null, 'controller question')

  const asking = w.textOf(feed.model)
  assert.match(asking, /◆ action check · judged in 1\.5 s/)
  assert.match(asking, /✗ Is it reversible\?/)
  assert.match(asking, /✗ D E N Y +score 0\.40 · asks/)
  assert.match(asking, /answer: \/daimon yes\|no/)

  owner.write(JSON.stringify({ confirm: false }) + '\n')
  await until(() => feed.model.cards[0].answer === false, 'owner answer')
  assert.match(w.textOf(feed.model), /owner: ✗ denied/)
})

// ------------------------------------------------------------------ the widget app (Hermes SDK contract)

/** A stand-in for the TUI's widgetSdk: h builds a plain tree, hooks are inert. */
function fakeSdk() {
  const calls = { defined: [], opened: [] }
  const sdk = {
    Box: 'Box',
    Text: 'Text',
    h: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    React: { useState: init => [typeof init === 'function' ? init() : init, () => {}], useEffect: () => {} },
    defineWidgetApp: app => (calls.defined.push(app), app),
    openWidget: (app, state) => calls.opened.push({ app, state })
  }

  return { sdk, calls }
}

function textOfTree(node) {
  if (node === null || node === undefined || node === false) {
    return ''
  }

  if (typeof node !== 'object') {
    return String(node)
  }

  if (typeof node.type === 'function') {
    return textOfTree(node.type({ ...node.props, children: node.children }))
  }

  const parts = node.children.map(textOfTree)

  return node.type === 'Box' && node.props.flexDirection !== 'row' ? parts.join('\n') : parts.join('')
}

test('Daimon absent ⇒ the file is a no-op (no command, no dock)', () => {
  const { sdk, calls } = fakeSdk()
  assert.equal(w.registerWith(sdk, { env: {}, exists: () => false }), null)
  assert.deepEqual(calls, { defined: [], opened: [] })
  assert.equal(w.registerWith(sdk, { env: {}, exists: () => { throw new Error('EPERM') } }), null)
  assert.doesNotThrow(() => register(undefined))
  assert.doesNotThrow(() => register({}))
})

test('Daimon present ⇒ an ambient right-rail app that docks itself and renders the idle card', () => {
  const { sdk, calls } = fakeSdk()
  const app = w.registerWith(sdk, { env: { DAIMON_SOCK: '/tmp/nowhere.sock' }, exists: () => false })

  assert.equal(app.id, 'decision-card')
  assert.equal(app.mode, 'ambient')
  assert.equal(app.zone, 'top-right')
  assert.equal(app.width, w.APP_WIDTH)
  assert.deepEqual(calls.opened.map(o => o.state), [{ path: '/tmp/nowhere.sock' }])
  assert.deepEqual(app.init(' /tmp/other.sock '), { path: '/tmp/other.sock' })
  assert.equal(app.reduce({ path: 'p' }, { ch: 'q', key: {} }), null)

  const tree = app.render({ state: { path: '/tmp/nowhere.sock' }, t: {}, cols: 120, rows: 40 })
  assert.equal(textOfTree(tree), w.textOf(w.initialModel('/tmp/nowhere.sock')))

  assert.ok(w.registerWith(sdk, { env: {}, exists: p => p === '/run/daimon' }), '/run/daimon alone means Daimon is here')
})

test('the rendered tree carries the segment colors to Ink', () => {
  const { sdk } = fakeSdk()
  const tree = w.view(sdk, live(play(SCRIPT)))
  const texts = []
  const walk = n => (n && typeof n === 'object' ? (n.type === 'Text' ? texts.push(n) : n.children.forEach(walk)) : null)
  walk(tree)
  const deny = texts.find(t => t.children.join('').includes('D E N Y'))
  assert.equal(deny.props.backgroundColor, w.PALETTE.amber)
  assert.equal(deny.props.color, w.PALETTE.bg)
  assert.equal(tree.props.width, w.CARD)
})
