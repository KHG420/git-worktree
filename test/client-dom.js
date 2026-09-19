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
import { join } from 'node:path'

const require = createRequire(import.meta.url)

// ── resolve jsdom (optional dependency) ─────────────────────────────────────
let jsdom = null
try {
  jsdom = require('jsdom')
} catch {
  for (const candidate of [process.env.DSH_HARNESS, '/Users/aq/deepseek-harness']) {
    if (candidate && existsSync(join(candidate, 'node_modules', 'jsdom'))) {
      jsdom = createRequire(join(candidate, 'package.json'))('jsdom')
      break
    }
  }
}
if (jsdom === null) {
  console.log('⚠️  client-dom: jsdom unavailable — skipping (set DSH_HARNESS to a checkout with jsdom)')
  process.exit(0)
}

const React = require('react')
const { createRoot } = require('react-dom/client')
const { act, Simulate } = require('react-dom/test-utils')
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let passed = 0
const tests = []
const t = (name, fn) => tests.push([name, fn])

// ── DOM setup ───────────────────────────────────────────────────────────────
const dom = new jsdom.JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://127.0.0.1:3080/',
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
  assert.ok($('.gwt-check input').disabled, 'archive checkbox disabled')
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

// ── sequential runner ───────────────────────────────────────────────────────
for (const [name, fn] of tests) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    console.error(`✗ ${name}`)
    throw error
  }
}
console.log(`✅ client-dom: ${passed} assertions passed`)
