/**
 * Browser-panel interaction tests in a real DOM (jsdom): mounts the actual
 * GitWorktreePanel component with react-dom/client and simulates user
 * operations — open/close, refresh, create-bound-session, worktree-only,
 * open-bound-session, remove with/without archive confirmation, not-a-repo
 * hint, and the coalesced-refresh guard (the ERR_INSUFFICIENT_RESOURCES
 * regression).
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
const { sanitizeName } = client._test

// ── fetch stub factory ──────────────────────────────────────────────────────
const WORKTREES = [
  { path: '.', absolutePath: '/repo', branch: 'main', head: 'aaa', primary: true, current: true },
  { path: '.dsh-wt/feat-a', absolutePath: '/repo/.dsh-wt/feat-a', branch: 'feat-a', head: 'bbb', primary: false, current: false },
]
const STATUS = { branch: 'main', ahead: 0, behind: 0, clean: true, entries: [] }
const BINDINGS = [
  { path: '/repo', notARepo: false, root: '/repo', worktree: { path: '/repo', branch: 'main', head: 'aaa', detached: false, primary: true } },
  { path: '/repo/.dsh-wt/feat-a', notARepo: false, root: '/repo', worktree: { path: '/repo/.dsh-wt/feat-a', branch: 'feat-a', head: 'bbb', detached: false, primary: false } },
]

/** Build a fetch stub. `calls` records every request; `delays` can slow list. */
function makeFetch({ calls = [], delays = {}, variants = {} } = {}) {
  return async (url, init) => {
    const u = String(url)
    calls.push({ url: u, init })
    const method = init?.method ?? 'GET'
    const delay = delays[method === 'GET' && u.includes('/list?') ? 'list' : method] ?? 0
    if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    let body
    if (u.includes('/list?')) body = variants.list ?? { ok: true, data: { worktrees: WORKTREES, notARepo: false } }
    else if (u.includes('/status?')) body = variants.status ?? { ok: true, data: { ...STATUS, notARepo: false } }
    else if (u.includes('/bindings')) body = variants.bindings ?? { ok: true, data: { bindings: BINDINGS } }
    else if (u.includes('/add')) body = variants.add ?? { ok: true, data: { path: '.dsh-wt/new-feat', absolutePath: '/repo/.dsh-wt/new-feat', branch: 'new-feat' } }
    else if (u.includes('/remove')) body = variants.remove ?? { ok: true, data: { removed: '.dsh-wt/feat-a' } }
    else body = { ok: false, error: { message: `unexpected route ${u}` } }
    return { ok: body.ok, status: body.ok ? 200 : 400, json: async () => body }
  }
}

// ── mount helper ────────────────────────────────────────────────────────────
function mount({ fetch, snapshot: snapOverride, openBoundSession, archiveSessions, pickDirectory } = {}) {
  const calls = []
  globalThis.fetch = fetch ?? makeFetch({ calls })
  const mounted = { component: null, container: document.getElementById('root') }
  const fakeCtx = {
    slots: {
      inject: (slot, callback) => callback(),
      register: (options, component) => {
        mounted.component = component
        return () => {}
      },
    },
    get: () => undefined,
  }
  client.apply(fakeCtx)
  // useSessions: mimics useSyncExternalStoreWithSelector over a static
  // snapshot — the selector result is cached and only replaced when isEqual
  // says the content changed (a fresh array identity every render would
  // re-fire the panel's refresh effect forever).
  let bumpSessions = null
  const useSessions = (selector, isEqual) => {
    const [snap, setSnap] = React.useState(snapshot)
    bumpSessions = setSnap
    const last = React.useRef(undefined)
    const next = selector(snap)
    if (last.current === undefined || !(isEqual ? isEqual(next, last.current) : Object.is(next, last.current))) {
      last.current = next
    }
    return last.current
  }
  // simulate the sessions store notifying (the panel re-fires its refresh
  // effect only when the binding-relevant content actually changed).
  mounted.bumpSessions = (next) => act(async () => { bumpSessions(next) })
  const root = createRoot(mounted.container)
  mounted.act = async (fn) => act(async () => { await fn?.(); })
  mounted.render = async () => {
    await act(async () => {
      root.render(React.createElement(mounted.component, {
        wide: true,
        useSessions,
        openBoundSession: openBoundSession ?? (async (p) => ({ ok: true, sessionId: 's-new', path: p })),
        archiveSessions: archiveSessions ?? (async () => {}),
        // Default: the OS chooser is "cancelled", so a badge click falls back
        // to the plain open/close toggle — the pre-picker behavior.
        pickDirectory: pickDirectory ?? (async () => null),
      }))
    })
  }
  mounted.calls = calls
  mounted.unmount = async () => { await act(async () => { root.unmount() }) }
  return mounted
}

