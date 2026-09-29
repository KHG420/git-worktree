/**
 * Browser-half interaction tests in a real DOM (jsdom): mounts the actual
 * footer component with react-dom/client and simulates the tree-based flows —
 * the renderless worktree sync (auto-register worktrees + 主工作树 marker +
 * stale sweep) and the per-row DOM integration that replaced the removed
 * `sidebar.workspaces.create` chain (repo row ＋ → worktree popover, linked
 * worktree row ＋/删除工作树, non-worktree fallback, duplicate-label chooser,
 * lifecycle restore, click outside).
 *
 * The workspace tree is built to the same *structural* contract the real
 * ui-workspace browser renders (div[role=tree] >
 * div[role=treeitem][aria-expanded] with a label span and an actions span of
 * two buttons). The integration must not depend on the hashed CSS class names.
 *
 * jsdom is not a plugin dependency: it is resolved from the DeepSeek Harness
 * checkout (set DSH_HARNESS to its root, default /Users/aq/deepseek-harness)
 * and the suite skips gracefully when it is unavailable.
 *
 * Run: node test/client-dom.js
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { installJsdomGuards } from './jsdom-guard.js'

const require = createRequire(import.meta.url)

// ── resolve jsdom (optional dependency) ─────────────────────────────────────
let jsdom = null
let jsdomPath = null
try {
  jsdom = require('jsdom')
  jsdomPath = require.resolve('jsdom')
} catch {
  for (const candidate of [process.env.DSH_HARNESS, '/Users/aq/deepseek-harness']) {
    if (candidate && existsSync(join(candidate, 'node_modules', 'jsdom'))) {
      const candidateRequire = createRequire(join(candidate, 'package.json'))
      jsdom = candidateRequire('jsdom')
      jsdomPath = candidateRequire.resolve('jsdom')
      break
    }
  }
}
if (jsdom === null) {
  console.log('⚠️  client-dom: jsdom unavailable — skipping (set DSH_HARNESS to a checkout with jsdom)')
  process.exit(0)
}

// ── DOM setup ───────────────────────────────────────────────────────────────
// MUST happen before react-dom is required: react-dom sniffs the global
// `document` at module load and falls back to the legacy attachEvent path when
// it is absent, which then throws `activeElement.attachEvent is not a function`
// from inside its event plugin. Install a virtual console that records (and
// still forwards) jsdom errors so the runner can fail on any unexpected one.
const virtualConsole = new jsdom.VirtualConsole()
virtualConsole.forwardTo(console)
const dom = new jsdom.JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://127.0.0.1:3080/',
  virtualConsole,
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
for (const name of ['Element', 'HTMLElement', 'Node', 'MouseEvent', 'Event', 'CustomEvent', 'getComputedStyle', 'MutationObserver']) {
  if (window[name] !== undefined) globalThis[name] = window[name]
}
// The bundle reads bare `localStorage` (the auto-created workspace registry);
// jsdom keeps it on window — expose it globally like a browser does.
Object.defineProperty(globalThis, 'localStorage', { value: window.localStorage, configurable: true })
// Unexpected window/jsdom exceptions must fail the suite (never merely print).
const guards = installJsdomGuards(window, virtualConsole)

// Now that the DOM globals exist, load react-dom (which needs them).
const React = require('react')
const { createRoot } = require('react-dom/client')
const { Simulate } = require('react-dom/test-utils')
// React 18.3.1 exposes `act` on the react package; the test-utils re-export is
// deprecated and warns on every call.
const act = React.act
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let passed = 0
const tests = []
const t = (name, fn) => tests.push([name, fn])

// ── load the real client bundle ─────────────────────────────────────────────
let captured = null
window.__ModuleLoader__ = { load: (entry) => { captured = entry } }
await import(pathToFileURL(require.resolve('../client.js')))
const fakeRequire = (spec) => {
  if (spec === 'react') return React
  if (spec === 'react/jsx-runtime') return require('react/jsx-runtime')
  throw new Error(`unexpected require: ${spec}`)
}
const client = captured.factory(fakeRequire)
const testSurface = client._test

// ── fixtures ────────────────────────────────────────────────────────────────
const MAIN = { path: '.', absolutePath: '/repo', branch: 'main', head: 'aaa', primary: true, current: true }
const FEAT = { path: '.dsh-wt/feat-a', absolutePath: '/repo/.dsh-wt/feat-a', branch: 'feat-a', head: 'bbb', primary: false, current: false }
const WORKTREES = [MAIN, FEAT]
const BINDINGS = [
  { path: '/repo', notARepo: false, root: '/repo', worktree: { path: '/repo', branch: 'main', head: 'aaa', detached: false, primary: true } },
  { path: '/repo/.dsh-wt/feat-a', notARepo: false, root: '/repo', worktree: { path: '/repo/.dsh-wt/feat-a', branch: 'feat-a', head: 'bbb', detached: false, primary: false } },
]

const SESSIONS_SNAPSHOT = {
  ids: ['s1', 's2'],
  byId: {
    s1: { id: 's1', cwd: '/repo', displayTitle: 'main', origin: 'user', blank: false, running: false },
    s2: { id: 's2', cwd: '/repo/.dsh-wt/feat-a', displayTitle: 'feat-a', origin: 'user', blank: false, running: false },
  },
  current: 's1',
}

const ROOT_WS = { workspaceId: 'w1', path: '/repo', title: 'repo', sessionIds: [], createdAt: '', updatedAt: '' }
const FEAT_WS = { workspaceId: 'w2', path: '/repo/.dsh-wt/feat-a', title: 'feat-a', sessionIds: [], createdAt: '', updatedAt: '' }

/** Build a fetch stub over the /dsh-git-worktree routes. `calls` records every request. */
function makeFetch({ calls = [], worktrees = WORKTREES, notARepo = false, bindings = BINDINGS } = {}) {
  return async (url, init) => {
    const u = String(url)
    calls.push({ url: u, init })
    let body
    if (u.includes('/list?')) {
      body = notARepo
        ? { ok: true, data: { notARepo: true, root: null, worktrees: [] } }
        : { ok: true, data: { notARepo: false, root: '/repo', worktrees } }
    } else if (u.includes('/bindings')) {
      body = { ok: true, data: { bindings } }
    } else if (u.includes('/add')) {
      body = { ok: true, data: { path: '.dsh-wt/new-feat', absolutePath: '/repo/.dsh-wt/new-feat', branch: 'new-feat' } }
    } else if (u.includes('/remove')) {
      body = { ok: true, data: { removed: '.dsh-wt/feat-a' } }
    } else {
      body = { ok: false, error: { message: `unexpected route ${u}` } }
    }
    return { ok: body.ok, status: body.ok ? 200 : 400, json: async () => body }
  }
}

// ── per-route fetch helpers (remove-confirmation scenarios) ─────────────────
const okRes = (data) => ({ ok: true, status: 200, json: async () => ({ ok: true, data }) })
const errRes = (message, status = 400) => ({ ok: false, status, json: async () => ({ ok: false, error: { message } }) })

/** Build a fetch stub that answers the listed route needles first, else falls back. */
function routeFetch(routes, fallback = makeFetch({})) {
  return async (url, init) => {
    const u = String(url)
    for (const [needle, handler] of routes) {
      if (u.includes(needle)) return handler(u, init)
    }
    return fallback(u, init)
  }
}

