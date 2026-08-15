/**
 * Browser-half interaction tests in a real DOM (jsdom): mounts the actual
 * client components with react-dom/client and simulates the tree-based flows —
 * the renderless worktree sync (auto-register worktrees + 主工作树 marker +
 * stale sweep) and the `sidebar.workspaces.create` chain (repo ＋ → worktree
 * popover, worktree subfolder ＋/删除工作树, non-worktree fallback, click
 * outside).
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
const pluginRoot = new URL('..', import.meta.url).pathname

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
for (const name of ['Element', 'HTMLElement', 'Node', 'MouseEvent', 'Event', 'CustomEvent', 'getComputedStyle']) {
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

// ── mount helper ────────────────────────────────────────────────────────────
/**
 * Applies the client against a fake ctx, then mounts the two registered
 * components side by side:
 * - WorktreeSync (sidebar.footer.action) — renderless; syncs with a 1ms
 *   debounce and a long interval so tests observe one pass quickly.
 * - WorktreeCreateButton (sidebar.workspaces.create) — one row with the given
 *   `matched` share.
 *
 * `useSessions`/`useWorkspaces` mimic the framework's selector hooks over
 * static snapshots (useSessions honors the isEqual argument so content-equal
 * reselections keep a stable identity, exactly like the real store).
 */
function mount({ fetch, workspaces = [ROOT_WS], sessions = SESSIONS_SNAPSHOT, syncProps = {}, chainProps = {}, chainWrap } = {}) {
  const calls = []
  globalThis.fetch = fetch ?? makeFetch({ calls })
  const mounted = { components: {}, container: document.getElementById('root') }
  const fakeCtx = {
    slots: {
      inject: (slot, callback) => callback(),
      register: (options, component) => {
        mounted.components[options.name] = component
        return () => {}
      },
    },
    get: () => undefined,
  }
  client.apply(fakeCtx)
  const WorktreeSync = mounted.components['sidebar.footer.action']
  const CreateButton = mounted.components['sidebar.workspaces.create']
  assert.ok(WorktreeSync, 'footer sync component registered')
  assert.ok(CreateButton, 'tree create chain component registered')

  // Fake workspace runtime the sync face drives (records every call).
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
    list: (path) => client._test.api(`/dsh-git-worktree/list?repo=${encodeURIComponent(path)}`),
    create: (input) => runtime.create(input),
    rename: (id, title) => runtime.rename(id, title),
    delete: (id) => runtime.delete(id),
  }
  const wsState = { items: workspaces, phase: 'ready', state: 'idle', archivedSessionIds: [], baselinesReady: true, recentWorkspaceId: undefined, error: null }
  const useWorkspaces = (selector) => selector(wsState)
  let bumpSessions = null
  const useSessions = (selector, isEqual) => {
    const [snap, setSnap] = React.useState(sessions)
    bumpSessions = setSnap
    const last = React.useRef(undefined)
    const next = selector(snap)
    if (last.current === undefined || !(isEqual ? isEqual(next, last.current) : Object.is(next, last.current))) {
      last.current = next
    }
    return last.current
  }
  const root = createRoot(mounted.container)
  mounted.act = async (fn) => act(async () => { await fn?.() })
  mounted.render = async () => {
    await act(async () => {
      const chain = React.createElement(CreateButton, {
        group: chainProps.group ?? { workspaceId: 'w1', cwd: '/repo', label: 'repo', parentWorkspaceId: undefined },
        defaultCreate: chainProps.defaultCreate ?? (() => { mounted.defaultCreates += 1 }),
        matched: chainProps.matched ?? { workspaceId: 'w1', cwd: '/repo', label: 'repo', topLevel: true },
        useSessions,
        openBoundSession: chainProps.openBoundSession ?? (async (p) => ({ ok: true, sessionId: 's-new', path: p })),
        archiveSessions: chainProps.archiveSessions ?? (async () => {}),
        sync,
      })
      // Optional row-like wrapper around the chain component: the core tree
      // renders the chain inside a row div whose onClick toggles the group's
      // expand/collapse. Tests pass `chainWrap` (e.g. { onClick }) to verify
      // the popover never lets clicks leak to that row handler.
      const wrapped = chainWrap === undefined ? chain : React.createElement('div', chainWrap, chain)
      root.render(React.createElement(React.Fragment, null,
        React.createElement(WorktreeSync, {
          useWorkspaces,
          sync,
          debounceMs: 1,
          intervalMs: 60000,
          ...syncProps,
        }),
        wrapped,
      ))
    })
  }
  mounted.defaultCreates = 0
  mounted.calls = calls
  mounted.runtime = runtime
  mounted.unmount = async () => { await act(async () => { root.unmount() }) }
  return mounted
}

