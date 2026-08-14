/**
 * Real-HTTP tests for the panel routes: boots the REAL route handler from
 * lib/routes.js behind a plain node:http server (the webServer carrier's own
 * routing is DSH's tested concern) and drives it with real fetch requests —
 * method enforcement, strict-vs-tolerant not-a-repo behavior, malformed and
 * oversized bodies, the bindings join (dedupe / cap / per-row degradation),
 * traversal containment over HTTP, and the request-timeout abort path.
 *
 * Run: node test/routes-http.js
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootPlugin, makeRepo, makeSubprocess, scratchRoot } from './helpers.js'

let passed = 0
const tests = []
const t = (name, fn) => tests.push([name, fn])

// ── harness: real server wrapping the real handler ─────────────────────────
async function serve(plugin) {
  const handler = plugin.routes[0].handler
  const server = createServer()
  server.on('request', (req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: { message: 'handler threw' } }))
      } else {
        res.end()
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const close = () => new Promise((resolve) => server.close(resolve))
  return { base, close }
}

const req = async (base, method, path, body, raw = false) => {
  const init = { method }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = raw ? body : JSON.stringify(body)
  }
  const res = await fetch(`${base}${path}`, init)
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* non-JSON */ }
  return { status: res.status, text, json, contentType: res.headers.get('content-type') }
}

const root = scratchRoot('dsh-gw-http')
const repo = makeRepo(root, 'repo')
const unborn = join(root, 'unborn')
mkdirSync(unborn, { recursive: true })
const { git } = await import('./helpers.js')
git(unborn, 'init', '-b', 'main')
git(unborn, 'config', 'user.email', 't@t')
git(unborn, 'config', 'user.name', 'T')

const nonRepo = join(root, 'nonrepo')
mkdirSync(nonRepo, { recursive: true })

// main plugin instance (normal caps)
const plugin = await bootPlugin()
const { base, close } = await serve(plugin)

// ── method enforcement ──────────────────────────────────────────────────────

t('405: mutations require POST, reads require GET', async () => {
  assert.equal((await req(base, 'POST', '/dsh-git-worktree/status')).status, 405)
  assert.equal((await req(base, 'POST', '/dsh-git-worktree/list')).status, 405)
  assert.equal((await req(base, 'POST', '/dsh-git-worktree/branches')).status, 405)
  assert.equal((await req(base, 'GET', '/dsh-git-worktree/add')).status, 405)
  assert.equal((await req(base, 'GET', '/dsh-git-worktree/remove')).status, 405)
  assert.equal((await req(base, 'GET', '/dsh-git-worktree/bindings')).status, 405)
  assert.equal((await req(base, 'PUT', '/dsh-git-worktree/status')).status, 405)
  assert.equal((await req(base, 'DELETE', '/dsh-git-worktree/list')).status, 405)
})

// ── 404s ────────────────────────────────────────────────────────────────────

t('404: unknown action and empty action', async () => {
  assert.equal((await req(base, 'GET', '/dsh-git-worktree/bogus')).status, 404)
  assert.equal((await req(base, 'POST', '/dsh-git-worktree/')).status, 404)
  assert.equal((await req(base, 'GET', '/other-prefix/x')).status, 404)
})

// ── read routes: strict vs tolerant ─────────────────────────────────────────

t('status: repo → 200 data; non-repo → 200 notARepo; unborn branch parsed', async () => {
  const ok = await req(base, 'GET', `/dsh-git-worktree/status?repo=${encodeURIComponent(repo)}`)
  assert.equal(ok.status, 200)
  assert.equal(ok.json.ok, true)
  assert.equal(ok.json.data.branch, 'main')
  assert.match(ok.contentType, /application\/json/)

  const nr = await req(base, 'GET', `/dsh-git-worktree/status?repo=${encodeURIComponent(nonRepo)}`)
  assert.equal(nr.status, 200)
  assert.equal(nr.json.data.notARepo, true)

  const ub = await req(base, 'GET', `/dsh-git-worktree/status?repo=${encodeURIComponent(unborn)}`)
  assert.equal(ub.status, 200)
  assert.ok(!ub.json.data.notARepo)
  assert.equal(ub.json.data.branch, 'main', 'unborn branch name parsed over HTTP too')
})