const snapshot = {
  ids: ['s1', 's2'],
  byId: {
    s1: { id: 's1', cwd: '/repo', displayTitle: 'main', origin: 'user', blank: false, running: false },
    s2: { id: 's2', cwd: '/repo/.dsh-wt/feat-a', displayTitle: 'feat-a', origin: 'user', blank: false, running: false },
  },
  current: 's1',
}

const $ = (sel) => document.querySelector(sel)
const text = (sel) => $(sel)?.textContent ?? ''

/** Type into a controlled React input. Simulate bypasses the DOM dispatch
 * path that jsdom mishandles for input events (React 18 falls back to the IE
 * polyfill and crashes); Simulate.change drives the synthetic event directly. */
const type = (input, value) => {
  Simulate.change(input, { target: { value } })
}

// ── scenarios ───────────────────────────────────────────────────────────────

t('panel: opens on badge click, refreshes once, renders worktrees + bindings', async () => {
  const m = mount()
  await m.render()
  assert.ok($('.gwt-badge'), 'badge rendered')
  assert.ok(!$('.gwt-panel'), 'panel closed by default')
  assert.ok(text('.gwt-badge').includes('Bindings'))
  await m.act(async () => { $('.gwt-badge').click() })
  await m.act(async () => {})
  await m.act(async () => {})
  assert.ok($('.gwt-panel'), 'panel opens')
  // one refresh trio fired: list + status + bindings
  const trio = m.calls.filter((c) => c.url.includes('/dsh-git-worktree/'))
  assert.equal(trio.filter((c) => c.url.includes('/list?')).length, 1)
  assert.equal(trio.filter((c) => c.url.includes('/status?')).length, 1)
  assert.equal(trio.filter((c) => c.url.includes('/bindings')).length, 1)
  assert.ok(text('.gwt-status').includes('branch main'), 'status line')
  const rows = document.querySelectorAll('.gwt-row')
  assert.equal(rows.length, 2, 'two worktree rows')
  assert.ok(text('.gwt-row').includes('primary'), 'primary tag')
  assert.ok(text('.gwt-panel').includes('1 会话绑定'), 'bound count tag')
  assert.ok(text('.gwt-panel').includes('feat-a'), 'bound session title shown')
  assert.ok(text('.gwt-panel').includes('当前会话'), 'current-session tag')
  await m.unmount()
})

t('panel: badge click picks a folder → repo input set, panel opens on it', async () => {
  const calls = []
  const m = mount({ fetch: makeFetch({ calls }), pickDirectory: async () => '/picked/repo' })
  await m.render()
  await m.act(async () => { $('.gwt-badge').click() })
  await m.act(async () => {})
  await m.act(async () => {})
  assert.ok($('.gwt-panel'), 'panel opens after picking a folder')
  assert.equal($('.gwt-repo').value, '/picked/repo', 'repo input holds the picked path')
  const listCalls = calls.filter((c) => c.url.includes('/list?'))
  assert.ok(listCalls.length >= 1, 'refresh fired for the picked repo')
  assert.ok(listCalls.at(-1).url.includes(encodeURIComponent('/picked/repo')), 'refresh targets the picked repo')
  await m.unmount()
})