const TWO_IDLE = {
  ids: ['s2', 's3'],
  byId: {
    s2: { id: 's2', cwd: '/repo/.dsh-wt/feat-a', displayTitle: 'feat-a', origin: 'user', blank: false, running: false },
    s3: { id: 's3', cwd: '/repo/.dsh-wt/feat-a', displayTitle: 'feat-a-2', origin: 'user', blank: false, running: false },
  },
  current: 's2',
}
const FEAT_BINDINGS = [
  { path: '/repo', notARepo: false, root: '/repo', worktree: { path: '/repo', branch: 'main', head: 'aaa', detached: false, primary: true } },
  { path: '/repo/.dsh-wt/feat-a', notARepo: false, root: '/repo', worktree: { path: '/repo/.dsh-wt/feat-a', branch: 'feat-a', head: 'bbb', detached: false, primary: false } },
]

/** Open the remove popover on the linked feat-a row and let the binding load. */
async function openRemove(m) {
  const featRow = dragRows().find((r) => r.textContent.includes('feat-a'))
  await m.act(async () => { featRow.querySelector('[data-gwt-control="remove"]').click() })
  await m.act(async () => { await flush() })
}

// ── simulated workspace tree (structural contract, no hashed classes) ───────
/**
 * Render a tree row mirroring ProjectRowItem: role=treeitem + aria-expanded,
 * a label span (`span > span`), and an actions span holding the stock ellipsis
 * and new-session buttons. `buttons: 1` models the ungrouped pseudo-row.
 */
function rowHtml(title, { expanded = true, buttons = 2 } = {}) {
  // The core Menu primitive wraps its ellipsis anchor in its own <span>, so a
  // real workspace row's actions hold [span(button), button]; the ungrouped
  // pseudo-row holds only the bare new-session button.
  const stock = buttons >= 2
    ? `<span class="menuRoot"><button type="button" aria-label="工作区操作：${title}"></button></span><button type="button" aria-label="新建会话：${title}"></button>`
    : `<button type="button" aria-label="新建会话：${title}"></button>`
  return `<div class="groupSection"><div role="treeitem" aria-expanded="${expanded}" draggable="true">`
    + '<span class="slot folder"></span><span class="slot chevron"></span>'
    + `<span class="projectText"><span class="title">${title}</span></span>`
    + `<span class="rowActions">${stock}</span>`
    + '</div></div>'
}

function renderTree(rows) {
  return `<div role="tree" aria-label="会话">${rows.map((row) => rowHtml(row.title, row)).join('')}</div>`
}

let treeHost = null
function installTree(rows) {
  if (treeHost !== null) treeHost.remove()
  treeHost = document.createElement('div')
  treeHost.id = 'gwt-test-tree'
  treeHost.innerHTML = renderTree(rows)
  document.body.appendChild(treeHost)
  return treeHost
}

// ── mount helper ────────────────────────────────────────────────────────────
/**
 * Applies the client against a fake ctx, then mounts the registered footer
 * component (`sidebar.footer.action`) over a simulated tree.
 *
 * `useWorkspaces`/`useSessions` mimic the framework's selector hooks over
 * static snapshots (useSessions honors the isEqual argument so content-equal
 * reselections keep a stable identity, exactly like the real store).
 */
function mount({
  fetch,
  workspaces = [ROOT_WS, FEAT_WS],
  sessions = SESSIONS_SNAPSHOT,
  rows = [{ title: 'repo' }, { title: 'feat-a' }],
  phase = 'ready',
  list,
  syncProps = {},
} = {}) {
  const calls = []
  globalThis.fetch = fetch ?? makeFetch({ calls })
  installTree(rows)
  const container = document.getElementById('root')
  const mounted = { calls, container }

  const fakeCtx = {
    slots: {
      inject: (slot, callback) => callback(),
      register: (options, component) => {
        mounted.components = mounted.components ?? {}
        mounted.components[options.name] = component
        return () => {}
      },
    },
    get: () => undefined,
  }
  client.apply(fakeCtx)
  const WorktreeSync = mounted.components['sidebar.footer.action']
  assert.ok(WorktreeSync, 'footer component registered')

  const runtime = {
    created: [],
    renamed: [],
    deleted: [],
    async create({ path }) {
      const base = path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? path
      const w = { workspaceId: `w-auto-${this.created.length + 1}`, path, title: base, sessionIds: [], createdAt: '', updatedAt: '' }
      this.created.push(w)
      return w
    },
    async rename(id, title) {
      this.renamed.push([id, title])
      return { workspaceId: id, path: '/repo', title, sessionIds: [], createdAt: '', updatedAt: '' }
    },
    async delete(id) {
      this.deleted.push(id)
    },
  }
  const sync = {
    list: list ?? ((path) => testSurface.api(`/dsh-git-worktree/list?repo=${encodeURIComponent(path)}`)),
    create: (input) => runtime.create(input),
    rename: (id, title) => runtime.rename(id, title),
    delete: (id) => runtime.delete(id),
  }
  const wsState = { items: workspaces, phase, state: 'idle', archivedSessionIds: [], baselinesReady: phase === 'ready', recentWorkspaceId: undefined, error: null }
  const useWorkspaces = (selector) => selector(wsState)
  const useSessions = (selector, isEqual) => {
    const [snap, setSnap] = React.useState(sessions)
    mounted.bumpSessions = setSnap
    const last = React.useRef(undefined)
    const next = selector(snap)
    if (last.current === undefined || !(isEqual ? isEqual(next, last.current) : Object.is(next, last.current))) {
      last.current = next
    }
    return last.current
  }
  const root = createRoot(container)
  mounted.act = async (fn) => act(async () => { await fn?.() })
  mounted.render = async (props = {}) => {
    await act(async () => {
      root.render(React.createElement(WorktreeSync, {
        useWorkspaces,
        useSessions,
        sync,
        openBoundSession: props.openBoundSession ?? (async (p) => ({ ok: true, sessionId: 's-new', path: p })),
        archiveSessions: props.archiveSessions ?? (async () => {}),
        debounceMs: 1,
        intervalMs: 60000,
        doc: document,
        ...syncProps,
      }))
    })
  }
  mounted.runtime = runtime
  mounted.root = root
  mounted.unmount = async () => { await act(async () => { root.unmount() }) }
  return mounted
}

const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => [...document.querySelectorAll(sel)]
const text = (sel) => $(sel)?.textContent ?? ''
const controls = (kind) => $$(`[data-gwt-control${kind ? `="${kind}"` : ''}]`)
const stockPlusOf = (row) => [...row.querySelector('.rowActions').children].find((b) => b.tagName === 'BUTTON' && b.getAttribute('data-gwt-stock-hidden') === '1')

/** Type into a controlled React input (Simulate bypasses jsdom's broken input dispatch). */
const type = (input, value) => {
  Simulate.change(input, { target: { value } })
}

/** Let a 1ms debounce timer fire, the sync settle, and the observer scan. */
const flush = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms))

const dragRows = () => [...document.querySelectorAll('#gwt-test-tree [role="treeitem"]')]

// ── sync: auto-detect + registration ────────────────────────────────────────

