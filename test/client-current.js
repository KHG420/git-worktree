/**
 * Regression tests for the "current DSH" compatibility fix:
 *
 *  1. missing-slot runtime — the client requests only the slots that exist in
 *     0.1.5-rc.2 (`sidebar.footer.action`) and never the removed
 *     `sidebar.workspaces.create` chain;
 *  2. service wiring — the bound-session flow goes through the ui-workspace
 *     service (`uiWorkspace.connectWorkspace`/`openSession`/`archiveSession`),
 *     not `workspaces`;
 *  3. UI lifecycle — the row DOM integration injects, is idempotent, survives
 *     mutations, and fully restores the stock controls on stop;
 *  4. resolution — duplicate labels resolve to the explicit chooser, never a
 *     guessed repository.
 *
 * jsdom is resolved like test/client-dom.js (optional dependency).
 *
 * Run: node test/client-current.js
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

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
  console.log('⚠️  client-current: jsdom unavailable — skipping (set DSH_HARNESS to a checkout with jsdom)')
  process.exit(0)
}

const dom = new jsdom.JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://127.0.0.1:3080/',
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
for (const name of ['Element', 'HTMLElement', 'Node', 'MouseEvent', 'Event', 'MutationObserver']) {
  if (window[name] !== undefined) globalThis[name] = window[name]
}

// The bundle requires only react/react/jsx-runtime.
const React = require('react')
const jsxRuntime = require('react/jsx-runtime')
let captured = null
window.__ModuleLoader__ = { load: (entry) => { captured = entry } }
await import(pathToFileURL(require.resolve('../client.js')))
const moduleExports = captured.factory((spec) => {
  if (spec === 'react') return React
  if (spec === 'react/jsx-runtime') return jsxRuntime
  throw new Error(`unexpected require: ${spec}`)
})

let passed = 0
const tests = []
const t = (name, fn) => tests.push([name, fn])

// ── 1. missing-slot runtime ─────────────────────────────────────────────────

t('apply: only requests existing 0.1.5-rc.2 slots (no removed create chain)', () => {
  const injections = []
  const registrations = []
  const ctx = {
    slots: {
      inject: (slot, callback) => injections.push({ slot, callback }),
      register: (options, component) => { registrations.push({ ...options, component }); return () => {} },
    },
    get: () => undefined,
  }
  moduleExports.apply(ctx)
  assert.deepEqual(
    injections.map((entry) => entry.slot),
    ['sidebar.footer.action'],
    'only the footer list slot is requested',
  )
  assert.ok(!injections.some((entry) => String(entry.slot).includes('sidebar.workspaces.create')), 'removed chain never requested')
  for (const injection of injections) injection.callback()
  assert.deepEqual(registrations.map((entry) => entry.name), ['sidebar.footer.action'])
  assert.equal(registrations[0].id, 'git-worktree-sync')
  assert.equal(typeof registrations[0].component, 'function')
})

// ── 2. service wiring ───────────────────────────────────────────────────────

t('apply: bound sessions go through uiWorkspace, not workspaces', async () => {
  const calls = []
  const services = {
    workspaces: {
      create: async (input) => {
        calls.push(['workspaces.create', input.path])
        return { workspaceId: 'w-new', path: input.path, title: 'new', sessionIds: [], createdAt: '', updatedAt: '' }
      },
      rename: () => {},
      delete: async (id) => { calls.push(['workspaces.delete', id]) },
      connectWorkspace: async () => { throw new Error('workspaces.connectWorkspace must not be used') },
      archiveSession: async () => { throw new Error('workspaces.archiveSession must not be used') },
    },
    uiWorkspace: {
      connectWorkspace: async (id) => { calls.push(['uiWorkspace.connectWorkspace', id]); return 's-click' },
      openSession: (id) => { calls.push(['uiWorkspace.openSession', id]) },
      archiveSession: async (id) => { calls.push(['uiWorkspace.archiveSession', id]) },
    },
  }
  let registration = null
  const ctx = {
    slots: {
      inject: (slot, callback) => callback(),
      register: (options) => { registration = options; return () => {} },
    },
    get: (key) => services[key],
  }
  moduleExports.apply(ctx)
  const face = registration.inject()

  const opened = await face.openBoundSession('/repo/.dsh-wt/feature')
  assert.deepEqual(opened, { ok: true, sessionId: 's-click' })
  assert.deepEqual(calls, [
    ['workspaces.create', '/repo/.dsh-wt/feature'],
    ['uiWorkspace.connectWorkspace', 'w-new'],
    ['uiWorkspace.openSession', 's-click'],
  ], 'open flow routes through the ui-workspace service')

  calls.length = 0
  await face.archiveSessions(['s1', 's2'])
  assert.deepEqual(calls, [['uiWorkspace.archiveSession', 's1'], ['uiWorkspace.archiveSession', 's2']])

  calls.length = 0
  await face.sync.delete('w9')
  assert.deepEqual(calls, [['workspaces.delete', 'w9']], 'sync mutations stay on the workspaces service')
})

// ── 3. resolution primitives ────────────────────────────────────────────────

const rowHtml = (title, buttons = 2) => {
  // Mirror the core Menu shape: the ellipsis anchor sits inside its own span.
  const stock = buttons >= 2
    ? '<span class="menuRoot"><button aria-label="ellipsis"></button></span><button aria-label="plus"></button>'
    : '<button aria-label="plus"></button>'
  return '<div role="treeitem" aria-expanded="true">'
    + '<span class="slot"></span><span class="slot"></span>'
    + `<span class="projectText"><span class="title">${title}</span></span>`
    + `<span class="rowActions">${stock}</span>`
    + '</div>'
}
const treeWith = (rows) => {
  const host = document.createElement('div')
  host.innerHTML = `<div role="tree">${rows.map((r) => rowHtml(r.title, r.buttons ?? 2)).join('')}</div>`
  document.body.appendChild(host)
  return host
}

const { resolveRow, rowTitleOf, createRowIntegration } = moduleExports._test
const byPathOf = (entries) => new Map(entries.map(([path, primary]) => [path, { branch: 'main', head: 'h', primary, repoRoot: path }]))

t('resolveRow: primary→create, linked→remove, non-worktree→null, duplicate→chooser', () => {
  const host = treeWith([{ title: 'repo' }, { title: 'feat' }, { title: 'docs' }, { title: 'dup' }])
  const [repoRow, featRow, docsRow, dupRow] = [...host.querySelectorAll('[role="treeitem"]')]
  assert.equal(rowTitleOf(repoRow), 'repo')
  const items = [
    { workspaceId: 'w1', path: '/repo', title: 'repo' },
    { workspaceId: 'w2', path: '/repo/.dsh-wt/feat', title: 'feat' },
    { workspaceId: 'w3', path: '/repo/docs', title: 'docs' },
    { workspaceId: 'wa', path: '/a/dup', title: 'dup' },
    { workspaceId: 'wb', path: '/b/dup', title: 'dup' },
  ]
  const byPath = byPathOf([['/repo', true], ['/repo/.dsh-wt/feat', false], ['/a/dup', true], ['/b/dup', true]])
  assert.equal(resolveRow(repoRow, items, byPath).kind, 'create')
  assert.equal(resolveRow(featRow, items, byPath).kind, 'remove')
  assert.equal(resolveRow(docsRow, items, byPath), null, 'a nested non-worktree folder has no repo affordance')
  const ambiguous = resolveRow(dupRow, items, byPath)
  assert.equal(ambiguous.kind, 'ambiguous')
  assert.equal(ambiguous.candidates.length, 2)
  host.remove()
})

t('integration: injects, is idempotent, repairs mutations, and restores on stop', () => {
  const host = treeWith([{ title: 'repo' }, { title: 'feat' }])
  const items = [
    { workspaceId: 'w1', path: '/repo', title: 'repo' },
    { workspaceId: 'w2', path: '/repo/.dsh-wt/feat', title: 'feat' },
  ]
  const actions = []
  const manager = createRowIntegration({
    doc: document,
    readItems: () => items,
    readWorktreeState: () => ({ byPath: byPathOf([['/repo', true], ['/repo/.dsh-wt/feat', false]]) }),
    onAction: (action) => actions.push(action),
  })
  manager.start()
  const [repoRow, featRow] = [...host.querySelectorAll('[role="treeitem"]')]
  assert.equal(repoRow.querySelectorAll('[data-gwt-control="create"]').length, 1)
  assert.equal(featRow.querySelectorAll('[data-gwt-control="remove"]').length, 1)
  assert.ok(repoRow.querySelector('[data-gwt-stock-hidden]'), 'stock ＋ hidden on the repo row')
  assert.equal(featRow.querySelector('[data-gwt-stock-hidden]'), null, 'stock ＋ kept on the linked row')
  // Idempotent: repeated scans never duplicate controls.
  for (let i = 0; i < 5; i++) manager.scan()
  assert.equal(repoRow.querySelectorAll('[data-gwt-control]').length, 1)
  assert.equal(featRow.querySelectorAll('[data-gwt-control]').length, 1)
  // A simulated React rerender that recreates the stock ＋ is repaired.
  repoRow.querySelector('.rowActions').innerHTML = '<button aria-label="ellipsis"></button><button aria-label="plus"></button>'
  assert.equal(repoRow.querySelector('[data-gwt-stock-hidden]'), null, 'fresh stock ＋ is unmarked')
  manager.scan()
  assert.equal(repoRow.querySelectorAll('[data-gwt-control="create"]').length, 1, 'control re-injected exactly once')
  assert.ok(repoRow.querySelector('[data-gwt-stock-hidden]'), 'stock ＋ re-hidden')
  // The action carries the resolved workspace + anchor.
  repoRow.querySelector('[data-gwt-control="create"]').click()
  assert.equal(actions.length, 1)
  assert.equal(actions[0].kind, 'create')
  assert.equal(actions[0].candidates[0].workspace.workspaceId, 'w1')
  // stop() disposes the observer and restores every stock control.
  manager.stop()
  assert.equal(host.querySelector('[data-gwt-control]'), null, 'controls removed')
  assert.equal(host.querySelector('[data-gwt-stock-hidden]'), null, 'stock controls restored')
  assert.equal(host.querySelector('[data-gwt-resolved]'), null, 'markers removed')
  host.remove()
})

t('integration: a duplicate-label row never gets an implicit create/remove control', () => {
  const host = treeWith([{ title: 'dup' }])
  const items = [
    { workspaceId: 'wa', path: '/a/dup', title: 'dup' },
    { workspaceId: 'wb', path: '/b/dup', title: 'dup' },
  ]
  const manager = createRowIntegration({
    doc: document,
    readItems: () => items,
    readWorktreeState: () => ({ byPath: byPathOf([['/a/dup', true], ['/b/dup', true]]) }),
    onAction: () => {},
  })
  manager.start()
  const row = host.querySelector('[role="treeitem"]')
  assert.equal(row.querySelector('[data-gwt-control="create"]'), null)
  assert.equal(row.querySelector('[data-gwt-control="remove"]'), null)
  assert.ok(row.querySelector('[data-gwt-control="ambiguous"]'), 'explicit chooser control only')
  manager.stop()
  host.remove()
})

t('integration: an ungrouped pseudo-row (lone ＋) is left untouched', () => {
  const host = treeWith([{ title: '未分组', buttons: 1 }])
  const manager = createRowIntegration({
    doc: document,
    readItems: () => [{ workspaceId: 'w1', path: '/repo', title: '未分组' }],
    readWorktreeState: () => ({ byPath: byPathOf([['/repo', true]]) }),
    onAction: () => {},
  })
  manager.start()
  assert.equal(host.querySelector('[data-gwt-control]'), null, 'no control on the ungrouped bucket')
  manager.stop()
  host.remove()
})

t('integration: resolving a duplicate row hides the real native ＋ (not the plugin control)', () => {
  const host = treeWith([{ title: 'same' }])
  const a = { workspaceId: 'a', path: '/a', title: 'same' }
  const b = { workspaceId: 'b', path: '/b', title: 'same' }
  let items = [a, b]
  const manager = createRowIntegration({
    doc: document,
    readItems: () => items,
    readWorktreeState: () => ({ byPath: byPathOf([['/a', true], ['/b', true]]) }),
    onAction: () => {},
  })
  manager.start()
  const row = host.querySelector('[role="treeitem"]')
  assert.equal(row.querySelectorAll('[data-gwt-control="ambiguous"]').length, 1)
  // The row transitions to a single primary repository: the stale chooser is
  // replaced by the create control and the REAL stock ＋ is hidden.
  items = [a]
  manager.scan()
  assert.equal(row.querySelector('[data-gwt-control="ambiguous"]'), null, 'stale chooser removed')
  assert.equal(row.querySelectorAll('[data-gwt-control="create"]').length, 1)
  const nativePlus = row.querySelector('.rowActions button[aria-label="plus"]')
  assert.equal(nativePlus.style.display, 'none', 'the actual native ＋ is hidden')
  assert.equal(nativePlus.getAttribute('data-gwt-stock-hidden'), '1')
  manager.stop()
  host.remove()
})

t('integration: retargeting the delete popover never reuses the previous target state', async () => {
  moduleExports._test._reset()
  const ReactDOMClient = require('react-dom/client')
  const a = { workspaceId: 'a', path: '/repo/a', title: 'a' }
  const b = { workspaceId: 'b', path: '/repo/b', title: 'b' }
  const host = treeWith([{ title: 'a' }, { title: 'b' }])
  let Component = null
  moduleExports.apply({
    slots: {
      inject: (_slot, callback) => callback(),
      register: (_options, component) => { Component = component; return () => {} },
    },
    get: () => ({}),
  })
  assert.equal(typeof Component, 'function', 'component captured from the registration')
  const sessions = {
    ids: ['sa', 'sb'],
    byId: {
      sa: { id: 'sa', cwd: a.path, displayTitle: 'SESSION_A', origin: 'user' },
      sb: { id: 'sb', cwd: b.path, displayTitle: 'SESSION_B', origin: 'user' },
    },
  }
  moduleExports._test.worktreeStore.publish(
    new Map([[a.path, { primary: false, repoRoot: '/repo' }], [b.path, { primary: false, repoRoot: '/repo' }]]),
    new Map(),
  )
  let fetchCount = 0
  const realFetch = globalThis.fetch
  const realActEnv = globalThis.IS_REACT_ACT_ENVIRONMENT
  globalThis.fetch = async () => {
    if (++fetchCount > 1) return new Promise(() => {})
    return {
      ok: true,
      json: async () => ({ ok: true, data: { bindings: [
        { path: a.path, worktree: { path: a.path } },
        { path: b.path, worktree: { path: b.path } },
      ] } }),
    }
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const root = ReactDOMClient.createRoot(document.getElementById('root'))
  try {
    await React.act(async () => {
      root.render(React.createElement(Component, {
        useWorkspaces: (selector) => selector({ items: [a, b], phase: 'ready' }),
        useSessions: (selector) => React.useMemo(() => selector(sessions), []),
        sync: {},
        debounceMs: 60000,
        intervalMs: 60000,
      }))
    })
    const buttons = document.querySelectorAll('.gwt-rowRemove')
    assert.equal(buttons.length, 2, 'both linked worktree rows offer deletion')
    await React.act(async () => { buttons[0].click() })
    assert.match(document.querySelector('.gwt-boundList').textContent, /SESSION_A/)
    // Retarget to the second row while its own binding request is still pending.
    await React.act(async () => { buttons[1].click() })
    assert.equal(document.querySelector('.gwt-popPath').textContent, b.path)
    assert.equal(document.querySelector('.gwt-btnDanger').disabled, true, 'confirm disabled while the new target loads')
    assert.equal(document.querySelector('.gwt-check input').disabled, true, 'archive checkbox disabled while the new target loads')
    assert.doesNotMatch(
      document.querySelector('.gwt-boundList')?.textContent ?? '',
      /SESSION_A/,
      'the previous target sessions are not shown for the new target',
    )
  } finally {
    await React.act(async () => { root.unmount() })
    globalThis.fetch = realFetch
    if (realActEnv === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT
    else globalThis.IS_REACT_ACT_ENVIRONMENT = realActEnv
    document.getElementById('root').innerHTML = ''
    host.remove()
  }
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
console.log(`✅ client-current: ${passed} assertions passed`)