t('list: repo → worktrees; non-repo → 200 notARepo with empty list', async () => {
  const ok = await req(base, 'GET', `/dsh-git-worktree/list?repo=${encodeURIComponent(repo)}`)
  assert.equal(ok.status, 200)
  assert.ok(Array.isArray(ok.json.data.worktrees))
  const nr = await req(base, 'GET', `/dsh-git-worktree/list?repo=${encodeURIComponent(nonRepo)}`)
  assert.equal(nr.status, 200)
  assert.equal(nr.json.data.notARepo, true)
  assert.deepEqual(nr.json.data.worktrees, [])
})

t('branches: strict on non-repo (read but not tolerant), all=1 parsing', async () => {
  const ok = await req(base, 'GET', `/dsh-git-worktree/branches?repo=${encodeURIComponent(repo)}&all=1`)
  assert.equal(ok.status, 200)
  assert.ok(ok.json.data.branches.length >= 1)
  const nr = await req(base, 'GET', `/dsh-git-worktree/branches?repo=${encodeURIComponent(nonRepo)}`)
  assert.equal(nr.status, 400)
  assert.equal(nr.json.ok, false)
  assert.match(nr.json.error.message, /not a git repository/)
})

t('status: missing repo param falls back to the server cwd (a real repo)', async () => {
  // The plugin checkout itself is a git repo (unborn main) — process.cwd().
  const r = await req(base, 'GET', '/dsh-git-worktree/status')
  assert.equal(r.status, 200)
  assert.ok(!r.json.data.notARepo)
  assert.equal(r.json.data.branch, 'main')
})

t('status: repo param with URL-encoded special characters (space, #)', async () => {
  const withSpace = join(root, 'repo with space')
  mkdirSync(withSpace, { recursive: true })
  const { execFileSync } = await import('node:child_process')
  execFileSync('git', ['-C', withSpace, 'init', '-q', '-b', 'main'], { stdio: 'ignore' })
  execFileSync('git', ['-C', withSpace, 'config', 'user.email', 't@t'], { stdio: 'ignore' })
  execFileSync('git', ['-C', withSpace, 'config', 'user.name', 'T'], { stdio: 'ignore' })
  const r = await req(base, 'GET', `/dsh-git-worktree/status?repo=${encodeURIComponent(withSpace)}`)
  assert.equal(r.status, 200)
  assert.ok(!r.json.data.notARepo)
})

// ── mutations ───────────────────────────────────────────────────────────────

t('add/remove over HTTP: create, dedupe via unique, remove', async () => {
  const a1 = await req(base, 'POST', '/dsh-git-worktree/add', { repo, name: 'http-wt', unique: true })
  assert.equal(a1.status, 200)
  assert.equal(a1.json.data.branch, 'http-wt')
  const a2 = await req(base, 'POST', '/dsh-git-worktree/add', { repo, name: 'http-wt', unique: true })
  assert.equal(a2.json.data.branch, 'http-wt-2')
  const rm = await req(base, 'POST', '/dsh-git-worktree/remove', { repo, path: join(repo, '.dsh-wt', 'http-wt') })
  assert.equal(rm.status, 200)
  assert.equal(rm.json.ok, true)
  const rm2 = await req(base, 'POST', '/dsh-git-worktree/remove', { repo, path: join(repo, '.dsh-wt', 'http-wt-2') })
  assert.equal(rm2.status, 200)
})

t('add: traversal name over HTTP is refused with the containment error', async () => {
  const r = await req(base, 'POST', '/dsh-git-worktree/add', { repo, name: '../../escape', newBranch: 'x' })
  assert.equal(r.status, 400)
  assert.match(r.json.error.message, /must resolve inside the repository/)
})

t('add: git failures surface 400 with the exit code', async () => {
  const r = await req(base, 'POST', '/dsh-git-worktree/add', { repo: nonRepo, name: 'x' })
  assert.equal(r.status, 400)
  assert.equal(r.json.ok, false)
  assert.match(r.json.error.message, /not a git repository/)
  assert.equal(typeof r.json.error.exitCode, 'number')
})

// ── bindings join ───────────────────────────────────────────────────────────