t('sync: registers worktrees as workspaces and marks the main worktree', async () => {
  testSurface._reset()
  const m = mount({ workspaces: [ROOT_WS] })
  await m.render()
  await m.act(async () => { await flush() })
  assert.equal(m.runtime.renamed.length, 1, 'one rename (the marker)')
  assert.equal(m.runtime.renamed[0][1], 'repo（主工作树）')
  assert.equal(m.runtime.created.length, 1, 'one workspace created')
  assert.equal(m.runtime.created[0].path, '/repo/.dsh-wt/feat-a')
  const state = testSurface.worktreeStore.state
  assert.ok(state.byPath.has('/repo'), 'main worktree known')
  assert.ok(state.byPath.has('/repo/.dsh-wt/feat-a'), 'linked worktree known')
  assert.equal(state.byPath.get('/repo').primary, true)
  assert.equal(state.byPath.get('/repo/.dsh-wt/feat-a').primary, false)
  await m.unmount()
  testSurface._reset()
})

t('sync: skips non-repo workspaces and does not touch their folders', async () => {
  testSurface._reset()
  const m = mount({
    fetch: makeFetch({ notARepo: true }),
    workspaces: [{ workspaceId: 'w-plain', path: '/plain', title: 'plain', sessionIds: [], createdAt: '', updatedAt: '' }],
    rows: [{ title: 'plain' }],
  })
  await m.render()
  await m.act(async () => { await flush() })
  assert.equal(m.runtime.created.length, 0, 'nothing registered')
  assert.equal(m.runtime.renamed.length, 0, 'nothing renamed')
  assert.equal(testSurface.worktreeStore.state.byPath.size, 0)
  assert.equal(controls().length, 0, 'no control injected into a non-repo row')
  await m.unmount()
  testSurface._reset()
})

t('sync: stale sweep unregisters a sessionless worktree that left git', async () => {
  testSurface._reset()
  testSurface.saveAuto(new Set(['w2']))
  const m = mount({ fetch: makeFetch({ worktrees: [MAIN] }), workspaces: [ROOT_WS, FEAT_WS] })
  await m.render()
  await m.act(async () => { await flush() })
  assert.deepEqual(m.runtime.deleted, ['w2'], 'stale sessionless worktree unregistered')
  assert.ok(![...testSurface.loadAuto()].includes('w2'), 'id dropped from the auto registry')
  await m.unmount()
  testSurface._reset()
})

t('sync: keeps a stale worktree that still has sessions', async () => {
  testSurface._reset()
  testSurface.saveAuto(new Set(['w2']))
  const withSession = { ...FEAT_WS, sessionIds: ['s2'] }
  const m = mount({ fetch: makeFetch({ worktrees: [MAIN] }), workspaces: [ROOT_WS, withSession] })
  await m.render()
  await m.act(async () => { await flush() })
  assert.deepEqual(m.runtime.deleted, [], 'session-bearing worktree kept')
  await m.unmount()
  testSurface._reset()
})

// ── DOM integration: repo row create ────────────────────────────────────────

t('row: repo folder gets ＋ with the stock new-session ＋ hidden', async () => {
  testSurface._reset()
  const m = mount()
  await m.render()
  await m.act(async () => { await flush() })
  const rows = dragRows()
  const repoRow = rows.find((r) => r.textContent.includes('repo') && !r.textContent.includes('feat-a'))
  const create = repoRow.querySelector('[data-gwt-control="create"]')
  assert.ok(create, 'create control injected on the repo row')
  assert.equal(create.className, 'gwt-rowPlus')
  const hidden = stockPlusOf(repoRow)
  assert.ok(hidden, 'stock new-session ＋ hidden while the injection is live')
  assert.equal(hidden.style.display, 'none')
  // the linked worktree row keeps its stock ＋ and gains a remove control
  const featRow = rows.find((r) => r.textContent.includes('feat-a'))
  assert.ok(featRow.querySelector('[data-gwt-control="remove"]'), 'remove control injected on the linked row')
  assert.equal(stockPlusOf(featRow), undefined, 'stock ＋ untouched on the linked row')
  await m.unmount()
  testSurface._reset()
})

t('row: repo ＋ opens the worktree popover and creates a bound session', async () => {
  testSurface._reset()
  let openedPath = null
  const m = mount()
  await m.render({ openBoundSession: async (p) => { openedPath = p; return { ok: true, sessionId: 's-new' } } })
  await m.act(async () => { await flush() })
  assert.ok(!$('.gwt-createPop'), 'popover closed initially')
  await m.act(async () => { $('[data-gwt-control="create"]').click() })
  await m.act(async () => {})
  assert.ok($('.gwt-createPop'), 'popover opens')
  assert.ok(text('.gwt-createPop').includes('新增工作树：repo'))
  await m.act(async () => { type($('.gwt-createInput'), 'new-feat') })
  await m.act(async () => { $$('.gwt-createPop button').find((b) => b.textContent.includes('创建绑定会话')).click() })
  await m.act(async () => { await flush() })
  const addCall = m.calls.find((c) => c.url.includes('/add'))
  assert.ok(addCall, 'POST /add fired')
  assert.equal(JSON.parse(addCall.init.body).name, 'new-feat')
  assert.equal(openedPath, '/repo/.dsh-wt/new-feat', 'bound session opened at the worktree')
  assert.ok(!$('.gwt-createPop'), 'popover closes on success')
  await m.unmount()
  testSurface._reset()
})

t('row: worktree-only skips opening a session', async () => {
  testSurface._reset()
  let opened = false
  const m = mount()
  await m.render({ openBoundSession: async () => { opened = true; return { ok: true } } })
  await m.act(async () => { await flush() })
  await m.act(async () => { $('[data-gwt-control="create"]').click() })
  await m.act(async () => { type($('.gwt-createInput'), 'w-only') })
  await m.act(async () => { $$('.gwt-createPop button').find((b) => b.textContent.includes('仅创建工作树')).click() })
  await m.act(async () => { await flush() })
  assert.equal(opened, false, 'no session opened for worktree-only')
  assert.ok(m.calls.some((c) => c.url.includes('/add')), 'worktree created')
  await m.unmount()
  testSurface._reset()
})

t('row: session-open failure keeps the popover open with the reason', async () => {
  testSurface._reset()
  const m = mount()
  await m.render({ openBoundSession: async () => ({ ok: false, message: 'boom' }) })
  await m.act(async () => { await flush() })
  await m.act(async () => { $('[data-gwt-control="create"]').click() })
  await m.act(async () => { type($('.gwt-createInput'), 'fail') })
  await m.act(async () => { $$('.gwt-createPop button').find((b) => b.textContent.includes('创建绑定会话')).click() })
  await m.act(async () => { await flush() })
  assert.ok($('.gwt-createPop'), 'popover stays open')
  assert.ok(text('.gwt-error').includes('boom'), 'failure reason surfaced')
  await m.unmount()
  testSurface._reset()
})

t('row: create button disabled for empty name', async () => {
  testSurface._reset()
  const m = mount()
  await m.render()
  await m.act(async () => { await flush() })
  await m.act(async () => { $('[data-gwt-control="create"]').click() })
  const createBtn = $$('.gwt-createPop button').find((b) => b.textContent.includes('创建绑定会话'))
  assert.ok(createBtn.disabled, 'create disabled while the name is empty')
  await m.act(async () => { type($('.gwt-createInput'), 'x') })
  await m.act(async () => {})
  assert.ok(!$$('.gwt-createPop button').find((b) => b.textContent.includes('创建绑定会话')).disabled, 'enabled after typing')
  await m.unmount()
  testSurface._reset()
})