const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => [...document.querySelectorAll(sel)]
const text = (sel) => $(sel)?.textContent ?? ''

/** Type into a controlled React input (Simulate bypasses jsdom's broken input dispatch). */
const type = (input, value) => {
  Simulate.change(input, { target: { value } })
}

/** Let a 1ms debounce timer fire and the sync settle. */
const flush = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))

const basenameOf = (p) => p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? p

// ── sync: auto-detect + registration ────────────────────────────────────────

t('sync: registers worktrees as workspaces and marks the main worktree', async () => {
  client._test._reset()
  const m = mount()
  await m.render()
  await m.act(async () => { await flush() })
  // main worktree (the project folder) got the 主工作树 marker
  assert.equal(m.runtime.renamed.length, 1, 'one rename (the marker)')
  assert.equal(m.runtime.renamed[0][1], 'repo（主工作树）')
  // the linked worktree was registered
  assert.equal(m.runtime.created.length, 1, 'one workspace created')
  assert.equal(m.runtime.created[0].path, '/repo/.dsh-wt/feat-a')
  // the store knows both worktrees
  const state = client._test.worktreeStore.state
  assert.ok(state.byPath.has('/repo'), 'main worktree known')
  assert.ok(state.byPath.has('/repo/.dsh-wt/feat-a'), 'linked worktree known')
  assert.equal(state.byPath.get('/repo').primary, true)
  assert.equal(state.byPath.get('/repo/.dsh-wt/feat-a').primary, false)
  assert.deepEqual(state.roots.get('/repo'), ['/repo', '/repo/.dsh-wt/feat-a'])
  await m.unmount()
  client._test._reset()
})

t('sync: skips non-repo workspaces and does not touch their folders', async () => {
  client._test._reset()
  const m = mount({
    fetch: makeFetch({ notARepo: true }),
    workspaces: [{ workspaceId: 'w-plain', path: '/plain', title: 'plain', sessionIds: [], createdAt: '', updatedAt: '' }],
  })
  await m.render()
  await m.act(async () => { await flush() })
  assert.equal(m.runtime.created.length, 0, 'nothing registered')
  assert.equal(m.runtime.renamed.length, 0, 'nothing renamed')
  assert.equal(client._test.worktreeStore.state.byPath.size, 0)
  await m.unmount()
  client._test._reset()
})

t('sync: stale sweep unregisters a sessionless worktree that left git', async () => {
  client._test._reset()
  // Seed the auto-created registry so the sweep recognizes the folder as ours.
  client._test.saveAuto(new Set(['w2']))
  // git now lists ONLY the main worktree; feat-a's folder lingers with no sessions
  const m = mount({ fetch: makeFetch({ worktrees: [MAIN] }), workspaces: [ROOT_WS, FEAT_WS] })
  await m.render()
  await m.act(async () => { await flush() })
  assert.deepEqual(m.runtime.deleted, ['w2'], 'stale sessionless worktree unregistered')
  assert.ok(![...client._test.loadAuto()].includes('w2'), 'id dropped from the auto registry')
  await m.unmount()
  client._test._reset()
})

t('sync: keeps a stale worktree that still has sessions', async () => {
  client._test._reset()
  client._test.saveAuto(new Set(['w2']))
  const withSession = { ...FEAT_WS, sessionIds: ['s2'] }
  const m = mount({ fetch: makeFetch({ worktrees: [MAIN] }), workspaces: [ROOT_WS, withSession] })
  await m.render()
  await m.act(async () => { await flush() })
  assert.deepEqual(m.runtime.deleted, [], 'session-bearing worktree kept')
  await m.unmount()
  client._test._reset()
})

