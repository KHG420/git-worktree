/**
 * Boundary + integration tests for the 9 agent tools against real scratch
 * repos: unborn/detached states, worktree-add traversal containment and other
 * degenerate names, detach/commitIsh/force/unique flows, explicit paths,
 * dirty-worktree removal, upstream/ahead/behind, remotes, and git's own
 * strict refusals (checked-out branches, unmerged deletes) surfacing as data.
 *
 * Run: node test/tools-edge.js
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalize } from '../lib/git.js'
import { bootPlugin, commitFile, execAt, git, gitFail, makeBareRemote, makeRepo, makeUnbornRepo, scratchRoot } from './helpers.js'

let passed = 0
const tests = []
const t = (name, fn) => tests.push([name, fn])
const rejects = async (promise, re, label) => {
  await assert.rejects(promise, (e) => {
    if (typeof re === 'string') {
      if (!e.message.includes(re)) throw new Error(`expected "${re}" in message, got: ${e.message}`)
      return true
    }
    if (!re.test(e.message)) throw new Error(`expected ${re} match, got: ${e.message}`)
    return true
  }, label)
}

const root = scratchRoot('dsh-gw-edge')
const { tools } = await bootPlugin()

const repo = makeRepo(root, 'repo')
const unborn = makeUnbornRepo(root, 'unborn')
const nonRepo = join(root, 'nonrepo')
mkdirSync(nonRepo, { recursive: true })
const exec = execAt(repo)
const execUnborn = execAt(unborn)

// ── config validation ───────────────────────────────────────────────────────

t('apply rejects non-positive integer caps', async () => {
  for (const bad of [{ timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: 1.5 }, { stdoutMaxBytes: 0 }, { stderrMaxBytes: -3 }]) {
    await assert.rejects(() => bootPlugin({ caps: bad }), /positive integer/)
  }
})

// ── git_session_binding edge positions ──────────────────────────────────────

t('binding: unborn repo is a repo, unbound at primary', async () => {
  const r = await tools.git_session_binding.execute({}, execUnborn)
  assert.equal(r.notARepo, false)
  assert.equal(r.bound, false)
  assert.equal(r.worktree.primary, true)
})

t('binding: non-repo dir is data, not an error', async () => {
  const r = await tools.git_session_binding.execute({}, execAt(nonRepo))
  assert.equal(r.notARepo, true)
  assert.equal(r.bound, false)
  assert.equal(r.worktree, null)
  assert.deepEqual(r.peers, [])
})

t('binding: a plain subdir of the primary resolves to the primary', async () => {
  const sub = join(repo, 'docs')
  mkdirSync(sub, { recursive: true })
  const r = await tools.git_session_binding.execute({}, execAt(sub))
  assert.equal(r.notARepo, false)
  assert.equal(r.bound, false)
  assert.equal(r.worktree.primary, true)
  assert.equal(r.worktree.current, true)
})

t('binding: a file as session cwd degrades to notARepo data', async () => {
  const f = join(repo, 'a.txt')
  const r = await tools.git_session_binding.execute({}, execAt(f))
  assert.equal(r.notARepo, true)
  assert.equal(r.worktree, null)
})

t('binding: missing directory degrades to notARepo data', async () => {
  const r = await tools.git_session_binding.execute({}, execAt(join(repo, '.dsh-wt', 'never-existed')))
  assert.equal(r.notARepo, true)
})

// ── git_repo_status ─────────────────────────────────────────────────────────

t('status: unborn repo reports the real branch name, clean', async () => {
  const r = await tools.git_repo_status.execute({}, execUnborn)
  assert.equal(r.branch, 'main', 'unborn branch name parsed, not the git phrase')
  assert.equal(r.clean, true)
})

t('status: detached HEAD reports (detached)', async () => {
  git(repo, 'checkout', '-q', '--detach', 'HEAD')
  const r = await tools.git_repo_status.execute({}, exec)
  assert.equal(r.branch, '(detached)')
  git(repo, 'checkout', '-q', 'main')
})

t('status: repo arg accepts subdir, relative path; foreign repo has no binding block', async () => {
  const sub = join(repo, 'docs')
  mkdirSync(sub, { recursive: true })
  const viaSubdir = await tools.git_repo_status.execute({ repo: sub }, exec)
  assert.equal(viaSubdir.branch, 'main')
  const viaRelative = await tools.git_repo_status.execute({ repo: 'docs' }, exec)
  assert.equal(viaRelative.branch, 'main')
  const other = makeRepo(root, 'other')
  const foreign = await tools.git_repo_status.execute({ repo: other }, exec)
  assert.equal(foreign.branch, 'main')
  assert.equal(foreign.binding, undefined, 'foreign repo does not carry this session\'s binding')
})

t('status: non-repo repo arg throws strict', async () => {
  await rejects(tools.git_repo_status.execute({ repo: nonRepo }, exec), 'not a git repository')
})

t('status: ahead/behind with a real remote', async () => {
  const remote = makeBareRemote(root, 'remote.git')
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', '-q', '-u', 'origin', 'main')
  commitFile(repo, 'b.txt', 'b\n', 'local commit') // ahead 1
  // second clone pushes a commit the first repo does not have → behind
  const clone = join(root, 'clone')
  git(root, 'clone', '-q', remote, clone)
  git(clone, 'config', 'user.email', 't@t')
  git(clone, 'config', 'user.name', 'T')
  commitFile(clone, 'c.txt', 'c\n', 'remote commit')
  git(clone, 'push', '-q', 'origin', 'HEAD:main')
  git(repo, 'fetch', '-q', 'origin')
  const r = await tools.git_repo_status.execute({}, exec)
  assert.equal(r.branch, 'main')
  assert.equal(r.ahead, 1)
  assert.equal(r.behind, 1)
})

// ── git_worktree_add ────────────────────────────────────────────────────────

t('add: name only auto-creates a branch from the last path component', async () => {
  const r = await tools.git_worktree_add.execute({ name: 'auto' }, exec)
  assert.equal(r.path, '.dsh-wt/auto')
  assert.equal(r.branch, 'auto')
  await tools.git_worktree_remove.execute({ path: join(repo, '.dsh-wt', 'auto') }, exec)
})

t('add: name + newBranch', async () => {
  const r = await tools.git_worktree_add.execute({ name: 'nb', newBranch: 'nb-branch' }, exec)
  assert.equal(r.branch, 'nb-branch')
  await tools.git_worktree_remove.execute({ path: join(repo, '.dsh-wt', 'nb') }, exec)
})

t('add: name + existing branch checks it out', async () => {
  git(repo, 'branch', 'existing-b')
  const r = await tools.git_worktree_add.execute({ name: 'eb', branch: 'existing-b' }, exec)
  assert.equal(r.branch, 'existing-b')
  await tools.git_worktree_remove.execute({ path: join(repo, '.dsh-wt', 'eb') }, exec)
})

t('add: commitIsh bases the new branch on a specific commit', async () => {
  const sha = git(repo, 'rev-parse', 'HEAD').toString().trim()
  const r = await tools.git_worktree_add.execute({ name: 'ci', newBranch: 'ci-b', commitIsh: sha }, exec)
  assert.equal(r.branch, 'ci-b')
  const wtDir = join(repo, '.dsh-wt', 'ci')
  assert.equal(git(wtDir, 'rev-parse', 'HEAD').toString().trim(), sha)
  await tools.git_worktree_remove.execute({ path: wtDir }, exec)
})

t('add: detach creates a detached worktree', async () => {
  const r = await tools.git_worktree_add.execute({ name: 'dt', detach: true }, exec)
  assert.equal(r.detached, true)
  const wtDir = join(repo, '.dsh-wt', 'dt')
  const binding = await tools.git_session_binding.execute({}, execAt(wtDir))
  assert.equal(binding.worktree.detached, true)
  assert.equal(binding.worktree.branch, null)
  await tools.git_worktree_remove.execute({ path: wtDir }, exec)
})

t('add: explicit absolute and relative paths', async () => {
  const abs = join(root, 'outside-wt')
  const r1 = await tools.git_worktree_add.execute({ path: abs, newBranch: 'abs-b' }, exec)
  assert.equal(r1.absolutePath, abs)
  const r2 = await tools.git_worktree_add.execute({ path: 'docs-wt', newBranch: 'rel-b' }, exec)
  assert.equal(r2.absolutePath, canonicalize(join(repo, 'docs-wt')), 'relative path resolves against the canonical base')
  await tools.git_worktree_remove.execute({ path: abs }, exec)
  await tools.git_worktree_remove.execute({ path: join(repo, 'docs-wt') }, exec)
})

t('add: force reuses a deleted worktree; non-empty dirs are refused regardless', async () => {
  // non-empty dir: refused even with --force (git\'s own semantics)
  const nonEmpty = join(repo, '.dsh-wt', 'nonempty')
  mkdirSync(nonEmpty, { recursive: true })
  writeFileSync(join(nonEmpty, 'existing.txt'), 'x')
  await rejects(tools.git_worktree_add.execute({ name: 'nonempty', newBranch: 'nonempty-b', force: true }, exec), /already exists/)
  // NOTE: git creates the branch before failing on the directory, so the
  // leftover branch is git's own artifact — the plugin surfaces the strict
  // error as designed.
  // empty pre-existing dir: accepted by git even without force
  const empty = join(repo, '.dsh-wt', 'emptydir')
  mkdirSync(empty, { recursive: true })
  const r0 = await tools.git_worktree_add.execute({ name: 'emptydir', newBranch: 'empty-b' }, exec)
  assert.equal(r0.branch, 'empty-b')
  await tools.git_worktree_remove.execute({ path: empty }, exec)
  // the real force use-case: a worktree whose directory was deleted
  const wt = join(repo, '.dsh-wt', 'ghost')
  await tools.git_worktree_add.execute({ name: 'ghost', newBranch: 'ghost-b' }, exec)
  // remove only the directory, keeping the registration
  const { rmSync } = await import('node:fs')
  rmSync(wt, { recursive: true, force: true })
  await rejects(tools.git_worktree_add.execute({ name: 'ghost', newBranch: 'ghost-b2' }, exec), /already registered|already exists|already used/)
  // again: the refused attempt left the branch behind (git's own artifact) —
  // force with a fresh branch name
  const r2 = await tools.git_worktree_add.execute({ name: 'ghost', newBranch: 'ghost-b3', force: true }, exec)
  assert.equal(r2.branch, 'ghost-b3')
  await tools.git_worktree_remove.execute({ path: wt, force: true }, exec)
})

t('add: TRAVERSAL names are refused — nothing lands outside the repo', async () => {
  for (const name of ['../../escape', '..', '../.git', 'a/../../escape2', 'x/../..']) {
    await rejects(
      tools.git_worktree_add.execute({ name, newBranch: 'x' }, exec),
      'worktree name must resolve inside the repository',
      `traversal name "${name}" refused`,
    )
  }
  assert.equal(gitFail(root, 'cat-file', '-e', 'refs/heads/escape').code, 128, 'no escape branch created')
  assert.equal(gitFail(root, 'rev-parse', '--verify', 'refs/heads/escape').code, 128)
})

t('add: nested name (feature/foo) creates nested dirs', async () => {
  const r = await tools.git_worktree_add.execute({ name: 'feat/nested', newBranch: 'feat/nested' }, exec)
  assert.equal(r.branch, 'feat/nested')
  await tools.git_worktree_remove.execute({ path: join(repo, '.dsh-wt', 'feat', 'nested') }, exec)
})

t('add: missing name and path is an explicit error', async () => {
  await rejects(tools.git_worktree_add.execute({}, exec), 'requires a path or a name')
  await rejects(tools.git_worktree_add.execute({ name: '', path: '' }, exec), 'requires a path or a name')
})

t('add: invalid ref name surfaces git\'s error (tool takes raw names)', async () => {
  await rejects(tools.git_worktree_add.execute({ name: 'foo.lock', newBranch: 'foo.lock' }, exec), /not a valid/)
})

t('add: unique dedupes when the auto branch is checked out elsewhere', async () => {
  git(repo, 'branch', 'taken')
  // branch "taken" exists but is NOT checked out: git checks it out in the new
  // worktree (no collision). Force a collision instead: check it out first.
  const wt = join(repo, '.dsh-wt', 'holder')
  await tools.git_worktree_add.execute({ path: wt, branch: 'taken' }, exec)
  const r = await tools.git_worktree_add.execute({ name: 'taken', unique: true }, exec)
  assert.equal(r.branch, 'taken-2', 'auto branch collision dedupes to -2')
  await tools.git_worktree_remove.execute({ path: wt }, exec)
  await tools.git_worktree_remove.execute({ path: join(repo, '.dsh-wt', 'taken-2') }, exec)
})

// ── git_worktree_remove ─────────────────────────────────────────────────────

t('remove: dirty worktree refuses without force, removes with force', async () => {
  const wt = join(repo, '.dsh-wt', 'dirty')
  await tools.git_worktree_add.execute({ name: 'dirty', newBranch: 'dirty-b' }, exec)
  writeFileSync(join(wt, 'dirty.txt'), 'x')
  await rejects(tools.git_worktree_remove.execute({ path: wt }, exec), /contains modified or untracked files|not empty/)
  const r = await tools.git_worktree_remove.execute({ path: wt, force: true }, exec)
  assert.equal(r.removed, '.dsh-wt/dirty')
})

t('remove: relative path and trailing slash resolve', async () => {
  const wt = join(repo, '.dsh-wt', 'rel')
  await tools.git_worktree_add.execute({ name: 'rel', newBranch: 'rel-remove-b' }, exec)
  await tools.git_worktree_remove.execute({ path: 'docs/../.dsh-wt/rel/' }, exec)
  assert.equal(git(repo, 'worktree', 'list', '--porcelain').toString().includes(wt), false)
})

t('remove: unknown and unregistered paths fail with the registered list', async () => {
  await rejects(tools.git_worktree_remove.execute({ path: join(repo, '.dsh-wt', 'nope') }, exec), 'not a worktree of this repo')
  await rejects(tools.git_worktree_remove.execute({ path: join(repo, 'docs') }, exec), 'not a worktree of this repo')
})

t('remove: primary worktree is refused', async () => {
  await rejects(tools.git_worktree_remove.execute({ path: repo }, exec), 'refusing to remove the primary worktree')
})

t('remove: removing from inside a linked worktree works', async () => {
  const wt = join(repo, '.dsh-wt', 'victim')
  await tools.git_worktree_add.execute({ name: 'victim', newBranch: 'victim-b' }, exec)
  await tools.git_worktree_remove.execute({ path: wt }, execAt(wt))
  assert.equal(git(repo, 'worktree', 'list', '--porcelain').toString().includes(wt), false)
})

// ── git_branch_* ────────────────────────────────────────────────────────────

t('branch_create: from a specific branch, and switch', async () => {
  git(repo, 'branch', 'base-b')
  const r1 = await tools.git_branch_create.execute({ name: 'from-base', from: 'base-b' }, exec)
  assert.equal(r1.name, 'from-base')
  assert.equal(r1.switched, false)
  const r2 = await tools.git_branch_create.execute({ name: 'switched-b', switch: true }, exec)
  assert.equal(r2.switched, true)
  assert.equal((await tools.git_repo_status.execute({}, exec)).branch, 'switched-b')
  await tools.git_branch_switch.execute({ name: 'main' }, exec)
})

t('branch_create: duplicate and invalid names surface git errors', async () => {
  await rejects(tools.git_branch_create.execute({ name: 'main' }, exec), /already exists/)
  await rejects(tools.git_branch_create.execute({ name: 'bad name' }, exec), /not a valid/)
  await rejects(tools.git_branch_create.execute({}, exec), 'missing required property "name"', 'schema rejects a missing name')
  await rejects(tools.git_branch_create.execute({ name: '' }, exec), 'requires a name', 'empty name hits the ops guard')
})

t('branch_switch: create flag, missing-branch strictness, no-op switch', async () => {
  const r = await tools.git_branch_switch.execute({ name: 'fresh', create: true }, exec)
  assert.equal(r.created, true)
  await rejects(tools.git_branch_switch.execute({ name: 'nope-not-there' }, exec), /invalid reference|not find|unknown switch/)
  await tools.git_branch_switch.execute({ name: 'fresh' }, exec) // no-op ok
  await tools.git_branch_switch.execute({ name: 'main' }, exec)
})

t('branch_switch: conflicting local changes are refused by git', async () => {
  git(repo, 'branch', 'conflict-b')
  git(repo, 'checkout', '-q', 'conflict-b')
  commitFile(repo, 'a.txt', 'conflict version\n', 'conflict commit')
  git(repo, 'checkout', '-q', 'main')
  writeFileSync(join(repo, 'a.txt'), 'local change\n')
  await rejects(tools.git_branch_switch.execute({ name: 'conflict-b' }, exec), /overwritten|would be overwritten/)
  git(repo, 'checkout', '-q', '--', 'a.txt') // discard
})

t('branch_delete: unmerged without force refused, force deletes', async () => {
  git(repo, 'branch', 'unmerged-b')
  git(repo, 'checkout', '-q', 'unmerged-b')
  commitFile(repo, 'u.txt', 'u\n', 'unmerged commit')
  git(repo, 'checkout', '-q', 'main')
  await rejects(tools.git_branch_delete.execute({ name: 'unmerged-b' }, exec), /not fully merged/)
  const r = await tools.git_branch_delete.execute({ name: 'unmerged-b', force: true }, exec)
  assert.equal(r.deleted, true)
})

t('branch_delete: a branch checked out in any worktree is refused', async () => {
  const wt = join(repo, '.dsh-wt', 'protect')
  await tools.git_worktree_add.execute({ name: 'protect', newBranch: 'protect-b' }, exec)
  await rejects(tools.git_branch_delete.execute({ name: 'protect-b' }, exec), /checked out|used by worktree/)
  await tools.git_worktree_remove.execute({ path: wt, force: true }, exec)
})

t('branch_delete: current branch of the worktree is refused', async () => {
  git(repo, 'checkout', '-q', '-b', 'current-b')
  await rejects(tools.git_branch_delete.execute({ name: 'current-b' }, exec), /checked out|used by worktree/)
  await tools.git_branch_switch.execute({ name: 'main' }, exec)
})

// ── git_branch_list ─────────────────────────────────────────────────────────

t('branch_list: upstream + remote branches via all', async () => {
  const r = await tools.git_branch_list.execute({ all: true }, exec)
  const main = r.branches.find((b) => b.name === 'main')
  assert.ok(main, 'main listed')
  assert.equal(main.upstream, 'origin/main')
  assert.equal(main.remote, false)
  assert.ok(r.branches.some((b) => b.name === 'origin/main' && b.remote), 'remote-tracking branch listed with all')
  const headsOnly = await tools.git_branch_list.execute({}, exec)
  assert.ok(!headsOnly.branches.some((b) => b.remote), 'remote branches hidden without all')
})

t('branch_list: unborn repo lists no branches', async () => {
  const r = await tools.git_branch_list.execute({}, execUnborn)
  assert.equal(r.branches.length, 0)
})

// ── worktree_list / worktree_add from foreign and nested positions ─────────

t('worktree_list: from a linked worktree marks current correctly', async () => {
  const wt = join(repo, '.dsh-wt', 'self')
  await tools.git_worktree_add.execute({ name: 'self', newBranch: 'self-b' }, exec)
  const r = await tools.git_worktree_list.execute({}, execAt(wt))
  // the session's own worktree displays as "." (paths are relative to the cwd)
  assert.ok(r.worktrees.find((w) => w.path === '.' && w.current), 'own worktree marked current')
  assert.ok(r.worktrees.find((w) => w.primary), 'primary flagged')
  const fromRoot = await tools.git_worktree_list.execute({}, exec)
  assert.ok(fromRoot.worktrees.find((w) => w.path === '.dsh-wt/self' && w.current === false),
    'from the primary, the linked worktree is not current')
  await tools.git_worktree_remove.execute({ path: wt }, exec)
})

t('worktree_list: foreign repo query flags its own primary', async () => {
  const other = makeRepo(root, 'other2')
  const wt = join(other, '.dsh-wt', 'owt')
  await tools.git_worktree_add.execute({ name: 'owt', newBranch: 'owt-b' }, execAt(other))
  const r = await tools.git_worktree_list.execute({ repo: other }, exec)
  assert.equal(r.worktrees.filter((w) => w.primary).length, 1, 'exactly one primary in a foreign repo')
  // foreign paths display absolute (outside the session cwd); canonical forms
  assert.ok(r.worktrees.find((w) => w.absolutePath === canonicalize(wt) && w.primary === false))
  await tools.git_worktree_remove.execute({ repo: other, path: wt }, execAt(other))
})

t('add from inside a linked worktree never nests under the caller', async () => {
  const wt = join(repo, '.dsh-wt', 'outer')
  await tools.git_worktree_add.execute({ name: 'outer', newBranch: 'outer-b' }, exec)
  const r = await tools.git_worktree_add.execute({ name: 'inner' }, execAt(wt))
  assert.equal(r.absolutePath, canonicalize(join(repo, '.dsh-wt', 'inner')), 'anchored to the main repo root')
  await tools.git_worktree_remove.execute({ path: join(repo, '.dsh-wt', 'inner') }, execAt(wt))
  await tools.git_worktree_remove.execute({ path: wt }, exec)
})

// ── sequential runner (these tests share one repo — order matters) ─────────
for (const [name, fn] of tests) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    console.error(`✗ ${name}`)
    throw error
  }
}
console.log(`✅ tools-edge: ${passed} assertions passed`)