t('panel: picking while open updates the repo and refreshes in place', async () => {
  const calls = []
  let pickCount = 0
  const m = mount({
    fetch: makeFetch({ calls }),
    pickDirectory: async () => { pickCount += 1; return pickCount === 1 ? null : '/new/repo' },
  })
  await m.render()
  // first click: the chooser is cancelled → plain toggle opens the panel
  await m.act(async () => { $('.gwt-badge').click() })
  await m.act(async () => {})
  await m.act(async () => {})
  assert.ok($('.gwt-panel'), 'panel open after a cancelled pick')
  const before = calls.filter((c) => c.url.includes('/list?')).length
  // second click: a folder is picked → repo updates, refresh in place
  await m.act(async () => { $('.gwt-badge').click() })
  await m.act(async () => {})
  await m.act(async () => {})
  assert.ok($('.gwt-panel'), 'panel stays open after re-picking')
  assert.equal($('.gwt-repo').value, '/new/repo', 'repo input updated to the picked path')
  const listCalls = calls.filter((c) => c.url.includes('/list?'))
  assert.ok(listCalls.length > before, 'a refresh fired for the new repo')
  assert.ok(listCalls.at(-1).url.includes(encodeURIComponent('/new/repo')), 'refresh targets the newly picked repo')
  await m.unmount()
})

t('panel: picker failure falls back to the toggle without breaking the panel', async () => {
  const m = mount({ pickDirectory: async () => { throw new Error('native picker unavailable') } })
  await m.render()
  await m.act(async () => { $('.gwt-badge').click() })
  await m.act(async () => {})
  await m.act(async () => {})
  assert.ok($('.gwt-panel'), 'panel toggles open even when the picker fails')
  assert.ok(text('.gwt-status').includes('branch main'), 'normal refresh still rendered')
  await m.unmount()
})

t('panel: open bound session button calls the inject face', async () => {
  const opened = []
  const m = mount({ openBoundSession: async (p) => { opened.push(p); return { ok: true, sessionId: 's-new' } } })
  await m.render()
  await m.act(async () => { $('.gwt-badge').click() })
  await m.act(async () => {})
  await m.act(async () => {})
  const buttons = [...document.querySelectorAll('button')].filter((b) => b.textContent.includes('打开绑定会话'))
  assert.equal(buttons.length, 1, 'one open button (non-primary row)')
  await m.act(async () => { buttons[0].click() })
  await m.act(async () => {})
  assert.deepEqual(opened, ['/repo/.dsh-wt/feat-a'])
  await m.unmount()
})

t('panel: create bound session sanitizes the name, opens the session, clears input', async () => {
  const adds = []
  const opened = []
  const m = mount({
    openBoundSession: async (p) => { opened.push(p); return { ok: true, sessionId: 's-new' } },
  })
  m.calls.splice(0) // ignore the open-refresh calls
  await m.render()
  await m.act(async () => { $('.gwt-badge').click() })
  await m.act(async () => {})
  await m.act(async () => {})
  await m.act(async () => {
    type($('.gwt-createInput'), 'new feature/x')
  })
  await m.act(async () => { $('.gwt-btnPrimary').click() })
  await m.act(async () => {})
  await m.act(async () => {})
  const addCall = m.calls.find((c) => c.url.includes('/add'))
  assert.ok(addCall, 'add POST fired')
  const payload = JSON.parse(addCall.init.body)
  assert.equal(payload.name, sanitizeName('new feature/x'), 'name sanitized before POST')
  assert.equal(payload.unique, true)
  assert.deepEqual(opened, ['/repo/.dsh-wt/new-feat'], 'session opened at the created worktree')
  assert.ok(text('.gwt-created').includes('已创建'), 'created notice rendered')
  assert.ok(text('.gwt-created').includes('已打开绑定会话'), 'opened notice rendered')
  assert.equal($('.gwt-createInput').value, '', 'input cleared')
  await m.unmount()
})