t('sync: never sweeps a folder it did not auto-create', async () => {
  client._test._reset()
  // No auto ids seeded: feat-a's registration is treated as user-created.
  const m = mount({ fetch: makeFetch({ worktrees: [MAIN] }), workspaces: [ROOT_WS, FEAT_WS] })
  await m.render()
  await m.act(async () => { await flush() })
  assert.deepEqual(m.runtime.deleted, [], 'user workspace untouched')
  await m.unmount()
  client._test._reset()
})

// ── tree chain: top-level repo folder ───────────────────────────────────────

t('tree: repo folder ＋ opens the worktree popover and creates a bound session', async () => {
  client._test._reset()
  const m = mount()
  await m.render()
  const plus = $('.gwt-rowPlus')
  assert.ok(plus, '＋ rendered on the repo row')
  assert.ok(!$('.gwt-createPop'), 'popover closed initially')
  await m.act(async () => { plus.click() })
  await m.act(async () => {})
  assert.ok($('.gwt-createPop'), 'popover opens')
  assert.ok(text('.gwt-createPop').includes('新增工作树：repo'))
  const input = $('.gwt-createInput')
  await m.act(async () => { type(input, 'new-feat') })
  let openedPath = null
  const openBoundSession = async (p) => { openedPath = p; return { ok: true, sessionId: 's-new' } }
  // re-render with the open-bound-session spy (mount default is fine too — assert via calls)
  await m.unmount()
  const m2 = mount({ chainProps: { openBoundSession } })
  await m2.render()
  await m2.act(async () => { $('.gwt-rowPlus').click() })
  await m2.act(async () => {})
  await m2.act(async () => { type($('.gwt-createInput'), 'new-feat') })
  await m2.act(async () => { $$('.gwt-createPop button').find((b) => b.textContent.includes('创建绑定会话')).click() })
  await m2.act(async () => { await flush() })
  const addCall = m2.calls.find((c) => c.url.includes('/add'))
  assert.ok(addCall, 'POST /add fired')
  assert.equal(JSON.parse(addCall.init.body).name, 'new-feat')
  assert.equal(openedPath, '/repo/.dsh-wt/new-feat', 'bound session opened at the worktree')
  await m2.act(async () => {})
  assert.ok(!$('.gwt-createPop'), 'popover closes on success')
  await m2.unmount()
  client._test._reset()
})

t('tree: worktree-only skips opening a session', async () => {
  client._test._reset()
  let opened = false
  const m = mount({ chainProps: { openBoundSession: async () => { opened = true; return { ok: true } } } })
  await m.render()
  await m.act(async () => { $('.gwt-rowPlus').click() })
  await m.act(async () => {})
  await m.act(async () => { type($('.gwt-createInput'), 'w-only') })
  await m.act(async () => { $$('.gwt-createPop button').find((b) => b.textContent.includes('仅创建工作树')).click() })
  await m.act(async () => { await flush() })
  assert.equal(opened, false, 'no session opened for worktree-only')
  assert.ok(m.calls.some((c) => c.url.includes('/add')), 'worktree created')
  await m.unmount()
  client._test._reset()
})

t('tree: session-open failure keeps the popover open with the reason', async () => {
  client._test._reset()
  const m = mount({ chainProps: { openBoundSession: async () => ({ ok: false, message: 'boom' }) } })
  await m.render()
  await m.act(async () => { $('.gwt-rowPlus').click() })
  await m.act(async () => {})
  await m.act(async () => { type($('.gwt-createInput'), 'fail') })
  await m.act(async () => { $$('.gwt-createPop button').find((b) => b.textContent.includes('创建绑定会话')).click() })
  await m.act(async () => { await flush() })
  await m.act(async () => {})
  assert.ok($('.gwt-createPop'), 'popover stays open')
  assert.ok(text('.gwt-error').includes('boom'), 'failure reason surfaced')
  await m.unmount()
  client._test._reset()
})

