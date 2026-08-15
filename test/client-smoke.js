/**
 * Browser-half smoke test: loads client.js through a simulated
 * `window.__ModuleLoader__.load`, materializes the factory with a fake
 * require over the real react packages, runs the client apply against a fake
 * ctx, and SSR-renders the registered panel component to prove it mounts.
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
let registered = null
let openedSessionId = null
let archived = []
const fakeCtx = {
  slots: {
    inject: (slot, callback) => {
      injections.push({ slot, callback })
    },
    register: (options, component) => {
      registered = { ...options, component }
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
        pickDirectory: async () => '/repo',
      }
    }
    if (key === 'sessions') {
      return { open: (id) => { openedSessionId = id } }
    }
    return undefined
  },
}
moduleExports.apply(fakeCtx)

assert.equal(injections.length, 1, 'one slot injection registered')
assert.equal(injections[0].slot, 'sidebar.footer.action')

const disposer = injections[0].callback()
assert.equal(typeof disposer, 'function', 'register returns a disposer')
assert.ok(registered, 'register called with the panel')
assert.equal(registered.name, 'sidebar.footer.action')
assert.equal(registered.id, 'git-worktree-panel')

const face = registered.inject()
assert.equal(typeof face.openBoundSession, 'function', 'inject face exposes openBoundSession')
assert.equal(typeof face.archiveSessions, 'function', 'inject face exposes archiveSessions')
assert.equal(typeof face.pickDirectory, 'function', 'inject face exposes pickDirectory')

// The openBoundSession flow: workspace.create -> workspace.connectWorkspace -> sessions.open.
const result = await face.openBoundSession('/repo/.dsh-wt/feature-a')
assert.deepEqual(result, { ok: true, sessionId: 's-new' }, 'openBoundSession returns ok with the session id')
assert.equal(openedSessionId, 's-new', 'connected session selected via sessions.open')

// The archiveSessions flow forwards to the workspace service.
await face.archiveSessions(['s1', 's2'])
assert.deepEqual(archived, ['s1', 's2'], 'archiveSessions archives each id')

// The pickDirectory flow forwards to the workspace service (host OS chooser).
assert.equal(await face.pickDirectory(), '/repo', 'pickDirectory forwards to the workspace service')

// SSR-render the closed component (open state starts false; effects do not run in SSR).
const Component = registered.component
// Real SessionListState shape: { ids, byId, current, ... } — no items array.
const useSessions = (selector) => selector({ ids: ['s1'], byId: { s1: { id: 's1', cwd: '/repo', displayTitle: 'repo' } }, current: 's1' })
const html = renderToStaticMarkup(
  React.createElement(Component, { wide: true, useSessions, openBoundSession: face.openBoundSession, archiveSessions: face.archiveSessions, pickDirectory: face.pickDirectory })
)
assert.ok(html.includes('gwt-badge'), 'renders the footer badge')
assert.ok(html.includes('Bindings'), 'renders the label')
assert.ok(!html.includes('gwt-panel'), 'panel closed by default')

console.log('✅ client bundle loads, registers sidebar.footer.action, and renders')