t('panel: worktree-only skips opening a session', async () => {
  const opened = []
  const m = mount({ openBoundSession: async (p) => { opened.push(p); return { ok: true } } })
  await m.render()
  await m.act(async () => { $('.gwt-badge').click() })
  await m.act(async () => {})
  await m.act(async () => {})
  await m.act(async () => {
    type($('.gwt-createInput'), 'just-wt')
  })
  const buttons = [...document.querySelectorAll('button')]
  const only = buttons.find((b) => b.textContent.includes('仅创建工作树'))
  await m.act(async () => { only.click() })
  await m.act(async () => {})
  await m.act(async () => {})
  const addCall = m.calls.find((c) => c.url.includes('/add'))
  assert.ok(addCall, 'add POST fired')
  assert.equal(JSON.parse(addCall.init.body).name, 'just-wt')
  assert.deepEqual(opened, [], 'no session opened for worktree-only')
  await m.unmount()
})

t('panel: remove with bound sessions shows confirm; unchecked archive skips archiving', async () => {
  const archived = []
  const removed = []
  const m = mount({
    archiveSessions: async (ids) => { archived.push(...ids) },
  })
  await m.render()
  await m.act(async () => { $('.gwt-badge').click() })
  await m.act(async () => {})
  await m.act(async () => {})
  const removeBtn = [...document.querySelectorAll('button')].find((b) => b.textContent === '删除')
  await m.act(async () => { removeBtn.click() })
  await m.act(async () => {})
  assert.ok($('.gwt-confirm'), 'confirm dialog shown')
  assert.ok(text('.gwt-confirm').includes('feat-a'), 'bound sessions listed')
  // uncheck the archive box
  await m.act(async () => {
    Simulate.change($('.gwt-check input'), { target: { checked: false } })
  })
  await m.act(async () => { $('.gwt-btnDanger').click() })
  await m.act(async () => {})
  await m.act(async () => {})
  assert.deepEqual(archived, [], 'no archiving when unchecked')
  const removeCall = m.calls.find((c) => c.url.includes('/remove'))
  assert.ok(removeCall, 'remove POST fired')
  assert.equal(JSON.parse(removeCall.init.body).path, '/repo/.dsh-wt/feat-a')
  assert.ok(!$('.gwt-confirm'), 'confirm dismissed after removal')
  await m.unmount()
})

t('panel: remove with archive checked archives the bound sessions', async () => {
  const archived = []
  const m = mount({ archiveSessions: async (ids) => { archived.push(...ids) } })
  await m.render()
  await m.act(async () => { $('.gwt-badge').click() })
  await m.act(async () => {})
  await m.act(async () => {})
  const removeBtn = [...document.querySelectorAll('button')].find((b) => b.textContent === '删除')
  await m.act(async () => { removeBtn.click() })
  await m.act(async () => {})
  assert.ok($('.gwt-check input').checked, 'archive defaults to checked')
  await m.act(async () => { $('.gwt-btnDanger').click() })
  await m.act(async () => {})
  await m.act(async () => {})
  assert.deepEqual(archived, ['s2'], 'bound session archived before removal')
  await m.unmount()
})

t('panel: remove without bound sessions skips the confirm', async () => {
  // a worktree row with no bound sessions
  const calls = []
  const fetch = makeFetch({
    calls,
    variants: {
      list: { ok: true, data: { worktrees: [WORKTREES[0], { ...WORKTREES[1], path: '.dsh-wt/empty', absolutePath: '/repo/.dsh-wt/empty', branch: 'empty' }], notARepo: false } },
      bindings: { ok: true, data: { bindings: [BINDINGS[0]] } },
    },
  })
  const m = mount({ fetch })
  await m.render()
  await m.act(async () => { $('.gwt-badge').click() })
  await m.act(async () => {})
  await m.act(async () => {})
  const rows = [...document.querySelectorAll('.gwt-row')]
  const emptyRow = rows.find((r) => r.textContent.includes('empty'))
  const removeBtn = [...emptyRow.querySelectorAll('button')].find((b) => b.textContent === '删除')
  await m.act(async () => { removeBtn.click() })
  await m.act(async () => {})
  await m.act(async () => {})
  assert.ok(!$('.gwt-confirm'), 'no confirm for an unbound worktree')
  assert.ok(calls.some((c) => c.url.includes('/remove')), 'remove POST fired immediately')
  await m.unmount()
})

