/**
 * Browser-half smoke test: loads client.js through a simulated
 * `window.__ModuleLoader__.load`, materializes the factory with a fake
 * require over the real react packages, runs the client apply against a fake
 * ctx, and SSR-renders the registered components to prove they mount.
 *
 * The Bindings panel is gone: the footer slot hosts a renderless sync mount
 * (renders nothing) and the workspace-tree create chain hosts the per-row
 * worktree affordances.
 *
 * Run: node test/client-smoke.js
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

const require = createRequire(import.meta.url)

// Simulate the browser loader before the bundle executes.
let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      captured = entry
    },
  },
}

await import(pathToFileURL(require.resolve('../client.js')))

assert.ok(captured, 'bundle registered a loader entry')
assert.equal(captured.id, 'dsh-git-worktree')
assert.equal(typeof captured.factory, 'function')

// Materialize the factory with a fake require over real react packages.
const fakeRequire = (spec) => {
  if (spec === 'react') return React
  if (spec === 'react/jsx-runtime') return jsxRuntime
  throw new Error(`unexpected require: ${spec}`)
}
const moduleExports = captured.factory(fakeRequire)
assert.equal(typeof moduleExports.apply, 'function', 'client half exports apply')
assert.deepEqual(moduleExports.inject, ['sessions', 'workspaces', 'slots'], 'client half declares inject')

// Run apply against a fake client ctx.
const injections = []
const registered = []
let openedSessionId = null
let archived = []
let deleted = []
const fakeCtx = {
  slots: {
    inject: (slot, callback) => {
      injections.push({ slot, callback })
    },
    register: (options, component) => {
      registered.push({ ...options, component })
      return () => {}
    },
  },
  get: (key) => {
    // Real client faces: workspaces.create returns a WorkspaceView directly,
    // connectWorkspace resolves the connected session id, sessions.open selects.
    if (key === 'workspaces') {
      return {
        create: async (input) => ({
          workspaceId: 'w1',
          path: input.path,
          title: 'feature-a',
          sessionIds: [],
          createdAt: '',
          updatedAt: '',
        }),
        connectWorkspace: async (workspaceId) => {
          assert.equal(workspaceId, 'w1', 'connectWorkspace targets the created workspace')
          return 's-new'
        },
        archiveSession: async (id) => { archived.push(id) },
        rename: async (id, title) => ({ workspaceId: id, path: '/repo', title, sessionIds: [], createdAt: '', updatedAt: '' }),
        delete: async (id) => { deleted.push(id) },
      }
    }
    if (key === 'sessions') {
      return { open: (id) => { openedSessionId = id } }
    }
    return undefined
  },
}
moduleExports.apply(fakeCtx)

assert.equal(injections.length, 2, 'two slot injections registered')
const slots = injections.map((i) => i.slot)
assert.deepEqual(slots, ['sidebar.footer.action', 'sidebar.workspaces.create'])

for (const injection of injections) injection.callback()
const footer = registered.find((r) => r.name === 'sidebar.footer.action')
const chain = registered.find((r) => r.name === 'sidebar.workspaces.create')
assert.ok(footer, 'footer sync entry registered')
assert.equal(footer.id, 'git-worktree-sync')
assert.equal(typeof footer.component, 'function')
assert.ok(chain, 'tree create chain entry registered')
assert.equal(typeof chain.component, 'function')
assert.equal(typeof chain.select, 'function')

// Inject faces.
const footerFace = footer.inject()
const chainFace = chain.inject()
assert.equal(typeof footerFace.sync.list, 'function', 'sync face exposes list')
assert.equal(typeof footerFace.sync.create, 'function', 'sync face exposes create')
assert.equal(typeof footerFace.sync.rename, 'function', 'sync face exposes rename')
assert.equal(typeof footerFace.sync.delete, 'function', 'sync face exposes delete')
assert.equal(typeof chainFace.openBoundSession, 'function', 'chain face exposes openBoundSession')
assert.equal(typeof chainFace.archiveSessions, 'function', 'chain face exposes archiveSessions')
assert.equal(typeof chainFace.sync, 'object', 'chain face exposes the sync face')

// Chain selector routing: top-level rows match (with topLevel flag), nested
// rows match, the ungrouped bucket declines.
const select = chain.select
assert.deepEqual(
  select({ group: { workspaceId: 'w1', cwd: '/repo', label: 'repo', parentWorkspaceId: undefined } }),
  { workspaceId: 'w1', cwd: '/repo', label: 'repo', topLevel: true },
  'top-level row matched',
)
assert.deepEqual(
  select({ group: { workspaceId: 'w2', cwd: '/repo/.dsh-wt/dev', label: 'dev', parentWorkspaceId: 'w1' } }),
  { workspaceId: 'w2', cwd: '/repo/.dsh-wt/dev', label: 'dev', topLevel: false },
  'nested row matched with topLevel false',
)
assert.equal(select({ group: { workspaceId: undefined, cwd: undefined, label: 'ungrouped' } }), null, 'ungrouped declines')

// The openBoundSession flow: workspace.create -> workspace.connectWorkspace -> sessions.open.
const result = await chainFace.openBoundSession('/repo/.dsh-wt/feature-a')
assert.deepEqual(result, { ok: true, sessionId: 's-new' }, 'openBoundSession returns ok with the session id')
assert.equal(openedSessionId, 's-new', 'connected session selected via sessions.open')

// The archiveSessions flow forwards to the workspace service.
await chainFace.archiveSessions(['s1', 's2'])
assert.deepEqual(archived, ['s1', 's2'], 'archiveSessions archives each id')

// The sync face forwards mutations to the workspace service.
await footerFace.sync.delete('w9')
assert.deepEqual(deleted, ['w9'], 'sync.delete forwards to the workspace service')

// SSR-render the sync mount (renderless; effects do not run in SSR).
const SyncComponent = footer.component
const useWorkspaces = (selector) => selector({ items: [], phase: 'pending', state: 'idle', archivedSessionIds: [], baselinesReady: false, recentWorkspaceId: undefined, error: null })
const syncHtml = renderToStaticMarkup(
  React.createElement(SyncComponent, { useWorkspaces, sync: footerFace.sync })
)
assert.equal(syncHtml, '', 'the sync mount renders nothing')

// SSR-render the chain component for a top-level repo row: the ＋ renders,
// no popover.
const ChainComponent = chain.component
const useSessions = (selector, isEqual) => selector({ ids: ['s1'], byId: { s1: { id: 's1', cwd: '/repo', displayTitle: 'repo', origin: 'user', blank: false, running: false } }, current: 's1' })
const rowHtml = renderToStaticMarkup(
  React.createElement(ChainComponent, {
    group: { workspaceId: 'w1', cwd: '/repo', label: 'repo', parentWorkspaceId: undefined },
    defaultCreate: () => {},
    matched: { workspaceId: 'w1', cwd: '/repo', label: 'repo', topLevel: true },
    useSessions,
    openBoundSession: chainFace.openBoundSession,
    archiveSessions: chainFace.archiveSessions,
    sync: chainFace.sync,
  })
)
assert.ok(rowHtml.includes('gwt-rowPlus'), 'repo row renders the ＋ affordance')
assert.ok(!rowHtml.includes('gwt-createPop'), 'popover closed initially')
assert.ok(!rowHtml.includes('gwt-rowRemove'), 'no delete button on a top-level repo row')

// SSR-render a nested worktree row: no delete button while the store is empty.
const nestedHtml = renderToStaticMarkup(
  React.createElement(ChainComponent, {
    group: { workspaceId: 'w2', cwd: '/repo/.dsh-wt/dev', label: 'dev', parentWorkspaceId: 'w1' },
    defaultCreate: () => {},
    matched: { workspaceId: 'w2', cwd: '/repo/.dsh-wt/dev', label: 'dev', topLevel: false },
    useSessions,
    openBoundSession: chainFace.openBoundSession,
    archiveSessions: chainFace.archiveSessions,
    sync: chainFace.sync,
  })
)
assert.ok(nestedHtml.includes('gwt-rowPlus'), 'nested row renders the ＋ affordance')
assert.ok(!nestedHtml.includes('gwt-rowRemove'), 'delete button gated on the worktree store')

console.log('✅ client bundle loads, registers footer sync + tree chain, and renders')