t('row: create form has a persistent label, example, and sanitized preview', async () => {
  testSurface._reset()
  const m = mount()
  await m.render()
  await m.act(async () => { await flush() })
  await m.act(async () => { $('[data-gwt-control="create"]').click() })
  await m.act(async () => {})
  const pop = $('.gwt-createPop')
  assert.equal(pop.getAttribute('role'), 'dialog', 'create popover is a named dialog')
  assert.equal(pop.getAttribute('aria-label'), '新增工作树')
  assert.ok(text('.gwt-fieldLabel').includes('工作树名称'), 'persistent accessible label')
  assert.ok($('.gwt-createInput').placeholder.includes('例如'), 'simple example placeholder')
  assert.ok($('.gwt-createInput').getAttribute('aria-describedby'), 'input is described for assistive tech')
  await m.act(async () => { type($('.gwt-createInput'), 'ux review 20260919') })
  await m.act(async () => {})
  assert.ok(text('.gwt-preview').includes('ux-review-20260919'), 'sanitized name previewed')
  assert.ok(text('.gwt-preview').includes('.dsh-wt/ux-review-20260919'), 'preview names the target path')
  await m.unmount()
  testSurface._reset()
})

t('row: invalid names disable create with a clear error; unicode stays legal', async () => {
  testSurface._reset()
  const m = mount()
  await m.render()
  await m.act(async () => { await flush() })
  await m.act(async () => { $('[data-gwt-control="create"]').click() })
  const createBtn = () => $$('.gwt-createPop button').find((b) => b.textContent.includes('创建绑定会话'))
  assert.ok(createBtn().disabled, 'blank disables create')
  await m.act(async () => { type($('.gwt-createInput'), '///') })
  await m.act(async () => {})
  assert.ok(createBtn().disabled, '/// disables create')
  assert.ok($('.gwt-fieldError'), '/// shows a clear error')
  await m.act(async () => { type($('.gwt-createInput'), '...') })
  await m.act(async () => {})
  assert.ok(createBtn().disabled, '... disables create')
  await m.act(async () => { type($('.gwt-createInput'), '功能 开发') })
  await m.act(async () => {})
  assert.ok(!createBtn().disabled, 'non-ASCII legal name enables create')
  await m.act(async () => { $$('.gwt-createPop button').find((b) => b.textContent.includes('仅创建工作树')).click() })
  await m.act(async () => { await flush() })
  const add = m.calls.find((c) => c.url.includes('/add'))
  assert.equal(JSON.parse(add.init.body).name, '功能-开发', 'POST carries the sanitized unicode name')
  await m.unmount()
  testSurface._reset()
})

t('row: Enter ignores IME composition and submits a valid name once', async () => {
  testSurface._reset()
  const m = mount()
  await m.render()
  await m.act(async () => { await flush() })
  await m.act(async () => { $('[data-gwt-control="create"]').click() })
  await m.act(async () => { type($('.gwt-createInput'), 'feat') })
  const input = $('.gwt-createInput')
  await m.act(async () => { input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })) })
  await m.act(async () => { await flush() })
  assert.equal(m.calls.filter((c) => c.url.includes('/add')).length, 0, 'composition Enter never submits')
  await m.act(async () => { input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await m.act(async () => { await flush() })
  assert.equal(m.calls.filter((c) => c.url.includes('/add')).length, 1, 'plain Enter submits exactly once')
  assert.ok(!$('.gwt-createPop'), 'the session path closes on success')
  await m.unmount()
  testSurface._reset()
})

t('row: create double-click posts add exactly once', async () => {
  testSurface._reset()
  const m = mount()
  await m.render()
  await m.act(async () => { await flush() })
  await m.act(async () => { $('[data-gwt-control="create"]').click() })
  await m.act(async () => { type($('.gwt-createInput'), 'feat') })
  const btn = $$('.gwt-createPop button').find((b) => b.textContent.includes('创建绑定会话'))
  await m.act(async () => { btn.click(); btn.click() })
  await m.act(async () => { await flush() })
  assert.equal(m.calls.filter((c) => c.url.includes('/add')).length, 1, 'synchronous guard blocks the second create')
  await m.unmount()
  testSurface._reset()
})

t('row: session-open failure preserves the created result and retries only the session', async () => {
  testSurface._reset()
  let openCalls = 0
  const m = mount()
  await m.render({
    openBoundSession: async () => {
      openCalls += 1
      return openCalls === 1 ? { ok: false, message: 'open boom' } : { ok: true, sessionId: 's-new' }
    },
  })
  await m.act(async () => { await flush() })
  await m.act(async () => { $('[data-gwt-control="create"]').click() })
  await m.act(async () => { type($('.gwt-createInput'), 'feat') })
  await m.act(async () => { $$('.gwt-createPop button').find((b) => b.textContent.includes('创建绑定会话')).click() })
  await m.act(async () => { await flush() })
  assert.equal(m.calls.filter((c) => c.url.includes('/add')).length, 1, 'one add')
  assert.ok($('.gwt-created'), 'created result kept visible')
  assert.ok(text('.gwt-createdPath').includes('/repo/.dsh-wt/new-feat'), 'actual returned path shown')
  assert.ok(text('.gwt-error').includes('open boom'), 'open failure reason shown')
  await m.act(async () => { $$('.gwt-createPop button').find((b) => b.textContent.includes('打开绑定会话')).click() })
  await m.act(async () => { await flush() })
  assert.equal(m.calls.filter((c) => c.url.includes('/add')).length, 1, 'retry never posts add again')
  assert.equal(openCalls, 2, 'retry only re-opens the session')
  assert.ok(!$('.gwt-createPop'), 'closes once the session opens')
  await m.unmount()
  testSurface._reset()
})

t('row: only-create success shows path/branch with open/finish actions', async () => {
  testSurface._reset()
  let opened = false
  const m = mount()
  await m.render({ openBoundSession: async () => { opened = true; return { ok: true } } })
  await m.act(async () => { await flush() })
  await m.act(async () => { $('[data-gwt-control="create"]').click() })
  await m.act(async () => { type($('.gwt-createInput'), 'feat') })
  await m.act(async () => { $$('.gwt-createPop button').find((b) => b.textContent.includes('仅创建工作树')).click() })
  await m.act(async () => { await flush() })
  assert.equal(opened, false, 'worktree-only never opens a session')
  assert.equal(m.calls.filter((c) => c.url.includes('/add')).length, 1)
  assert.ok($('.gwt-created'), 'success panel stays open')
  assert.ok(text('.gwt-createdPath').includes('/repo/.dsh-wt/new-feat'), 'actual path shown before any sidebar poll')
  assert.ok(text('.gwt-created').includes('new-feat'), 'branch shown')
  assert.ok($$('.gwt-createPop button').some((b) => b.textContent.includes('打开绑定会话')), 'open action offered')
  assert.ok($$('.gwt-createPop button').some((b) => b.textContent.includes('完成')), 'finish action offered')
  await m.act(async () => { $$('.gwt-createPop button').find((b) => b.textContent.includes('完成')).click() })
  await m.act(async () => {})
  assert.ok(!$('.gwt-createPop'), 'finish closes')
  await m.unmount()
  testSurface._reset()
})