t('tree: create button disabled for empty name', async () => {
  client._test._reset()
  const m = mount()
  await m.render()
  await m.act(async () => { $('.gwt-rowPlus').click() })
  await m.act(async () => {})
  const createBtn = $$('.gwt-createPop button').find((b) => b.textContent.includes('创建绑定会话'))
  assert.ok(createBtn.disabled, 'create disabled while the name is empty')
  await m.act(async () => { type($('.gwt-createInput'), 'x') })
  await m.act(async () => {})
  assert.ok(!$$('.gwt-createPop button').find((b) => b.textContent.includes('创建绑定会话')).disabled, 'enabled after typing')
  await m.unmount()
  client._test._reset()
})

t('tree: a non-repo top-level folder falls back to the default create', async () => {
  client._test._reset()
  let creates = 0
  // Distinct path: the module-level repoKind cache already knows '/repo' is a
  // repo from earlier tests.
  const m = mount({
    fetch: makeFetch({ notARepo: true }),
    chainProps: {
      group: { workspaceId: 'w-plain', cwd: '/plain', label: 'plain', parentWorkspaceId: undefined },
      matched: { workspaceId: 'w-plain', cwd: '/plain', label: 'plain', topLevel: true },
      defaultCreate: () => { creates += 1 },
    },
  })
  await m.render()
  // repoKind resolves asynchronously — wait for it to settle as 'not-repo'
  await m.act(async () => { await flush() })
  await m.act(async () => { $('.gwt-rowPlus').click() })
  await m.act(async () => {})
  assert.equal(creates, 1, 'default new-session fired')
  assert.ok(!$('.gwt-createPop'), 'no worktree popover for non-repo folders')
  await m.unmount()
  client._test._reset()
})

// ── tree chain: nested worktree subfolder ───────────────────────────────────

t('tree: worktree subfolder shows ＋ and 删除工作树; delete archives + removes + unregisters', async () => {
  client._test._reset()
  // The mounted sync pass (1ms debounce) populates the store so the nested
  // row is recognized as a worktree.
  const m = mount({
    workspaces: [ROOT_WS, FEAT_WS],
    chainProps: {
      group: { workspaceId: 'w2', cwd: '/repo/.dsh-wt/feat-a', label: 'feat-a', parentWorkspaceId: 'w1' },
      matched: { workspaceId: 'w2', cwd: '/repo/.dsh-wt/feat-a', label: 'feat-a', topLevel: false },
    },
  })
  await m.render()
  // let the sync pass populate the store (1ms debounce)
  await m.act(async () => { await flush() })
  await m.act(async () => {})
  assert.ok($('.gwt-rowPlus'), 'new-session ＋ rendered')
  const removeBtn = $('.gwt-rowRemove')
  assert.ok(removeBtn, '删除工作树 button rendered')
  await m.act(async () => { removeBtn.click() })
  await m.act(async () => { await flush() })
  await m.act(async () => {})
  assert.ok($('.gwt-createPop'), 'confirm popover opens')
  assert.ok(text('.gwt-createPop').includes('删除工作树？'))
  assert.ok(text('.gwt-createPop').includes('/repo/.dsh-wt/feat-a'))
  assert.ok(text('.gwt-createPop').includes('feat-a @ bbb'), 'branch line')
  assert.ok(text('.gwt-createPop').includes('绑定会话（1）：feat-a'), 'bound sessions listed')
  const check = $('.gwt-check input')
  assert.equal(check.checked, true, 'archive pre-checked when sessions are bound')
  await m.act(async () => { $$('.gwt-createPop button').find((b) => b.textContent.includes('确认删除')).click() })
  await m.act(async () => { await flush() })
  await m.act(async () => {})
  const removeCall = m.calls.find((c) => c.url.includes('/remove'))
  assert.ok(removeCall, 'POST /remove fired')
  assert.deepEqual(JSON.parse(removeCall.init.body), { repo: '/repo', path: '/repo/.dsh-wt/feat-a' })
  assert.ok(m.runtime.deleted.includes('w2'), 'worktree workspace unregistered')
  await m.unmount()
  client._test._reset()
})

