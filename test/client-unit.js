/**
 * Client-half unit tests: loads the real browser bundle and exercises the
 * pure helpers the panel uses — sanitizeName (git-ref-safe naming, boundary
 * matrix), sessionsSame (content equality for the sessions feed), and api()
 * (route error mapping against a stubbed fetch).
 *
 * Run: node test/client-unit.js
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

const require = createRequire(import.meta.url)

let passed = 0
const tests = []
const t = (name, fn) => tests.push([name, fn])

// ── load the real bundle ────────────────────────────────────────────────────
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
const fakeRequire = (spec) => {
  if (spec === 'react') return React
  if (spec === 'react/jsx-runtime') return jsxRuntime
  throw new Error(`unexpected require: ${spec}`)
}
const { sanitizeName, sessionsSame, api } = captured.factory(fakeRequire)._test

// ── sanitizeName ────────────────────────────────────────────────────────────

t('sanitizeName: empty/whitespace/point-only fall back to wt', () => {
  assert.equal(sanitizeName(''), 'wt')
  assert.equal(sanitizeName('   '), 'wt')
  assert.equal(sanitizeName('.'), 'wt')
  assert.equal(sanitizeName('..'), 'wt')
  assert.equal(sanitizeName('...'), 'wt')
  assert.equal(sanitizeName('///'), 'wt')
})

t('sanitizeName: forbiddens map to dashes', () => {
  assert.equal(sanitizeName('a b'), 'a-b')
  assert.equal(sanitizeName('a\tb\nc'), 'a-b-c')
  assert.equal(sanitizeName('a~b'), 'a-b')
  assert.equal(sanitizeName('a^b'), 'a-b')
  assert.equal(sanitizeName('a:b'), 'a-b')
  assert.equal(sanitizeName('a?b'), 'a-b')
  assert.equal(sanitizeName('a*b'), 'a-b')
  assert.equal(sanitizeName('a[b'), 'a-b')
  assert.equal(sanitizeName('a\\b'), 'a-b')
  assert.equal(sanitizeName('a@b'), 'a-b')
  assert.equal(sanitizeName('a/b'), 'a-b')
  assert.equal(sanitizeName('a@{b'), 'a-{b', 'lone { is a legal ref char; only the @{ sequence is dropped')
  assert.equal(sanitizeName('a..b'), 'a-b')
  assert.equal(sanitizeName('a//b'), 'a-b')
  assert.equal(sanitizeName('a\x00b\x7fc'), 'a-b-c')
})

t('sanitizeName: trims, collapses runs, strips leading dashes/dots', () => {
  assert.equal(sanitizeName('  Hello World!!  '), 'Hello-World!!', '! is a legal ref char and survives')
  assert.equal(sanitizeName('a---b'), 'a-b')
  assert.equal(sanitizeName('-leading'), 'leading')
  assert.equal(sanitizeName('trailing-'), 'trailing')
  assert.equal(sanitizeName('.hidden'), 'hidden')
  assert.equal(sanitizeName('..dots..'), 'dots')
  assert.equal(sanitizeName('@leading'), 'leading')
})

t('sanitizeName: unicode names are preserved (git allows them)', () => {
  assert.equal(sanitizeName('功能/开发'), '功能-开发')
  assert.equal(sanitizeName('功能 开发'), '功能-开发')
  assert.equal(sanitizeName('日本語'), '日本語')
})

t('sanitizeName: trailing .lock suffix is dropped (invalid ref)', () => {
  assert.equal(sanitizeName('foo.lock'), 'foo')
  assert.equal(sanitizeName('my.LOCK'), 'my')
  assert.equal(sanitizeName('lock'), 'lock')
})

t('sanitizeName: 80-char cap and never-empty results', () => {
  const long = 'x'.repeat(200)
  assert.equal(sanitizeName(long).length, 80)
  assert.equal(sanitizeName('a'.repeat(79)).length, 79)
  // every output is a plausible git ref: no spaces, .., //, @{, trailing dot
  for (const input of ['a b', 'a..b', 'a//b', 'a@{b', 'a.', '.a', '~^:?*[\\@', '控 制/字\\符']) {
    const out = sanitizeName(input)
    assert.ok(!/[\s~^:?*[\]\\@]/.test(out), `no forbidden char in ${JSON.stringify(out)}`)
    assert.ok(!out.includes('..') && !out.includes('//') && !out.includes('@{'), `no forbidden sequence in ${out}`)
    assert.ok(!out.endsWith('.'), `no trailing dot in ${out}`)
  }
})

// ── sessionsSame ────────────────────────────────────────────────────────────

const S = (id, cwd, extra = {}) => ({ id, cwd, origin: 'user', displayTitle: id, blank: false, running: false, ...extra })

t('sessionsSame: identity, length, and content equality', () => {
  const a = [S('s1', '/a'), S('s2', '/b')]
  assert.equal(sessionsSame(a, a), true)
  assert.equal(sessionsSame(a, [S('s1', '/a'), S('s2', '/b')]), true, 'same content, fresh array')
  assert.equal(sessionsSame(a, [S('s1', '/a')]), false, 'length differs')
  assert.equal(sessionsSame(a, null), false)
  assert.equal(sessionsSame(null, a), false)
  assert.equal(sessionsSame(null, null), true)
})

t('sessionsSame: any rendered field change breaks equality', () => {
  const a = [S('s1', '/a')]
  assert.equal(sessionsSame(a, [S('s1', '/b')]), false, 'cwd changed')
  assert.equal(sessionsSame(a, [S('s1', '/a', { origin: 'subagent' })]), false, 'origin changed')
  assert.equal(sessionsSame(a, [S('s1', '/a', { displayTitle: 'renamed' })]), false, 'title changed')
  assert.equal(sessionsSame(a, [S('s1', '/a', { blank: true })]), false, 'blank changed')
  assert.equal(sessionsSame(a, [S('s1', '/a', { running: true })]), false, 'running changed')
  assert.equal(sessionsSame(a, [S('s2', '/a')]), false, 'id changed')
  assert.equal(sessionsSame(a, [S('s1', '/a', { other: 1 })]), true, 'irrelevant fields are ignored')
})

t('sessionsSame: undefined entries are handled', () => {
  assert.equal(sessionsSame([undefined], [undefined]), true)
  assert.equal(sessionsSame([S('s1', '/a')], [undefined]), false)
})

// ── api() ───────────────────────────────────────────────────────────────────

t('api: success returns data', async () => {
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return { ok: true, status: 200, json: async () => ({ ok: true, data: { ping: 1 } }) }
  }
  const data = await api('/dsh-git-worktree/list?repo=x')
  assert.deepEqual(data, { ping: 1 })
  assert.equal(calls[0], '/dsh-git-worktree/list?repo=x')
})

t('api: ok:false body throws the server message with status', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: { message: 'git exploded', exitCode: 128 } }) })
  await assert.rejects(() => api('/x'), (e) => e.message === 'git exploded' && e.status === 400)
})

t('api: non-ok without a body → HTTP status', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => { throw new Error('no json') } })
  await assert.rejects(() => api('/x'), (e) => e.message === 'HTTP 404' && e.status === 404)
})

t('api: non-JSON error body falls back to HTTP status', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => { throw new Error('boom') } })
  await assert.rejects(() => api('/x'), (e) => e.message === 'HTTP 500')
})

t('api: ok:true but non-2xx is treated as failure', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 200, json: async () => ({ ok: true, data: 1 }) })
  await assert.rejects(() => api('/x'), (e) => e.message === 'HTTP 200')
})

// ── SSR: closed badge renders, panel hidden ─────────────────────────────────

t('panel: SSR renders the badge, not the panel', () => {
  const Component = captured.factory(fakeRequire).apply ? null : null // not needed here
  const exports_ = captured.factory(fakeRequire)
  const panel = exports_.inject ? null : null
  void Component
  void panel
  // reuse the smoke-test rendering approach
  const GitWorktreePanel = (() => {
    // pull the component out of a registered slot like the smoke test does
    let registered = null
    const fakeCtx = {
      slots: {
        inject: (slot, callback) => callback(),
        register: (options, component) => {
          registered = { ...options, component }
          return () => {}
        },
      },
      get: () => undefined,
    }
    exports_.apply(fakeCtx)
    return registered.component
  })()
  const useSessions = (selector) => selector({ ids: ['s1'], byId: { s1: { id: 's1', cwd: '/repo', displayTitle: 'repo' } }, current: 's1' })
  const html = renderToStaticMarkup(
    React.createElement(GitWorktreePanel, {
      wide: true,
      useSessions,
      openBoundSession: async () => ({ ok: true }),
      archiveSessions: async () => {},
    }),
  )
  assert.ok(html.includes('gwt-badge'))
  assert.ok(html.includes('Bindings'))
  assert.ok(!html.includes('gwt-panel'))
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
console.log(`✅ client-unit: ${passed} assertions passed`)