t('bindings: dedupe, per-row notARepo, subdir resolution, missing dirs', async () => {
  const wt = join(repo, '.dsh-wt', 'bound-wt')
  const { tools } = plugin
  await tools.git_worktree_add.execute({ name: 'bound-wt', newBranch: 'bound-b' }, { agent: { session: { header: { cwd: repo } } }, signal: new AbortController().signal })
  const sub = join(wt, 'deep')
  mkdirSync(sub, { recursive: true })
  const missing = join(repo, '.dsh-wt', 'gone')
  const r = await req(base, 'POST', '/dsh-git-worktree/bindings', {
    paths: [repo, repo, wt, sub, nonRepo, missing],
  })
  assert.equal(r.status, 200)
  const rows = r.json.data.bindings
  assert.equal(rows.length, 5, 'duplicate path deduped')
  assert.equal(rows.find((b) => b.path === repo).worktree.primary, true)
  assert.equal(rows.find((b) => b.path === wt).worktree.branch, 'bound-b')
  assert.equal(rows.find((b) => b.path === sub).worktree.path, rows.find((b) => b.path === wt).worktree.path)
  assert.equal(rows.find((b) => b.path === nonRepo).notARepo, true)
  const gone = rows.find((b) => b.path === missing)
  assert.equal(gone.notARepo, true)
  assert.equal(gone.worktree, null)
  await tools.git_worktree_remove.execute({ path: wt }, { agent: { session: { header: { cwd: repo } } }, signal: new AbortController().signal })
})

t('bindings: cap at 500 inputs, tolerate non-array and empty', async () => {
  const many = Array.from({ length: 510 }, (_, i) => join(repo, 'cap', String(i)))
  const r = await req(base, 'POST', '/dsh-git-worktree/bindings', { paths: many })
  assert.equal(r.status, 200)
  assert.equal(r.json.data.bindings.length, 500, 'sliced to the 500-input cap')
  const nonArray = await req(base, 'POST', '/dsh-git-worktree/bindings', { paths: 'nope' })
  assert.equal(nonArray.status, 200)
  assert.deepEqual(nonArray.json.data.bindings, [])
  const empty = await req(base, 'POST', '/dsh-git-worktree/bindings', { paths: [] })
  assert.deepEqual(empty.json.data.bindings, [])
})

t('bindings: non-string and empty-string entries are skipped', async () => {
  const r = await req(base, 'POST', '/dsh-git-worktree/bindings', { paths: [repo, '', 42, null, undefined] })
  assert.equal(r.status, 200)
  assert.equal(r.json.data.bindings.length, 1)
})

// ── malformed / oversized bodies ────────────────────────────────────────────

t('invalid JSON body → 400 (client error, not 500)', async () => {
  const r = await req(base, 'POST', '/dsh-git-worktree/add', '{not json', true)
  assert.equal(r.status, 400)
  assert.match(r.json.error.message, /invalid JSON body/)
})

t('oversized body → 413', async () => {
  const big = JSON.stringify({ repo, name: 'x', pad: 'x'.repeat(1_100_000) })
  const r = await req(base, 'POST', '/dsh-git-worktree/add', big, true)
  assert.equal(r.status, 413)
  assert.match(r.json.error.message, /request body too large/)
})

t('empty body on a POST parses to {} and hits arg validation', async () => {
  const r = await req(base, 'POST', '/dsh-git-worktree/add', '')
  assert.equal(r.status, 400) // requires a path or a name
})

// ── timeout / abort path ────────────────────────────────────────────────────

t('hung git aborts at the timeout and the route answers 400, not hangs', async () => {
  const slowPlugin = await bootPlugin({
    caps: { timeoutMs: 150 },
    subprocess: makeSubprocess({ slowCommands: new Set(['status']) }),
  })
  const { base: slowBase, close: slowClose } = await serve(slowPlugin)
  const started = Date.now()
  const r = await req(slowBase, 'GET', `/dsh-git-worktree/status?repo=${encodeURIComponent(repo)}`)
  assert.equal(r.status, 400)
  assert.match(r.json.error.message, /aborted while git ran/)
  assert.ok(Date.now() - started < 5000, 'route did not hang')
  await slowClose()
})

// ── concurrent requests ─────────────────────────────────────────────────────

t('parallel requests all succeed (no cross-talk)', async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, () => req(base, 'GET', `/dsh-git-worktree/status?repo=${encodeURIComponent(repo)}`)),
  )
  for (const r of results) {
    assert.equal(r.status, 200)
    assert.equal(r.json.data.branch, 'main')
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
await close()
console.log(`✅ routes-http: ${passed} assertions passed`)