t('tree: delete with archive unchecked keeps the sessions unarchived', async () => {
  client._test._reset()
  const archived = []
  const m = mount({
    chainProps: {
      group: { workspaceId: 'w2', cwd: '/repo/.dsh-wt/feat-a', label: 'feat-a', parentWorkspaceId: 'w1' },
      matched: { workspaceId: 'w2', cwd: '/repo/.dsh-wt/feat-a', label: 'feat-a', topLevel: false },
      archiveSessions: async (ids) => { archived.push(...ids) },
    },
  })
  await m.render()
  await m.act(async () => { await flush() })
  await m.act(async () => { $('.gwt-rowRemove').click() })
  await m.act(async () => { await flush() })
  await m.act(async () => {})
  await m.act(async () => { $('.gwt-check input').click() }) // uncheck
  await m.act(async () => { $$('.gwt-createPop button').find((b) => b.textContent.includes('确认删除')).click() })
  await m.act(async () => { await flush() })
  await m.act(async () => {})
  assert.deepEqual(archived, [], 'no archive without the checkbox')
  assert.ok(m.calls.some((c) => c.url.includes('/remove')), 'worktree still removed')
  await m.unmount()
  client._test._reset()
})

t('tree: worktree with no sessions shows the note and disables archive', async () => {
  client._test._reset()
  const noSessionBindings = [
    { path: '/repo', notARepo: false, root: '/repo', worktree: { path: '/repo', branch: 'main', head: 'aaa', detached: false, primary: true } },
  ]
  const m = mount({
    fetch: makeFetch({ bindings: noSessionBindings }),
    chainProps: {
      group: { workspaceId: 'w2', cwd: '/repo/.dsh-wt/feat-a', label: 'feat-a', parentWorkspaceId: 'w1' },
      matched: { workspaceId: 'w2', cwd: '/repo/.dsh-wt/feat-a', label: 'feat-a', topLevel: false },
    },
  })
  await m.render()
  await m.act(async () => { await flush() })
  await m.act(async () => { $('.gwt-rowRemove').click() })
  await m.act(async () => { await flush() })
  await m.act(async () => {})
  assert.ok(text('.gwt-createPop').includes('无绑定会话'), 'note shown')
  assert.ok($('.gwt-check input').disabled, 'archive checkbox disabled')
  await m.unmount()
  client._test._reset()
})

t('tree: nested non-worktree folder shows only the default ＋', async () => {
  client._test._reset()
  let creates = 0
  const m = mount({
    chainProps: {
      group: { workspaceId: 'w-docs', cwd: '/repo/docs', label: 'docs', parentWorkspaceId: 'w1' },
      matched: { workspaceId: 'w-docs', cwd: '/repo/docs', label: 'docs', topLevel: false },
      defaultCreate: () => { creates += 1 },
    },
  })
  await m.render()
  await m.act(async () => { await flush() })
  await m.act(async () => {})
  assert.ok($('.gwt-rowPlus'), 'default ＋ rendered')
  assert.ok(!$('.gwt-rowRemove'), 'no delete button for a non-worktree folder')
  await m.act(async () => { $('.gwt-rowPlus').click() })
  await m.act(async () => {})
  assert.equal(creates, 1, '＋ starts a new session')
  await m.unmount()
  client._test._reset()
})

// ── popover dismissal ───────────────────────────────────────────────────────

t('tree: clicking outside closes the popover', async () => {
  client._test._reset()
  const m = mount()
  await m.render()
  await m.act(async () => { $('.gwt-rowPlus').click() })
  await m.act(async () => {})
  assert.ok($('.gwt-createPop'), 'popover open')
  await m.act(async () => {
    document.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }))
  })
  await m.act(async () => {})
  assert.ok(!$('.gwt-createPop'), 'popover closed by outside pointerdown')
  await m.unmount()
  client._test._reset()
})

// ── popover ↔ enclosing-row isolation ───────────────────────────────────────
// The chain component renders INSIDE the core tree row div, whose onClick
// toggles the group's expand/collapse. Nothing inside the popover (input,
// buttons, header, path text, checkbox) may ever bubble to that row handler,
// or the main worktree's sessions would collapse/expand while the user is
// typing or clicking in the add-worktree interface.