t('panel: click outside closes the panel', async () => {
  const m = mount()
  await m.render()
  await m.act(async () => { $('.gwt-badge').click() })
  await m.act(async () => {})
  assert.ok($('.gwt-panel'), 'panel open')
  await m.act(async () => {
    document.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }))
  })
  await m.act(async () => {})
  assert.ok(!$('.gwt-panel'), 'panel closed on outside click')
  await m.unmount()
})

t('panel: not-a-repo input shows the hint', async () => {
  const fetch = makeFetch({
    variants: {
      list: { ok: true, data: { worktrees: [], notARepo: true } },
      status: { ok: true, data: { notARepo: true, root: null, branch: null, ahead: 0, behind: 0, clean: true, entries: [] } },
    },
  })
  const m = mount({ fetch })
  await m.render()
  await m.act(async () => { $('.gwt-badge').click() })
  await m.act(async () => {})
  await m.act(async () => {})
  // point the input at a non-repo and refresh
  await m.act(async () => {
    type($('.gwt-repo'), '/not/a/repo')
  })
  await m.act(async () => { $('.gwt-btn').click() }) // 刷新
  await m.act(async () => {})
  await m.act(async () => {})
  assert.ok(text('.gwt-note').includes('不是 git repo'), 'not-a-repo hint rendered')
  await m.unmount()
})

t('panel: fetch failure renders the error and clears the worktree list', async () => {
  const fetch = async (url) => {
    if (String(url).includes('/list?')) throw new Error('network down')
    return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) }
  }
  const m = mount({ fetch })
  await m.render()
  await m.act(async () => { $('.gwt-badge').click() })
  await m.act(async () => {})
  await m.act(async () => {})
  assert.ok(text('.gwt-error').includes('network down'), 'error message rendered')
  assert.ok(text('.gwt-rows').includes('暂无'), 'empty-list note shown after the failure')
  assert.ok(!text('.gwt-status').includes('branch main'), 'stale status cleared')
  await m.unmount()
})

t('panel: busy state disables the create/open buttons while a refresh is in flight', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  let listCount = 0
  const fetch = async (url) => {
    const u = String(url)
    let body
    if (u.includes('/list?')) {
      listCount += 1
      if (listCount > 1) await gate // gate only the second (manual) refresh
      body = { ok: true, data: { worktrees: WORKTREES, notARepo: false } }
    } else if (u.includes('/status?')) body = { ok: true, data: { ...STATUS, notARepo: false } }
    else if (u.includes('/bindings')) body = { ok: true, data: { bindings: BINDINGS } }
    else body = { ok: true, data: {} }
    return { ok: true, status: 200, json: async () => body }
  }
  const m = mount({ fetch })
  await m.render()
  await m.act(async () => { $('.gwt-badge').click() })
  await m.act(async () => {})
  await m.act(async () => {})
  await m.act(async () => { type($('.gwt-createInput'), 'busy-name') })
  await m.act(async () => {})
  assert.ok(!$('.gwt-btnPrimary').disabled, 'create enabled once a name is typed')
  // manual refresh is now gated → busy stays true until released
  await m.act(async () => { $('.gwt-btn').click() }) // 刷新
  await new Promise((r) => setTimeout(r, 30))
  await m.act(async () => {})
  assert.ok($('.gwt-btnPrimary').disabled, 'create-bound disabled while busy')
  assert.ok([...document.querySelectorAll('button')].find((b) => b.textContent.includes('仅创建工作树')).disabled, 'worktree-only disabled while busy')
  assert.ok(text('.gwt-btn').includes('…'), 'refresh shows the busy ellipsis')
  release()
  await m.act(async () => {})
  await m.act(async () => {})
  assert.ok(!$('.gwt-btnPrimary').disabled, 'buttons re-enabled after the refresh settles')
  await m.unmount()
})