// ── DOM integration: linked worktree row ────────────────────────────────────

t('row: worktree deletion archives + removes + unregisters with bound-session confirmation', async () => {
  testSurface._reset()
  const archived = []
  const m = mount()
  await m.render({ archiveSessions: async (ids) => { archived.push(...ids) } })
  await m.act(async () => { await flush() })
  const featRow = dragRows().find((r) => r.textContent.includes('feat-a'))
  await m.act(async () => { featRow.querySelector('[data-gwt-control="remove"]').click() })
  await m.act(async () => { await flush() })
  assert.ok($('.gwt-createPop'), 'confirm popover opens')
  assert.ok(text('.gwt-createPop').includes('删除工作树？'))
  assert.ok(text('.gwt-createPop').includes('/repo/.dsh-wt/feat-a'))
  assert.ok(text('.gwt-createPop').includes('feat-a @ bbb'), 'branch line')
  assert.ok(text('.gwt-createPop').includes('绑定会话（1）：feat-a'), 'bound sessions listed')
  assert.equal($('.gwt-check input').checked, true, 'archive pre-checked when sessions are bound')
  await m.act(async () => { $$('.gwt-createPop button').find((b) => b.textContent.includes('确认删除')).click() })
  await m.act(async () => { await flush() })
  const removeCall = m.calls.find((c) => c.url.includes('/remove'))
  assert.ok(removeCall, 'POST /remove fired')
  assert.deepEqual(JSON.parse(removeCall.init.body), { repo: '/repo', path: '/repo/.dsh-wt/feat-a' })
  assert.deepEqual(archived, ['s2'], 'bound session archived')
  assert.ok(m.runtime.deleted.includes('w2'), 'worktree workspace unregistered')
  await m.unmount()
  testSurface._reset()
})

t('row: delete with archive unchecked keeps the sessions unarchived', async () => {
  testSurface._reset()
  const archived = []
  const m = mount()
  await m.render({ archiveSessions: async (ids) => { archived.push(...ids) } })
  await m.act(async () => { await flush() })
  const featRow = dragRows().find((r) => r.textContent.includes('feat-a'))
  await m.act(async () => { featRow.querySelector('[data-gwt-control="remove"]').click() })
  await m.act(async () => { await flush() })
  await m.act(async () => { $('.gwt-check input').click() }) // uncheck
  await m.act(async () => { $$('.gwt-createPop button').find((b) => b.textContent.includes('确认删除')).click() })
  await m.act(async () => { await flush() })
  assert.deepEqual(archived, [], 'no archive without the checkbox')
  assert.ok(m.calls.some((c) => c.url.includes('/remove')), 'worktree still removed')
  await m.unmount()
  testSurface._reset()
})

t('row: worktree with no sessions shows the note and disables archive', async () => {
  testSurface._reset()
  const noSessionBindings = [
    { path: '/repo', notARepo: false, root: '/repo', worktree: { path: '/repo', branch: 'main', head: 'aaa', detached: false, primary: true } },
  ]
  const m = mount({ fetch: makeFetch({ bindings: noSessionBindings }) })
  await m.render()
  await m.act(async () => { await flush() })
  const featRow = dragRows().find((r) => r.textContent.includes('feat-a'))
  await m.act(async () => { featRow.querySelector('[data-gwt-control="remove"]').click() })
  await m.act(async () => { await flush() })
  assert.ok(text('.gwt-createPop').includes('无绑定会话'), 'note shown')
  assert.equal($('.gwt-check input'), null, 'archive checkbox omitted when there are no sessions')
  await m.unmount()
  testSurface._reset()
})

t('row: non-repo and unrelated nested folders keep their default actions', async () => {
  testSurface._reset()
  const m = mount({
    fetch: makeFetch({ notARepo: true }),
    workspaces: [
      { workspaceId: 'w-plain', path: '/plain', title: 'plain', sessionIds: [], createdAt: '', updatedAt: '' },
      { workspaceId: 'w-docs', path: '/repo/docs', title: 'docs', sessionIds: [], createdAt: '', updatedAt: '' },
    ],
    rows: [{ title: 'plain' }, { title: 'docs' }],
  })
  await m.render()
  await m.act(async () => { await flush() })
  assert.equal(controls().length, 0, 'no control injected into non-worktree rows')
  await m.unmount()
  testSurface._reset()
})

// ── DOM integration: duplicate labels ───────────────────────────────────────

t('row: duplicate labels open an explicit chooser instead of guessing a repo', async () => {
  testSurface._reset()
  const items = [
    { workspaceId: 'wa', path: '/a/repo', title: 'repo', sessionIds: [], createdAt: '', updatedAt: '' },
    { workspaceId: 'wb', path: '/b/repo', title: 'repo', sessionIds: [], createdAt: '', updatedAt: '' },
  ]
  const m = mount({ workspaces: items, phase: 'pending', rows: [{ title: 'repo' }] })
  // Publish both worktrees directly (bypasses the sync pass for this fixture).
  testSurface.worktreeStore.publish(
    new Map([
      ['/a/repo', { branch: 'main', head: '1', primary: true, repoRoot: '/a/repo' }],
      ['/b/repo', { branch: 'main', head: '2', primary: true, repoRoot: '/b/repo' }],
    ]),
    new Map([['/a/repo', ['/a/repo']], ['/b/repo', ['/b/repo']]]),
  )
  await m.render()
  await m.act(async () => { await flush() })
  const row = dragRows()[0]
  const ambiguous = row.querySelector('[data-gwt-control="ambiguous"]')
  assert.ok(ambiguous, 'ambiguous control injected for the duplicate label')
  assert.equal(row.querySelector('[data-gwt-control="create"]'), null, 'no silent create control')
  await m.act(async () => { ambiguous.click() })
  await m.act(async () => {})
  assert.ok(text('.gwt-createPop').includes('选择工作区'), 'chooser opens')
  const choices = $$('.gwt-createPop .gwt-chooseItem')
  assert.equal(choices.length, 2, 'both candidates offered')
  assert.ok(choices[0].textContent.includes('/a/repo') || choices[1].textContent.includes('/a/repo'))
  // pick the /b/repo candidate → its create popover targets that repo
  const target = choices.find((c) => c.textContent.includes('/b/repo'))
  await m.act(async () => { target.click() })
  await m.act(async () => {})
  assert.ok(text('.gwt-createPop').includes('/b/repo'), 'create popover targets the explicitly picked repo')
  await m.unmount()
  testSurface._reset()
})

// ── DOM integration: lifecycle ──────────────────────────────────────────────

t('row: injection survives a row rerender and repairs a recreated stock ＋', async () => {
  testSurface._reset()
  const m = mount()
  await m.render()
  await m.act(async () => { await flush() })
  const oldRow = dragRows()[0]
  assert.ok(oldRow.querySelector('[data-gwt-control="create"]'), 'control present')
  // Simulate React replacing the row subtree (fresh stock ＋ without our mark).
  const replacement = document.createElement('div')
  replacement.innerHTML = rowHtml('repo')
  const newRow = replacement.firstElementChild.firstElementChild
  oldRow.replaceWith(newRow)
  await m.act(async () => { await flush() })
  assert.equal(newRow.querySelectorAll('[data-gwt-control="create"]').length, 1, 'exactly one create control after the rerender')
  assert.ok(stockPlusOf(newRow), 'the fresh stock ＋ is hidden again')
  await m.unmount()
  testSurface._reset()
})

