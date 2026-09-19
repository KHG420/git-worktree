/**
 * Browser-half smoke test: loads client.js through a simulated
 * `window.__ModuleLoader__.load`, materializes the factory with a fake
 * require over the real react packages, runs the client apply against a fake
 * ctx, and SSR-renders the registered component to prove it mounts.
 *
 * The plugin now registers a single current slot: `sidebar.footer.action`
 * (still a list slot) hosts the worktree sync + the DOM-integration host. The
 * removed `sidebar.workspaces.create` chain must NOT be referenced, and the
 * bound-session flow must go through the ui-workspace service
 * (`uiWorkspace.connectWorkspace`/`openSession`), not `workspaces`.
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
assert.deepEqual(
  moduleExports.inject,
  ['sessions', 'workspaces', 'uiWorkspace', 'slots'],
  'client half declares the current service set (uiWorkspace replaces the removed runtime package wiring)',
)

// Run apply against a fake client ctx.
const injections = []
const registered = []
let openedSessionId = null
let archived = []
let deleted = []
let uiConnects = []
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
    // Real client faces: workspaces.create returns a WorkspaceView; the
    // ui-workspace service owns connectWorkspace/openSession in current DSH.
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
        rename: async (id, title) => ({ workspaceId: id, path: '/repo', title, sessionIds: [], createdAt: '', updatedAt: '' }),
        delete: async (id) => { deleted.push(id) },
      }
    }
    if (key === 'uiWorkspace') {
      return {
        connectWorkspace: async (workspaceId) => {
          uiConnects.push(workspaceId)
          return 's-new'
        },
        openSession: (id) => { openedSessionId = id },
        archiveSession: async (id) => { archived.push(id) },
      }
    }
    return undefined
  },
}
moduleExports.apply(fakeCtx)

assert.equal(injections.length, 1, 'exactly one slot injection registered (no removed chain)')
assert.deepEqual(injections.map((i) => i.slot), ['sidebar.footer.action'])

for (const injection of injections) injection.callback()
const footer = registered.find((r) => r.name === 'sidebar.footer.action')
assert.ok(footer, 'footer sync entry registered')
assert.equal(footer.id, 'git-worktree-sync')
assert.equal(typeof footer.component, 'function')

// Inject face.
const footerFace = footer.inject()
assert.equal(typeof footerFace.sync.list, 'function', 'sync face exposes list')
assert.equal(typeof footerFace.sync.create, 'function', 'sync face exposes create')
assert.equal(typeof footerFace.sync.rename, 'function', 'sync face exposes rename')
assert.equal(typeof footerFace.sync.delete, 'function', 'sync face exposes delete')
assert.equal(typeof footerFace.openBoundSession, 'function', 'footer face exposes openBoundSession')
assert.equal(typeof footerFace.archiveSessions, 'function', 'footer face exposes archiveSessions')

// The openBoundSession flow: workspaces.create -> uiWorkspace.connectWorkspace -> uiWorkspace.openSession.
const result = await footerFace.openBoundSession('/repo/.dsh-wt/feature-a')
assert.deepEqual(result, { ok: true, sessionId: 's-new' }, 'openBoundSession returns ok with the session id')
assert.deepEqual(uiConnects, ['w1'], 'connected through the ui-workspace service')
assert.equal(openedSessionId, 's-new', 'connected session selected via uiWorkspace.openSession')

// The archiveSessions flow forwards to the ui-workspace service.
await footerFace.archiveSessions(['s1', 's2'])
assert.deepEqual(archived, ['s1', 's2'], 'archiveSessions archives each id via uiWorkspace')

// The sync face forwards mutations to the workspace service.
await footerFace.sync.delete('w9')
assert.deepEqual(deleted, ['w9'], 'sync.delete forwards to the workspace service')

// SSR-render the footer mount: renderless until a popover is opened.
const SyncComponent = footer.component
const useWorkspaces = (selector) => selector({ items: [], phase: 'pending', state: 'idle', archivedSessionIds: [], baselinesReady: false, recentWorkspaceId: undefined, error: null })
const syncHtml = renderToStaticMarkup(
  React.createElement(SyncComponent, { useWorkspaces, sync: footerFace.sync }),
)
assert.equal(syncHtml, '', 'the footer mount renders nothing until a row action opens a popover')

console.log('✅ client bundle loads, registers the footer mount only, and wires the ui-workspace service')
