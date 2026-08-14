/**
 * Standalone functional test for dsh-git-worktree — no DSH boot required.
 *
 * Drives the real plugin `apply` with a fake ctx whose `subprocess` seam is
 * implemented over node:child_process, then executes every tool against a
 * scratch git repository and exercises the panel route handler end to end.
 *
 * Run: node test/test.js
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalize } from '../lib/git.js'

// ── fake subprocess seam (mirrors the surface tools use) ──────────────────
function makeSubprocess() {
  return {
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const outChunks = []
      const errChunks = []
      child.stdout.on('data', (c) => outChunks.push(c))
      child.stderr.on('data', (c) => errChunks.push(c))
      const collected = {
        stdout: { readFrom: () => ({ text: Buffer.concat(outChunks).toString('utf8'), lossy: false }) },
        stderr: { readFrom: () => ({ text: Buffer.concat(errChunks).toString('utf8'), lossy: false }) },
      }
      const done = new Promise((resolve, reject) => {
        child.on('error', reject)
        child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
      })
      return { collected, done }
    },
  }
}

// ── fake ctx + plugin boot ────────────────────────────────────────────────
const registered = []
const routeRegistrations = []
const ctx = {
  subprocess: makeSubprocess(),
  tools: { register: (tool) => registered.push(tool) },
  systemPrompt: { section: () => {} },
  effect: (fn) => fn(),
  // Wait-for-webServer seam: the plugin waits for the service with ctx.inject.
  // Cordis scoped contexts inherit the parent, so the fake scoped ctx spreads
  // the parent (subprocess etc.) and adds webServer.
  inject: (names, callback) => {
    const scoped = { ...ctx, webServer: { register: (route) => routeRegistrations.push(route) } }
    callback(scoped)
    return { await: async () => {} }
  },
}

const plugin = (await import('../index.js')).default
await plugin.apply(ctx, { worktreesDir: '.dsh-wt', timeoutMs: 30000, stdoutMaxBytes: 1_000_000, stderrMaxBytes: 64 * 1024 })

const tools = Object.fromEntries(registered.map((t) => [t.name, t]))
assert.equal(Object.keys(tools).length, 9, 'expect 9 tools registered')
assert.equal(routeRegistrations.length, 1, 'expect 1 webServer route registration')
assert.equal(routeRegistrations[0].path, '/dsh-git-worktree', 'route prefix')

// ── scratch repo ──────────────────────────────────────────────────────────
const base = mkdtempSync(join(tmpdir(), 'dsh-gw-test-'))
const nonRepoDir = mkdtempSync(join(tmpdir(), 'dsh-gw-nonrepo-'))
const execAt = (cwd) => ({ agent: { session: { header: { cwd } } }, signal: new AbortController().signal })

try {
  execFileSync('git', ['init', '-b', 'main', base], { stdio: 'ignore' })
  execFileSync('git', ['-C', base, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', base, 'config', 'user.name', 'Test'])
  writeFileSync(join(base, 'a.txt'), 'hello\n')
  execFileSync('git', ['-C', base, 'add', '.'])
  execFileSync('git', ['-C', base, 'commit', '-m', 'init'], { stdio: 'ignore' })

  const exec = execAt(base)

  // 1. repo_status on a clean repo
  let r = await tools.git_repo_status.execute({}, exec)
  assert.equal(r.branch, 'main')
  assert.equal(r.clean, true)
  assert.equal(r.root, '.', 'repo root displays relative to the session cwd')

  // 2. branch_create + branch_list
  r = await tools.git_branch_create.execute({ name: 'feature/x' }, exec)
  assert.equal(r.name, 'feature/x')
  r = await tools.git_branch_list.execute({}, exec)
  assert.ok(r.branches.some((b) => b.name === 'feature/x' && !b.remote), 'feature/x listed')
  assert.ok(r.branches.find((b) => b.name === 'main').head, 'main marked as checked out')

  // 3. worktree_add by name with a new branch (the panel/agent flow)
  r = await tools.git_worktree_add.execute({ name: 'feature-a', newBranch: 'feature-a' }, exec)
  assert.equal(r.path, '.dsh-wt/feature-a')
  assert.equal(r.branch, 'feature-a')
  const wt1 = join(base, '.dsh-wt', 'feature-a')

  // 4. worktree_add at an explicit path checking out an existing branch
  const wt2 = join(base, '.dsh-wt', 'feature-x-wt')
  r = await tools.git_worktree_add.execute({ path: wt2, branch: 'feature/x' }, exec)
  assert.equal(r.branch, 'feature/x')

  // 5. worktree_list markers
  r = await tools.git_worktree_list.execute({}, exec)
  assert.equal(r.worktrees.length, 3)
  assert.ok(r.worktrees.find((w) => w.primary), 'primary marked')
  assert.ok(r.worktrees.find((w) => w.current), 'session worktree marked (repo root)')
  assert.ok(r.worktrees.find((w) => w.path === '.dsh-wt/feature-a' && w.branch === 'feature-a'))
  assert.ok(r.worktrees.find((w) => w.path === '.dsh-wt/feature-x-wt' && w.branch === 'feature/x'))

  // 6. branch_switch (with create) inside the feature-a worktree — main is
  //    checked out in the primary worktree, so switch to a fresh branch
  const execWt1 = execAt(wt1)
  r = await tools.git_branch_switch.execute({ name: 'side', create: true }, execWt1)
  assert.equal(r.name, 'side')
  assert.equal(r.created, true)
  assert.equal((await tools.git_repo_status.execute({}, execWt1)).branch, 'side')

  // 6b. session binding introspection: primary root is unbound, a dedicated
  //     worktree is bound, repo_status carries the binding, non-repo is data
  r = await tools.git_session_binding.execute({}, exec)
  assert.equal(r.notARepo, false)
  assert.equal(r.bound, false, 'primary worktree is not a dedicated binding')
  assert.equal(r.worktree.primary, true)
  assert.equal(r.repo, '.')
  r = await tools.git_session_binding.execute({}, execWt1)
  assert.equal(r.bound, true, 'conversation in a dedicated worktree is bound')
  assert.equal(r.worktree.primary, false)
  assert.equal(r.worktree.branch, 'side')
  assert.equal(r.worktree.current, true)
  assert.ok(r.peers.some((p) => p.primary), 'peers include the primary worktree')
  r = await tools.git_repo_status.execute({}, execWt1)
  assert.equal(r.binding.bound, true, 'repo_status attaches the session binding')
  assert.equal(r.binding.worktree.branch, 'side')
  r = await tools.git_session_binding.execute({}, execAt(nonRepoDir))
  assert.equal(r.notARepo, true, 'non-repo workspace is reported as data, not an error')
  assert.equal(r.bound, false)

  // 6d. a session cwd whose directory no longer exists (deleted worktree)
  //     is also tolerant data — git cannot even start there
  const gonePath = join(base, '.dsh-wt', 'deleted-worktree')
  r = await tools.git_session_binding.execute({}, execAt(gonePath))
  assert.equal(r.notARepo, true, 'missing session cwd is reported as data, not an error')
  assert.equal(r.bound, false)
  assert.equal(r.worktree, null)

  // 6c. binding via a subdirectory of a worktree (prefix match)
  const wt1Sub = join(wt1, 'deep', 'sub')
  mkdirSync(wt1Sub, { recursive: true })
  r = await tools.git_session_binding.execute({}, execAt(wt1Sub))
  assert.equal(r.bound, true, 'subdirectory of a worktree resolves to that worktree')
  assert.equal(r.worktree.absolutePath, canonicalize(wt1))

  // 7. git refuses switching a branch checked out in another worktree — surface it
  await assert.rejects(
    () => tools.git_branch_switch.execute({ name: 'feature/x' }, execWt1),
    (err) => /checked out|already used/i.test(err.message),
    'cross-worktree switch refused by git'
  )

  // 8. deleting a branch checked out in another worktree is refused by git
  await assert.rejects(
    () => tools.git_branch_delete.execute({ name: 'feature/x' }, exec),
    (err) => /checked out|used by/i.test(err.message),
    'checked-out branch delete refused'
  )

  // 9. worktree_remove
  r = await tools.git_worktree_remove.execute({ path: wt2 }, exec)
  assert.equal(r.removed, '.dsh-wt/feature-x-wt')
  assert.equal((await tools.git_worktree_list.execute({}, exec)).worktrees.length, 2)

  // 10. removing an unknown path fails loudly
  await assert.rejects(
    () => tools.git_worktree_remove.execute({ path: join(base, 'nope') }, exec),
    (err) => /not a worktree of this repo/i.test(err.message),
    'unknown worktree path rejected'
  )

  // 11. removing the primary worktree is refused
  await assert.rejects(
    () => tools.git_worktree_remove.execute({ path: base }, exec),
    (err) => /primary worktree/i.test(err.message),
    'primary worktree removal refused'
  )

  // 12. force-remove a dirty worktree, then force-delete the branch
  writeFileSync(join(wt1, 'dirty.txt'), 'x\n')
  await tools.git_worktree_remove.execute({ path: wt1, force: true }, exec)
  r = await tools.git_branch_delete.execute({ name: 'feature-a', force: true }, exec)
  assert.equal(r.deleted, true)
  r = await tools.git_branch_list.execute({}, exec)
  assert.ok(!r.branches.some((b) => b.name === 'feature-a'), 'feature-a gone')

  // 12b. unique add dedupes name collisions by suffixing the candidate
  r = await tools.git_worktree_add.execute({ name: 'dup', unique: true }, exec)
  assert.equal(r.path, '.dsh-wt/dup')
  assert.equal(r.branch, 'dup')
  r = await tools.git_worktree_add.execute({ name: 'dup', unique: true }, exec)
  assert.equal(r.path, '.dsh-wt/dup-2', 'second unique add suffixes the name')
  assert.equal(r.branch, 'dup-2')
  assert.equal((await tools.git_worktree_list.execute({}, exec)).worktrees.length, 3)
  await tools.git_worktree_remove.execute({ path: join(base, '.dsh-wt', 'dup') }, exec)
  await tools.git_worktree_remove.execute({ path: join(base, '.dsh-wt', 'dup-2') }, exec)

  // 12c. explicit newBranch collisions stay git's strict failure under unique
  await assert.rejects(
    () => tools.git_worktree_add.execute({ name: 'x', newBranch: 'dup', unique: true }, exec),
    (err) => /already exists/i.test(err.message),
    'explicit branch collision is surfaced, not silently renamed'
  )

  // 12d. name-based add from INSIDE a worktree anchors to the main repo root,
  //     never nesting under the caller's own worktree
  r = await tools.git_worktree_add.execute({ name: 'probe', newBranch: 'probe' }, exec)
  const probeWt = canonicalize(join(base, '.dsh-wt', 'probe'))
  r = await tools.git_worktree_add.execute({ name: 'sibling' }, execAt(probeWt))
  assert.equal(r.absolutePath, canonicalize(join(base, '.dsh-wt', 'sibling')),
    'worktree created from inside a worktree lands under the main repo root')
  assert.equal((await tools.git_session_binding.execute({}, execAt(probeWt))).worktree.absolutePath, probeWt,
    'probe worktree still resolves to itself despite a nested sibling under the main root')
  await tools.git_worktree_remove.execute({ path: join(base, '.dsh-wt', 'sibling') }, exec)
  await tools.git_worktree_remove.execute({ path: probeWt }, exec)

  // 13. dirty status surfaces entries
  writeFileSync(join(base, 'a.txt'), 'changed\n')
  r = await tools.git_repo_status.execute({}, exec)
  assert.equal(r.clean, false)
  assert.ok(r.entries.some((e) => e.path === 'a.txt' && e.x === ' ' && e.y === 'M'), 'modified entry')

  // ── route handler end to end (no HTTP server needed) ────────────────────
  const handler = routeRegistrations[0].handler
  const call = (method, url, body) => new Promise((resolve, reject) => {
    const listeners = {}
    const req = {
      method,
      url,
      on: (ev, fn) => {
        ;(listeners[ev] ??= []).push(fn)
        return req
      },
      destroy: () => {},
    }
    const res = {
      writeHead: (status) => { res.status = status },
      end: (payload) => resolve({ status: res.status, payload: payload === undefined ? '' : JSON.parse(payload) }),
    }
    handler(req, res).catch(reject)
    if (body !== undefined) {
      for (const fn of listeners.data ?? []) fn(Buffer.from(JSON.stringify(body)))
      for (const fn of listeners.end ?? []) fn()
    }
  })

  let resp = await call('GET', `/dsh-git-worktree/status?repo=${encodeURIComponent(base)}`)
  assert.equal(resp.status, 200)
  assert.equal(resp.payload.ok, true)
  assert.equal(resp.payload.data.branch, 'main')
  assert.equal(resp.payload.data.clean, false, 'route status reflects the dirty file')

  // bindings route: per-path worktree classification (primary / not-a-repo)
  resp = await call('POST', '/dsh-git-worktree/bindings', { paths: [base, nonRepoDir] })
  assert.equal(resp.status, 200)
  assert.equal(resp.payload.data.bindings.length, 2)
  const baseBinding = resp.payload.data.bindings.find((b) => b.path === base)
  assert.equal(baseBinding.notARepo, false)
  assert.equal(baseBinding.worktree.primary, true, 'repo root resolves to the primary worktree')
  const nonRepoBinding = resp.payload.data.bindings.find((b) => b.path === nonRepoDir)
  assert.equal(nonRepoBinding.notARepo, true, 'non-repo path is flagged per-row, not an error')

  // bindings route: a session cwd whose directory no longer exists degrades
  // per-row to notARepo instead of 400ing the whole call — the panel joins
  // every session cwd in one request, so one deleted worktree must not break
  // the refresh (regression: spawn ENOENT used to 400 the entire batch)
  resp = await call('POST', '/dsh-git-worktree/bindings', { paths: [base, gonePath, nonRepoDir] })
  assert.equal(resp.status, 200)
  assert.equal(resp.payload.data.bindings.length, 3)
  const goneBinding = resp.payload.data.bindings.find((b) => b.path === gonePath)
  assert.equal(goneBinding.notARepo, true, 'missing dir degrades to notARepo per-row')
  assert.equal(goneBinding.root, null)
  assert.equal(goneBinding.worktree, null)

  resp = await call('GET', `/dsh-git-worktree/list?repo=${encodeURIComponent(base)}`)
  assert.equal(resp.status, 200)
  assert.equal(resp.payload.data.worktrees.length, 1, 'only the primary remains')

  // unique add via the route: same name twice dedupes to route-created-2
  resp = await call('POST', '/dsh-git-worktree/add', { repo: base, name: 'route-created', unique: true })
  assert.equal(resp.status, 200)
  assert.equal(resp.payload.data.branch, 'route-created')
  const rcPath = join(base, '.dsh-wt', 'route-created')
  resp = await call('POST', '/dsh-git-worktree/add', { repo: base, name: 'route-created', unique: true })
  assert.equal(resp.status, 200)
  assert.equal(resp.payload.data.branch, 'route-created-2', 'route add dedupes on collision')
  const rc2Path = join(base, '.dsh-wt', 'route-created-2')

  // bindings route across the freshly created worktrees, including a subdir
  const rcSub = join(rcPath, 'sub')
  mkdirSync(rcSub, { recursive: true })
  resp = await call('POST', '/dsh-git-worktree/bindings', {
    paths: [base, rcPath, rc2Path, rcSub, nonRepoDir],
  })
  assert.equal(resp.status, 200)
  const bindings = resp.payload.data.bindings
  assert.equal(bindings.length, 5)
  assert.equal(bindings.find((b) => b.path === rcPath).worktree.branch, 'route-created')
  assert.equal(bindings.find((b) => b.path === rcPath).worktree.primary, false)
  assert.equal(bindings.find((b) => b.path === rc2Path).worktree.branch, 'route-created-2')
  assert.equal(bindings.find((b) => b.path === rcSub).worktree.path, bindings.find((b) => b.path === rcPath).worktree.path,
    'subdirectory resolves to its containing worktree')

  resp = await call('GET', `/dsh-git-worktree/list?repo=${encodeURIComponent(base)}`)
  assert.equal(resp.payload.data.worktrees.length, 3)

  resp = await call('POST', '/dsh-git-worktree/remove', { repo: base, path: rcPath })
  assert.equal(resp.status, 200)
  assert.equal(resp.payload.ok, true)
  resp = await call('POST', '/dsh-git-worktree/remove', { repo: base, path: rc2Path })
  assert.equal(resp.status, 200)
  assert.equal(resp.payload.ok, true)

  resp = await call('GET', `/dsh-git-worktree/branches?repo=${encodeURIComponent(base)}&all=1`)
  assert.equal(resp.status, 200)
  assert.ok(resp.payload.data.branches.some((b) => b.name === 'main'))

  resp = await call('POST', '/dsh-git-worktree/remove', { repo: base, path: '/does/not/exist' })
  assert.equal(resp.status, 400, 'git failure surfaces as 400 with error')
  assert.equal(resp.payload.ok, false)
  assert.ok(resp.payload.error.message.includes('not a worktree'))

  resp = await call('GET', '/dsh-git-worktree/bogus')
  assert.equal(resp.status, 404)

  // ── non-repo paths: read routes answer "not a repo" as data (200) ───────
  resp = await call('GET', `/dsh-git-worktree/status?repo=${encodeURIComponent(nonRepoDir)}`)
  assert.equal(resp.status, 200)
  assert.equal(resp.payload.ok, true)
  assert.equal(resp.payload.data.notARepo, true, 'status flags notARepo')

  resp = await call('GET', `/dsh-git-worktree/list?repo=${encodeURIComponent(nonRepoDir)}`)
  assert.equal(resp.status, 200)
  assert.equal(resp.payload.data.notARepo, true, 'list flags notARepo')
  assert.deepEqual(resp.payload.data.worktrees, [], 'list returns no worktrees')

  resp = await call('POST', '/dsh-git-worktree/add', { repo: nonRepoDir, name: 'x' })
  assert.equal(resp.status, 400, 'mutations stay strict on a non-repo path')
  assert.equal(resp.payload.ok, false)
  assert.ok(resp.payload.error.message.includes('not a git repository'), 'mutation surfaces the git failure')

  // ── missing directories: read routes degrade, mutations stay strict ─────
  resp = await call('GET', `/dsh-git-worktree/status?repo=${encodeURIComponent(gonePath)}`)
  assert.equal(resp.status, 200)
  assert.equal(resp.payload.ok, true)
  assert.equal(resp.payload.data.notARepo, true, 'status tolerates a missing directory')

  resp = await call('GET', `/dsh-git-worktree/list?repo=${encodeURIComponent(gonePath)}`)
  assert.equal(resp.status, 200)
  assert.equal(resp.payload.data.notARepo, true, 'list tolerates a missing directory')
  assert.deepEqual(resp.payload.data.worktrees, [], 'list returns no worktrees for a missing dir')

  resp = await call('POST', '/dsh-git-worktree/add', { repo: gonePath, name: 'x' })
  assert.equal(resp.status, 400, 'mutations stay strict on a missing directory')
  assert.equal(resp.payload.ok, false)
  assert.ok(resp.payload.error.message.includes('not a git repository'), 'mutation surfaces the missing-directory failure')
  assert.ok(resp.payload.error.message.includes('no such directory'), 'mutation names the missing directory')

  console.log('✅ all 9 tools + route handlers passed against a scratch repo')
  console.log(`   scratch repo: ${base} (left in place for inspection)`)
} finally {
  rmSync(nonRepoDir, { recursive: true, force: true })
  rmSync(base, { recursive: true, force: true })
}