t('panel: switching the repo input and refreshing targets the new repo', async () => {
  const calls = []
  const m = mount({ fetch: makeFetch({ calls }) })
  await m.render()
  await m.act(async () => { $('.gwt-badge').click() })
  await m.act(async () => {})
  await m.act(async () => {})
  await m.act(async () => { type($('.gwt-repo'), '/other/repo') })
  await m.act(async () => { $('.gwt-btn').click() }) // 刷新
  await m.act(async () => {})
  await m.act(async () => {})
  const listCalls = calls.filter((c) => c.url.includes('/list?'))
  assert.ok(listCalls.length >= 2, 'a second refresh fired')
  assert.ok(listCalls.at(-1).url.includes(encodeURIComponent('/other/repo')), 'refresh targets the new repo')
  await m.unmount()
})

t('panel: created notice reports a failed session open (opened:false)', async () => {
  const m = mount({
    openBoundSession: async () => ({ ok: false, message: 'workspace full' }),
  })
  await m.render()
  await m.act(async () => { $('.gwt-badge').click() })
  await m.act(async () => {})
  await m.act(async () => {})
  await m.act(async () => { type($('.gwt-createInput'), 'fail-open') })
  await m.act(async () => { $('.gwt-btnPrimary').click() })
  await m.act(async () => {})
  await m.act(async () => {})
  assert.ok(text('.gwt-created').includes('会话打开失败'), 'failure notice rendered in the created box')
  assert.ok(text('.gwt-error').includes('workspace full'), 'failure reason shown in the error line')
  await m.unmount()
})

t('panel: create button disabled for empty name or repo', async () => {
  const m = mount()
  await m.render()
  await m.act(async () => { $('.gwt-badge').click() })
  await m.act(async () => {})
  await m.act(async () => {})
  const create = $('.gwt-btnPrimary')
  assert.ok(create.disabled, 'create disabled with empty name')
  await m.act(async () => {
    type($('.gwt-createInput'), '   ')
  })
  await m.act(async () => {})
  assert.ok($('.gwt-btnPrimary').disabled, 'whitespace-only name still disabled')
  await m.unmount()
})

t('panel: refreshes coalesce — at most one request trio in flight', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const calls = []
  const fetch = async (url, init) => {
    calls.push(String(url))
    const u = String(url)
    let body
    if (u.includes('/list?')) {
      await gate // hold the FIRST list open to force overlap
      body = { ok: true, data: { worktrees: WORKTREES, notARepo: false } }
    } else if (u.includes('/status?')) body = { ok: true, data: { ...STATUS, notARepo: false } }
    else if (u.includes('/bindings')) body = { ok: true, data: { bindings: BINDINGS } }
    else body = { ok: true, data: {} }
    return { ok: true, status: 200, json: async () => body }
  }
  const m = mount({ fetch })
  await m.render()
  await m.act(async () => { $('.gwt-badge').click() })
  // while the first trio is in flight, simulate session churn: two store
  // notifications whose binding-relevant content actually moves (running flag)
  await m.bumpSessions({ ...snapshot, byId: { ...snapshot.byId, s1: { ...snapshot.byId.s1, running: true } } })
  await m.bumpSessions(snapshot)
  await new Promise((r) => setTimeout(r, 50))
  const inFlightLists = calls.filter((c) => c.includes('/list?')).length
  assert.equal(inFlightLists, 1, 'only one list request in flight during the storm')
  release()
  await m.act(async () => {})
  await m.act(async () => {})
  await m.act(async () => {})
  const totalLists = calls.filter((c) => c.includes('/list?')).length
  assert.equal(totalLists, 2, 'extra refreshes folded into a single trailing re-run')
  await m.unmount()
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
