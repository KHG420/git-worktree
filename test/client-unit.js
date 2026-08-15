/**
 * Client-half unit tests: loads the real browser bundle and exercises the
 * pure helpers the plugin uses — sanitizeName (git-ref-safe naming, boundary
 * matrix), sessionsSame (content equality for the sessions feed), api()
 * (route error mapping against a stubbed fetch), and runSync (the worktree
 * auto-detect engine: registration, 主工作树 marker, stale sweep,
 * coalescing).
 *
 * Run: node test/client-unit.js
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'

const require = createRequire(import.meta.url)

let passed = 0
const tests = []
const t = (name, fn) => tests.push([name, fn])

// localStorage shim (the browser half persists its auto-created workspace ids
// there; the stale sweep depends on it).
const storage = new Map()
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
}

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
const testSurface = captured.factory(fakeRequire)._test
const { sanitizeName, sessionsSame, api, runSync, worktreeStore, loadAuto, saveAuto, _reset } = testSurface

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

t('sanitizeName: the 80-char slice never re-exposes a trailing dot', () => {
  // 79 chars + ".b": the pre-slice name has no trailing dot (ends in "b"),
  // so the strip does not fire before slicing — the 80-char cut then lands
  // on the dot. The post-slice strip must remove it again.
  const out = sanitizeName('a'.repeat(79) + '.b')
  assert.equal(out.length, 79, 'trailing dot stripped after the slice')
  assert.ok(!out.endsWith('.'))
  assert.equal(sanitizeName('a'.repeat(79) + '-.'), 'a'.repeat(79))
  assert.equal(sanitizeName('a'.repeat(79) + '.lock'), 'a'.repeat(79), '.lock dropped before the slice')
})

t('sanitizeName: the reserved branch name HEAD falls back to wt', () => {
  assert.equal(sanitizeName('HEAD'), 'wt')
  assert.equal(sanitizeName('HEAD '), 'wt')
  assert.equal(sanitizeName('head'), 'head', 'lowercase head is a legal ref')
  assert.equal(sanitizeName('HEAD~1'), 'HEAD-1', 'only the exact reserved name is guarded')
  assert.equal(sanitizeName('HEAD/feature'), 'HEAD-feature')
})

t('sanitizeName: slicing by code points never splits a surrogate pair', () => {
  // 'a' + 40 emoji is 81 UTF-16 units; a unit-based slice(0,80) would cut a
  // lone surrogate. Code-point slicing keeps the whole emoji.
  const out = sanitizeName('a' + '😀'.repeat(40))
  for (const ch of out) {
    const code = ch.codePointAt(0)
    assert.ok(code < 0xd800 || code > 0xdfff, `no lone surrogate (U+${code.toString(16)})`)
  }
  assert.ok(out.endsWith('😀'), 'last emoji intact')
  assert.ok(Array.from(out).length <= 80, 'at most 80 code points')
})

t('sanitizeName: every output passes git check-ref-format (property matrix)', () => {
  const inputs = [
    'a b', 'a..b', 'a//b', 'a@{b', 'a@b', 'a.', '.a', '~^:?*[\\@', '控 制/字\\符',
    'foo.lock', 'my.LOCK', '.lock', 'HEAD', 'head', 'HEAD~1',
    'a'.repeat(79) + '.b', 'a'.repeat(200), '😀'.repeat(41), 'a' + '😀'.repeat(40),
    'x.\n', '...', '///', '-leading', 'trailing-', '  Hello World!!  ',
    '@leading', 'a---b', '..dots..', 'a.b.c', 'feature/x', 'wt', 'a-b-c',
  ]
  for (const input of inputs) {
    const out = sanitizeName(input)
    assert.ok(Array.from(out).length >= 1 && Array.from(out).length <= 80, `code-point length in [1,80] for ${JSON.stringify(out)}`)
    try {
      execFileSync('git', ['check-ref-format', `refs/heads/${out}`], { stdio: 'pipe' })
    } catch (error) {
      throw new Error(`sanitizeName(${JSON.stringify(input)}) -> ${JSON.stringify(out)} is NOT a valid git ref: ${error.stderr}`)
    }
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

// ── runSync: the worktree auto-detect engine ────────────────────────────────

const REPO = '/repo'
const FEAT = '/repo/.dsh-wt/feat-a' // length 22
const W = (id, path, extra = {}) => ({ workspaceId: id, path, title: path.split('/').pop(), sessionIds: [], createdAt: '', updatedAt: '', ...extra })

function syncFace(worktrees, { log = [], failList = false } = {}) {
  const byPath = new Map()
  for (const wt of worktrees) byPath.set(wt.absolutePath, wt)
  let n = 0
  return {
    byPath,
    async list() {
      if (failList) throw new Error('list boom')
      return { notARepo: false, root: REPO, worktrees }
    },
    async create({ path }) {
      n += 1
      const id = `w-auto-${n}`
      log.push(['create', path])
      return W(id, path)
    },
    async rename(id, title) {
      log.push(['rename', id, title])
      return W(id, REPO, { title })
    },
    async delete(id) {
      log.push(['delete', id])
    },
  }
}

const MAIN_WT = { path: '.', absolutePath: REPO, branch: 'main', head: 'aaa', primary: true }
const FEAT_WT = { path: '.dsh-wt/feat-a', absolutePath: FEAT, branch: 'feat-a', head: 'bbb', primary: false }

t('runSync: registers linked worktrees and marks the main worktree', async () => {
  _reset()
  const log = []
  const face = syncFace([MAIN_WT, FEAT_WT], { log })
  const out = await runSync([W('w1', REPO)], face)
  assert.equal(out.repos, 1)
  assert.deepEqual(log, [
    ['rename', 'w1', 'repo（主工作树）'],
    ['create', FEAT],
  ], 'main worktree marked, linked worktree registered')
  assert.ok(loadAuto().has('w-auto-1'), 'auto-created id persisted')
  assert.equal(worktreeStore.state.byPath.get(REPO).primary, true)
  assert.equal(worktreeStore.state.byPath.get(FEAT).primary, false)
  assert.equal(worktreeStore.state.byPath.get(FEAT).repoRoot, REPO)
  assert.deepEqual(worktreeStore.state.roots.get(REPO), [REPO, FEAT])
  _reset()
})

t('runSync: a custom main-worktree title is never overwritten', async () => {
  _reset()
  const log = []
  const face = syncFace([MAIN_WT], { log })
  await runSync([W('w1', REPO, { title: '我的项目' })], face)
  assert.deepEqual(log, [], 'no rename for a custom title')
  _reset()
})

t('runSync: stale sweep unregisters a sessionless worktree that left git', async () => {
  _reset()
  const log = []
  const face = syncFace([MAIN_WT], { log })
  saveAuto(new Set(['w2']))
  await runSync([W('w1', REPO, { title: 'repo（主工作树）' }), W('w2', FEAT)], face)
  assert.deepEqual(log, [['delete', 'w2']], 'stale sessionless worktree unregistered')
  assert.ok(!loadAuto().has('w2'), 'id dropped from the auto registry')
  _reset()
})

t('runSync: keeps a stale worktree that still has sessions', async () => {
  _reset()
  const log = []
  const face = syncFace([MAIN_WT], { log })
  saveAuto(new Set(['w2']))
  await runSync([W('w1', REPO, { title: 'repo（主工作树）' }), W('w2', FEAT, { sessionIds: ['s9'] })], face)
  assert.deepEqual(log, [], 'session-bearing worktree kept')
  _reset()
})

t('runSync: never sweeps workspaces it did not auto-create', async () => {
  _reset()
  const log = []
  const face = syncFace([MAIN_WT], { log })
  await runSync([W('w1', REPO), W('w-user', FEAT)], face)
  assert.deepEqual(log, [['rename', 'w1', 'repo（主工作树）']], 'user workspace untouched')
  _reset()
})

t('runSync: a workspace inside a repo but not at the root still discovers the project', async () => {
  _reset()
  const log = []
  const face = syncFace([MAIN_WT, FEAT_WT], { log })
  // Only the worktree folder is registered — the sync must create the project
  // folder (marked) so the tree nests correctly.
  await runSync([W('w2', FEAT)], face)
  assert.deepEqual(log, [
    ['create', REPO],
    ['rename', 'w-auto-1', 'repo（主工作树）'],
  ], 'project folder created and marked, worktree already registered')
  _reset()
})

t('runSync: a failed list call is tolerated per workspace', async () => {
  _reset()
  const log = []
  const okFace = syncFace([MAIN_WT], { log })
  const face = {
    ...okFace,
    list: async () => { throw new Error('list boom') },
  }
  const out = await runSync([W('w1', REPO)], face)
  assert.equal(out.repos, 0, 'repo skipped without failing the pass')
  assert.deepEqual(log, [], 'no mutations for an unreadable repo')
  _reset()
})

t('runSync: coalesces — a call during an in-flight pass is folded in', async () => {
  _reset()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let listCalls = 0
  const face = syncFace([MAIN_WT], {})
  face.list = async () => { listCalls += 1; await gate; return { notARepo: false, root: REPO, worktrees: [MAIN_WT] } }
  const first = runSync([W('w1', REPO)], face)
  const second = runSync([W('w1', REPO), W('w2', FEAT)], face)
  const secondResult = await second
  assert.equal(secondResult.coalesced, true, 'second call folded while the first is in flight')
  release()
  await first
  // the pending re-run fires with the latest inputs (two workspaces → 2 lists)
  await new Promise((resolve) => setTimeout(resolve, 5))
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(listCalls, 3, 'pending rerun executed with the latest inputs (1 + 2 list calls)')
  _reset()
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