t('row: rename removes the control when the label no longer matches, and restores it', async () => {
  testSurface._reset()
  const m = mount()
  await m.render()
  await m.act(async () => { await flush() })
  let row = dragRows()[0]
  assert.ok(row.querySelector('[data-gwt-control="create"]'), 'control present before rename')
  row.querySelector('.title').textContent = 'renamed'
  await m.act(async () => { await flush() })
  row = dragRows()[0]
  assert.equal(row.querySelector('[data-gwt-control="create"]'), null, 'control removed for an unmatched label')
  assert.equal(stockPlusOf(row), undefined, 'stock ＋ restored')
  row.querySelector('.title').textContent = 'repo'
  await m.act(async () => { await flush() })
  row = dragRows()[0]
  assert.ok(row.querySelector('[data-gwt-control="create"]'), 'control restored when the label matches again')
  await m.unmount()
  testSurface._reset()
})

t('row: unmount disposes observers/containers and restores stock controls', async () => {
  testSurface._reset()
  const m = mount()
  await m.render()
  await m.act(async () => { await flush() })
  assert.ok(controls().length > 0, 'controls installed before unmount')
  await m.unmount()
  assert.equal(controls().length, 0, 'all plugin controls removed')
  assert.equal($('[data-gwt-resolved]'), null, 'row resolution markers removed')
  assert.equal($('[data-gwt-stock-hidden]'), null, 'stock hidden markers removed')
  // The observer is disconnected: a later tree mutation must not re-inject.
  const rows = dragRows()
  rows[0].querySelector('.title').textContent = 'repo'
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(controls().length, 0, 'no re-injection after unmount (observer disposed)')
  testSurface._reset()
})

// ── popover dismissal + isolation ───────────────────────────────────────────

t('row: clicking outside closes the popover', async () => {
  testSurface._reset()
  const m = mount()
  await m.render()
  await m.act(async () => { await flush() })
  await m.act(async () => { $('[data-gwt-control="create"]').click() })
  await m.act(async () => {})
  assert.ok($('.gwt-createPop'), 'popover open')
  await m.act(async () => {
    document.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }))
  })
  await m.act(async () => {})
  assert.ok(!$('.gwt-createPop'), 'popover closed by outside pointerdown')
  await m.unmount()
  testSurface._reset()
})

t('row: the injected control click never leaks to the row', async () => {
  testSurface._reset()
  const m = mount()
  await m.render()
  await m.act(async () => { await flush() })
  const row = dragRows()[0]
  let rowClicks = 0
  row.addEventListener('click', () => { rowClicks += 1 })
  await m.act(async () => { row.querySelector('[data-gwt-control="create"]').click() })
  await m.act(async () => {})
  assert.equal(rowClicks, 0, 'control click stopped at the button')
  assert.ok($('.gwt-createPop'), 'popover still opened')
  await m.unmount()
  testSurface._reset()
})

t('row: busy create disables the input + actions and cannot be dismissed', async () => {
  testSurface._reset()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const fetch = routeFetch([
    ['/add', async () => { await gate; return okRes({ path: '.dsh-wt/feat', absolutePath: '/repo/.dsh-wt/feat', branch: 'feat' }) }],
  ])
  const m = mount({ fetch })
  await m.render()
  await m.act(async () => { await flush() })
  await m.act(async () => { $('[data-gwt-control="create"]').click() })
  await m.act(async () => { type($('.gwt-createInput'), 'feat') })
  await m.act(async () => { $$('.gwt-createPop button').find((b) => b.textContent.includes('仅创建工作树')).click() })
  assert.ok($('.gwt-createInput').disabled, 'input disabled while busy')
  assert.ok($$('.gwt-createPop button').every((b) => b.disabled), 'all actions disabled while busy')
  assert.ok($$('.gwt-createPop button').some((b) => b.textContent.includes('取消')), 'create has an explicit cancel action')
  await m.act(async () => { $('.gwt-createPop').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  await m.act(async () => {})
  assert.ok($('.gwt-createPop'), 'Escape cannot dismiss a busy create')
  await m.act(async () => { document.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true })) })
  await m.act(async () => {})
  assert.ok($('.gwt-createPop'), 'outside click cannot dismiss a busy create')
  release()
  await m.act(async () => { await flush() })
  assert.ok($('.gwt-created'), 'settles into the created panel')
  await m.unmount()
  testSurface._reset()
})