t('tree: clicks inside the create popover never toggle the enclosing row', async () => {
  client._test._reset()
  const rowEvents = { clicks: 0, pointerdowns: 0, mousedowns: 0 }
  const m = mount({
    chainWrap: {
      onClick: () => { rowEvents.clicks += 1 },
      onPointerDown: () => { rowEvents.pointerdowns += 1 },
      onMouseDown: () => { rowEvents.mousedowns += 1 },
    },
  })
  await m.render()
  await m.act(async () => { $('.gwt-rowPlus').click() })
  await m.act(async () => {})
  assert.ok($('.gwt-createPop'), 'popover open')
  assert.deepEqual(rowEvents, { clicks: 0, pointerdowns: 0, mousedowns: 0 }, 'opening the popover leaks nothing to the row')
  // header + input + pointer/mouse presses on popover internals
  await m.act(async () => { $('.gwt-createPop .gwt-head').click() })
  await m.act(async () => { $('.gwt-createInput').click() })
  await m.act(async () => {
    const input = $('.gwt-createInput')
    input.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }))
    input.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }))
  })
  await m.act(async () => {})
  assert.deepEqual(rowEvents, { clicks: 0, pointerdowns: 0, mousedowns: 0 }, 'interacting with popover internals leaks nothing to the row')
  assert.ok($('.gwt-createPop'), 'popover stays open')
  // the primary action button is inside the popover too
  await m.act(async () => { type($('.gwt-createInput'), 'iso') })
  await m.act(async () => { $$('.gwt-createPop button').find((b) => b.textContent.includes('仅创建工作树')).click() })
  await m.act(async () => { await flush() })
  await m.act(async () => {})
  assert.deepEqual(rowEvents, { clicks: 0, pointerdowns: 0, mousedowns: 0 }, 'create button click leaks nothing to the row')
  assert.ok(m.calls.some((c) => c.url.includes('/add')), 'worktree still created')
  // positive control: a direct click on the row wrapper (not via popover
  // internals) still reaches the row handler, proving the spy works
  await m.act(async () => { document.querySelector('#root > div').click() })
  await m.act(async () => {})
  assert.equal(rowEvents.clicks, 1, 'a bare row click still toggles (control)')
  await m.unmount()
  client._test._reset()
})

t('tree: clicks inside the delete confirm popover never toggle the enclosing row', async () => {
  client._test._reset()
  const rowEvents = { clicks: 0 }
  const m = mount({
    workspaces: [ROOT_WS, FEAT_WS],
    chainProps: {
      group: { workspaceId: 'w2', cwd: '/repo/.dsh-wt/feat-a', label: 'feat-a', parentWorkspaceId: 'w1' },
      matched: { workspaceId: 'w2', cwd: '/repo/.dsh-wt/feat-a', label: 'feat-a', topLevel: false },
    },
    chainWrap: { onClick: () => { rowEvents.clicks += 1 } },
  })
  await m.render()
  await m.act(async () => { await flush() })
  await m.act(async () => { $('.gwt-rowRemove').click() })
  await m.act(async () => { await flush() })
  await m.act(async () => {})
  assert.ok($('.gwt-createPop'), 'confirm popover open')
  assert.equal(rowEvents.clicks, 0, 'opening the confirm leaks nothing to the row')
  // checkbox toggle (inside the popover) must not leak
  await m.act(async () => { $('.gwt-check input').click() })
  await m.act(async () => {})
  assert.equal(rowEvents.clicks, 0, 'checkbox click leaks nothing to the row')
  assert.equal($('.gwt-check input').checked, false, 'checkbox itself still toggles')
  // 取消 closes the popover without touching the row
  await m.act(async () => { $$('.gwt-createPop button').find((b) => b.textContent.includes('取消')).click() })
  await m.act(async () => {})
  assert.equal(rowEvents.clicks, 0, '取消 click leaks nothing to the row')
  assert.ok(!$('.gwt-createPop'), 'popover closed by 取消')
  // positive control: a bare row click still reaches the row handler
  await m.act(async () => { document.querySelector('#root > div').click() })
  await m.act(async () => {})
  assert.equal(rowEvents.clicks, 1, 'a bare row click still toggles (control)')
  await m.unmount()
  client._test._reset()
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