t('row: Escape/cancel close an idle popover and restore focus to the trigger', async () => {
  testSurface._reset()
  const m = mount()
  await m.render()
  await m.act(async () => { await flush() })
  const trigger = $('[data-gwt-control="create"]')
  await m.act(async () => { trigger.click() })
  await m.act(async () => {})
  assert.ok($('.gwt-createPop'), 'create open')
  assert.equal(document.activeElement, $('.gwt-createInput'), 'focus enters the create input')
  await m.act(async () => { $$('.gwt-createPop button').find((b) => b.textContent.includes('取消')).click() })
  await m.act(async () => {})
  assert.ok(!$('.gwt-createPop'), 'cancel closes the idle create')
  assert.equal(document.activeElement, trigger, 'focus restored after cancel')
  await m.act(async () => { await flush() })
  await openRemove(m)
  assert.equal(document.activeElement, $('.gwt-createPop'), 'focus enters the remove dialog')
  await m.act(async () => { $('.gwt-createPop').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  await m.act(async () => {})
  assert.ok(!$('.gwt-createPop'), 'Escape closes the idle remove dialog')
  assert.equal(document.activeElement, $('.gwt-rowRemove'), 'focus restored to the remove trigger')
  await m.unmount()
  testSurface._reset()
})

t('row: popover clamps inside the viewport with bounded scrolling', async () => {
  testSurface._reset()
  const m = mount()
  await m.render()
  await m.act(async () => { await flush() })
  const trigger = $('[data-gwt-control="create"]')
  trigger.getBoundingClientRect = () => ({ left: 5000, top: 5000, right: 5020, bottom: 5020, width: 20, height: 20 })
  await m.act(async () => { trigger.click() })
  await m.act(async () => {})
  const pop = $('.gwt-createPop')
  assert.equal(pop.style.left, '1016px', 'right edge clamped (1024 - 8)')
  assert.equal(pop.style.top, '760px', 'bottom edge clamped (768 - 8)')
  const css = $('style[data-plugin-css="dsh-git-worktree/tree.css"]').textContent
  assert.ok(css.includes('max-height') && css.includes('overflow'), 'bounded height + scroll in the stylesheet')
  // Dynamic error text must not push it back out of the viewport.
  await m.act(async () => { type($('.gwt-createInput'), '///') })
  await m.act(async () => {})
  assert.ok(parseFloat($('.gwt-createPop').style.left) <= 1016)
  assert.ok(parseFloat($('.gwt-createPop').style.top) <= 760)
  // A resize re-clamps to the smaller viewport.
  window.innerWidth = 500
  await m.act(async () => { window.dispatchEvent(new window.Event('resize')) })
  await m.act(async () => {})
  assert.equal($('.gwt-createPop').style.left, '492px', 're-clamped after resize')
  window.innerWidth = 1024
  await m.unmount()
  testSurface._reset()
})

// ── remove confirmation: full roster, running guard, git-first cleanup ──────

t('remove: two sessions at the same cwd are both listed and archived', async () => {
  testSurface._reset()
  const archived = []
  const m = mount({ fetch: routeFetch([['/bindings', () => okRes({ bindings: FEAT_BINDINGS })]]), sessions: TWO_IDLE })
  await m.render({ archiveSessions: async (ids) => { archived.push(...ids) } })
  await m.act(async () => { await flush() })
  await openRemove(m)
  assert.ok(text('.gwt-boundList').includes('feat-a') && text('.gwt-boundList').includes('feat-a-2'), 'both same-cwd sessions listed')
  assert.ok(text('.gwt-boundList').includes('绑定会话（2）'), 'roster count is both sessions, not the first')
  await m.act(async () => { $$('.gwt-createPop button').find((b) => b.textContent.includes('确认删除')).click() })
  await m.act(async () => { await flush() })
  assert.deepEqual([...archived].sort(), ['s2', 's3'], 'both sessions archived')
  await m.unmount()
  testSurface._reset()
})

t('remove: a running native subagent disables deletion with an explanation', async () => {
  testSurface._reset()
  const running = {
    ids: ['s2', 's4'],
    byId: {
      s2: { id: 's2', cwd: '/repo/.dsh-wt/feat-a', displayTitle: 'feat-a', origin: 'user', blank: false, running: false },
      s4: { id: 's4', cwd: '/repo/.dsh-wt/feat-a', displayTitle: 'child', origin: 'subagent', blank: false, running: true },
    },
    current: 's2',
  }
  const m = mount({ fetch: routeFetch([['/bindings', () => okRes({ bindings: FEAT_BINDINGS })]]), sessions: running })
  await m.render()
  await m.act(async () => { await flush() })
  await openRemove(m)
  assert.ok(text('.gwt-boundList').includes('child（运行中）'), 'running child shown as running')
  assert.ok(text('.gwt-error').includes('正在运行'), 'explicit running explanation shown')
  const confirm = $$('.gwt-createPop button').find((b) => b.textContent.includes('确认删除'))
  assert.ok(confirm.disabled, 'delete disabled while a session is running')
  await m.unmount()
  testSurface._reset()
})

t('remove: a session change refreshes the roster (no stale confirmation)', async () => {
  testSurface._reset()
  const m = mount({ fetch: routeFetch([['/bindings', () => okRes({ bindings: FEAT_BINDINGS })]]), sessions: TWO_IDLE })
  await m.render()
  await m.act(async () => { await flush() })
  await openRemove(m)
  assert.ok(text('.gwt-boundList').includes('绑定会话（2）'))
  await m.act(async () => {
    m.bumpSessions({
      ids: ['s2', 's3', 's9'],
      byId: { ...TWO_IDLE.byId, s9: { id: 's9', cwd: '/repo/.dsh-wt/feat-a', displayTitle: 'late', origin: 'user', blank: false, running: false } },
      current: 's2',
    })
  })
  await m.act(async () => { await flush() })
  assert.ok(text('.gwt-boundList').includes('绑定会话（3）'), 'roster re-resolved after the session change')
  assert.ok(text('.gwt-boundList').includes('late'))
  await m.unmount()
  testSurface._reset()
})

t('remove: a failed git removal archives nothing and can be retried', async () => {
  testSurface._reset()
  const archived = []
  let removeCalls = 0
  let failRemoval = true
  const fetch = routeFetch([
    ['/bindings', () => okRes({ bindings: FEAT_BINDINGS })],
    ['/remove', () => { removeCalls += 1; return failRemoval ? errRes('git refused the removal') : okRes({ removed: '.dsh-wt/feat-a' }) }],
  ])
  const m = mount({ fetch, sessions: TWO_IDLE })
  await m.render({ archiveSessions: async (ids) => { archived.push(...ids) } })
  await m.act(async () => { await flush() })
  await openRemove(m)
  await m.act(async () => { $$('.gwt-createPop button').find((b) => b.textContent.includes('确认删除')).click() })
  await m.act(async () => { await flush() })
  assert.equal(removeCalls, 1)
  assert.deepEqual(archived, [], 'nothing archived before a successful git removal')
  assert.deepEqual(m.runtime.deleted, [], 'workspace kept when the git removal failed')
  assert.ok(text('.gwt-error').includes('仍然存在'), 'Chinese recovery names the retained worktree')
  assert.ok(text('.gwt-rawError').includes('git refused the removal'), 'raw git error kept in collapsed details')
  assert.ok($('.gwt-createPop'), 'popover stays open')
  failRemoval = false
  await m.act(async () => {
    $$('.gwt-createPop button').find((b) => b.textContent.includes('确认删除') || b.textContent.includes('重试清理')).click()
  })
  await m.act(async () => { await flush() })
  assert.equal(removeCalls, 2, 'retry runs the git removal again because it never succeeded')
  assert.deepEqual([...archived].sort(), ['s2', 's3'])
  assert.ok(m.runtime.deleted.includes('w2'))
  assert.ok(!$('.gwt-createPop'), 'closes after the retry completes')
  await m.unmount()
  testSurface._reset()
})

t('remove: archive failure after removal retries only cleanup with frozen ids', async () => {
  testSurface._reset()
  const archived = []
  let archiveFails = true
  let removeCalls = 0
  const fetch = routeFetch([
    ['/bindings', () => okRes({ bindings: FEAT_BINDINGS })],
    ['/remove', () => { removeCalls += 1; return okRes({ removed: '.dsh-wt/feat-a' }) }],
  ])
  const m = mount({ fetch, sessions: TWO_IDLE })
  await m.render({
    archiveSessions: async (ids) => {
      if (archiveFails) throw new Error('archive service down')
      archived.push(...ids)
    },
  })
  await m.act(async () => { await flush() })
  await openRemove(m)
  await m.act(async () => { $$('.gwt-createPop button').find((b) => b.textContent.includes('确认删除')).click() })
  await m.act(async () => { await flush() })
  assert.equal(removeCalls, 1, 'git removal ran once')
  assert.ok(text('.gwt-error').includes('目录已删除') && text('.gwt-error').includes('清理未完成'), 'post-delete cleanup explained')
  assert.ok(text('.gwt-rawError').includes('archive service down'), 'raw archive failure kept in details')
  assert.ok(text('.gwt-boundList').includes('feat-a') && text('.gwt-boundList').includes('feat-a-2'), 'frozen roster still visible')
  assert.deepEqual(m.runtime.deleted, [], 'not unregistered while the archive is unfinished')
  archiveFails = false
  await m.act(async () => { $$('.gwt-createPop button').find((b) => b.textContent.includes('重试清理')).click() })
  await m.act(async () => { await flush() })
  assert.equal(removeCalls, 1, 'retry never removes the git path again')
  assert.deepEqual([...archived].sort(), ['s2', 's3'], 'frozen pending ids archived')
  assert.ok(m.runtime.deleted.includes('w2'), 'unregister finishes after the archive')
  assert.ok(!$('.gwt-createPop'), 'closes once cleanup completes')
  await m.unmount()
  testSurface._reset()
})

t('remove: unregister failure after removal+archive is surfaced and retried alone', async () => {
  testSurface._reset()
  const archived = []
  let deleteFails = true
  let removeCalls = 0
  const fetch = routeFetch([
    ['/bindings', () => okRes({ bindings: FEAT_BINDINGS })],
    ['/remove', () => { removeCalls += 1; return okRes({ removed: '.dsh-wt/feat-a' }) }],
  ])
  const m = mount({ fetch, sessions: TWO_IDLE })
  const realDelete = m.runtime.delete.bind(m.runtime)
  m.runtime.delete = async (id) => {
    if (deleteFails) throw new Error('workspace delete down')
    return realDelete(id)
  }
  await m.render({ archiveSessions: async (ids) => { archived.push(...ids) } })
  await m.act(async () => { await flush() })
  await openRemove(m)
  await m.act(async () => { $$('.gwt-createPop button').find((b) => b.textContent.includes('确认删除')).click() })
  await m.act(async () => { await flush() })
  assert.equal(removeCalls, 1)
  assert.deepEqual([...archived].sort(), ['s2', 's3'], 'archive already done')
  assert.ok(text('.gwt-error').includes('目录已删除'), 'post-delete state explained')
  assert.ok(text('.gwt-rawError').includes('workspace delete down'), 'raw unregister failure surfaced (not swallowed)')
  deleteFails = false
  await m.act(async () => { $$('.gwt-createPop button').find((b) => b.textContent.includes('重试清理')).click() })
  await m.act(async () => { await flush() })
  assert.equal(removeCalls, 1, 'git path not removed again')
  assert.equal(archived.length, 2, 'archive not repeated')
  assert.ok(m.runtime.deleted.includes('w2'))
  assert.ok(!$('.gwt-createPop'), 'closes after the unregister retry')
  await m.unmount()
  testSurface._reset()
})

t('remove: dirty git failure explains in Chinese with the raw error collapsed', async () => {
  testSurface._reset()
  const dirty = "git exited 128: fatal: '/repo/.dsh-wt/feat-a' contains modified or untracked files, use --force to delete it"
  const fetch = routeFetch([
    ['/bindings', () => okRes({ bindings: FEAT_BINDINGS })],
    ['/remove', () => errRes(dirty)],
  ])
  const m = mount({ fetch, sessions: TWO_IDLE })
  await m.render()
  await m.act(async () => { await flush() })
  await openRemove(m)
  await m.act(async () => { $$('.gwt-createPop button').find((b) => b.textContent.includes('确认删除')).click() })
  await m.act(async () => { await flush() })
  const primary = text('.gwt-error')
  assert.ok(primary.includes('工作树') && primary.includes('仍然存在'), 'says the worktree was retained')
  assert.ok(/提交|stash/.test(primary), 'tells the user to save/commit/stash first')
  assert.ok(!primary.includes('--force'), 'force is not the primary instruction')
  const details = $('.gwt-details')
  assert.ok(details, 'raw error lives in collapsed details')
  assert.equal(details.hasAttribute('open'), false, 'details collapsed by default')
  assert.ok(text('.gwt-rawError').includes('--force'), 'raw error still accessible')
  assert.deepEqual(m.runtime.deleted, [], 'nothing unregistered on a failed git removal')
  await m.unmount()
  testSurface._reset()
})

t('remove: post-delete cleanup failure says the directory was removed', async () => {
  testSurface._reset()
  const fetch = routeFetch([
    ['/bindings', () => okRes({ bindings: FEAT_BINDINGS })],
    ['/remove', () => okRes({ removed: '.dsh-wt/feat-a' })],
  ])
  const m = mount({ fetch, sessions: TWO_IDLE })
  await m.render({ archiveSessions: async () => { throw new Error('archive service down') } })
  await m.act(async () => { await flush() })
  await openRemove(m)
  await m.act(async () => { $$('.gwt-createPop button').find((b) => b.textContent.includes('确认删除')).click() })
  await m.act(async () => { await flush() })
  const primary = text('.gwt-error')
  assert.ok(primary.includes('目录已删除'), 'post-delete state is explicit')
  assert.ok(primary.includes('清理未完成'), 'cleanup pending is explicit')
  assert.ok(text('.gwt-rawError').includes('archive service down'), 'raw cause collapsed but accessible')
  await m.unmount()
  testSurface._reset()
})

t('remove: the branch line trims a long SHA but keeps the full value in title', async () => {
  testSurface._reset()
  const head = '0123456789abcdef0123456789abcdef01234567'
  const m = mount({ fetch: makeFetch({ worktrees: [MAIN, { ...FEAT, head }] }), sessions: TWO_IDLE })
  await m.render()
  await m.act(async () => { await flush() })
  await openRemove(m)
  assert.ok(text('.gwt-popBranch').includes('01234567'), 'short SHA shown')
  assert.ok(!text('.gwt-popBranch').includes(head), 'full SHA does not dominate the panel')
  assert.equal($('.gwt-popBranch').getAttribute('title'), head, 'full SHA available on hover')
  await m.unmount()
  testSurface._reset()
})

// ── guard: an unexpected window error must fail the suite ───────────────────

t('remove: a double-click on confirm removes the git path only once', async () => {
  testSurface._reset()
  let removeCalls = 0
  const fetch = routeFetch([
    ['/bindings', () => okRes({ bindings: FEAT_BINDINGS })],
    ['/remove', () => { removeCalls += 1; return okRes({ removed: '.dsh-wt/feat-a' }) }],
  ])
  const m = mount({ fetch, sessions: TWO_IDLE })
  await m.render()
  await m.act(async () => { await flush() })
  await openRemove(m)
  const confirm = $$('.gwt-createPop button').find((b) => b.textContent.includes('确认删除'))
  // Two clicks before React can re-render/disable the button: the synchronous
  // in-flight ref must reject the second one.
  await m.act(async () => { confirm.click(); confirm.click() })
  await m.act(async () => { await flush() })
  assert.equal(removeCalls, 1, 'the in-flight guard blocks the second click')
  await m.unmount()
  testSurface._reset()
})

t('guard: an injected window error fails an isolated child (non-zero exit)', () => {
  const guardUrl = new URL('./jsdom-guard.js', import.meta.url).href
  const script = [
    "import { createRequire } from 'node:module';",
    `import { installJsdomGuards } from ${JSON.stringify(guardUrl)};`,
    `const require = createRequire(${JSON.stringify(jsdomPath)});`,
    `const jsdom = require(${JSON.stringify(jsdomPath)});`,
    "const dom = new jsdom.JSDOM('<!doctype html><html><body></body></html>');",
    'const guards = installJsdomGuards(dom.window, null);',
    "dom.window.dispatchEvent(new dom.window.ErrorEvent('error', { error: new Error('injected boom'), message: 'injected boom' }));",
    "guards.assertClean('isolated child');",
    'process.exit(0);',
  ].join('\n')
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  assert.notEqual(child.status, 0, `guard must fail the child (stdout: ${child.stdout} stderr: ${child.stderr})`)
  assert.match(child.stderr, /isolated child: unexpected 1 error/)
})

// ── sequential runner ───────────────────────────────────────────────────────
for (const [name, fn] of tests) {
  try {
    await fn()
    guards.assertClean(`after "${name}"`)
    passed += 1
  } catch (error) {
    console.error(`✗ ${name}`)
    throw error
  }
}
console.log(`✅ client-dom: ${passed} assertions passed`)
