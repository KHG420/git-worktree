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
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalize } from '../lib/git.js'
import { bootPlugin, commitFile, execAt, git, gitFail, makeAgents, makeBareRemote, makeRepo, makeUnbornRepo, scratchRoot } from './helpers.js'

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

t('add: unique dedupes a registered-but-missing worktree ("already registered")', async () => {
  // delete ONLY the worktree directory, keeping its git registration — git
  // answers "missing but already registered worktree"; unique must retry to
  // a suffixed name instead of surfacing the raw git failure (regression for
  // the one-click panel flow after a manually-deleted worktree dir)
  await tools.git_worktree_add.execute({ name: 'ghosted', newBranch: 'ghosted-b' }, exec)
  const { rmSync } = await import('node:fs')
  rmSync(join(repo, '.dsh-wt', 'ghosted'), { recursive: true, force: true })
  const r = await tools.git_worktree_add.execute({ name: 'ghosted', unique: true }, exec)
  assert.equal(r.branch, 'ghosted-2', 'registered-but-missing path dedupes to -2')
  await tools.git_worktree_remove.execute({ path: join(repo, '.dsh-wt', 'ghosted-2') }, exec)
  git(repo, 'worktree', 'prune') // drop the stale registration
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

// ── review findings: binding attach, unborn flows, races, dirty matrix ──────

t('status: bound session in an outside-path worktree carries the binding block', async () => {
  // a worktree created at an explicit path OUTSIDE the main repo root — its
  // --show-toplevel is the worktree root, not the main root, so the binding
  // attach must compare main roots, not the worktree root
  const outside = join(root, 'wt-outside')
  await tools.git_worktree_add.execute({ path: outside, newBranch: 'outside-b' }, exec)
  const st = await tools.git_repo_status.execute({}, execAt(outside))
  assert.equal(st.binding.bound, true, 'binding attached for a bound outside worktree')
  assert.equal(st.binding.worktree.absolutePath, canonicalize(outside))
  assert.equal(st.binding.worktree.primary, false)
  // and via a subdirectory of that worktree
  const sub = join(outside, 'deep')
  mkdirSync(sub, { recursive: true })
  const st2 = await tools.git_repo_status.execute({}, execAt(sub))
  assert.equal(st2.binding.bound, true)
  await tools.git_worktree_remove.execute({ path: outside }, exec)
})

t('status: a nested repo inside the session repo does not inherit the session binding', async () => {
  const nested = join(repo, 'nested-repo')
  mkdirSync(nested, { recursive: true })
  git(nested, 'init', '-q', '-b', 'main')
  git(nested, 'config', 'user.email', 't@t')
  git(nested, 'config', 'user.name', 'T')
  commitFile(nested, 'n.txt', 'n\n', 'init')
  // querying the nested repo from the session repo: it is a DIFFERENT repo
  const r1 = await tools.git_repo_status.execute({ repo: nested }, exec)
  assert.equal(r1.binding, undefined, 'nested repo is foreign — no session binding attached')
  // from INSIDE the nested repo the binding is its own primary
  const r2 = await tools.git_repo_status.execute({}, execAt(nested))
  assert.equal(r2.binding.bound, false)
  assert.equal(r2.binding.worktree.primary, true)
  // remove the nested repo so the outer repo stays clean (a nested .git dir
  // shows as untracked and `git clean` refuses to remove it)
  const { rmSync } = await import('node:fs')
  rmSync(nested, { recursive: true, force: true })
})

t('unborn repo: worktree add (name+newBranch and name-only) creates the first bound worktree', async () => {
  const r = await tools.git_worktree_add.execute({ name: 'first', newBranch: 'first' }, execUnborn)
  assert.equal(r.path, '.dsh-wt/first')
  assert.equal(r.branch, 'first')
  const binding = await tools.git_session_binding.execute({}, execAt(join(unborn, '.dsh-wt', 'first')))
  assert.equal(binding.bound, true, 'unborn-repo worktree is a real binding')
  await tools.git_worktree_remove.execute({ path: join(unborn, '.dsh-wt', 'first') }, execUnborn)
  const r2 = await tools.git_worktree_add.execute({ name: 'only' }, execUnborn)
  assert.equal(r2.branch, 'only', 'name-only add derives the branch from the path component')
  await tools.git_worktree_remove.execute({ path: join(unborn, '.dsh-wt', 'only') }, execUnborn)
})

t('unborn repo: branch_create surfaces git\'s start-point error; switch -c works', async () => {
  // `git branch <name>` on an unborn HEAD has no start point — git's own
  // failure surfaces as designed (the plugin does not invent a start point)
  await rejects(tools.git_branch_create.execute({ name: 'b1' }, execUnborn),
    /not a valid object name|valid branch name/, 'unborn branch_create surfaces git\'s error')
  // switch -c from an unborn HEAD works and MIGRATES the unborn branch —
  // git semantics: the old unborn ref is gone, HEAD now points at b2
  const sw = await tools.git_branch_switch.execute({ name: 'b2', create: true }, execUnborn)
  assert.equal(sw.created, true)
  assert.equal((await tools.git_repo_status.execute({}, execUnborn)).branch, 'b2')
  await rejects(tools.git_branch_switch.execute({ name: 'main' }, execUnborn),
    /invalid reference|not find/, 'the migrated-away unborn branch no longer exists')
})

t('unborn repo: repo_status reports untracked files as dirty', async () => {
  writeFileSync(join(unborn, 'u.txt'), 'x\n')
  const r = await tools.git_repo_status.execute({}, execUnborn)
  assert.equal(r.clean, false)
  assert.ok(r.entries.some((e) => e.path === 'u.txt' && e.x === '?' && e.y === '?'), 'untracked entry in an unborn repo')
  const { rmSync } = await import('node:fs')
  rmSync(join(unborn, 'u.txt'), { force: true })
})

t('parallel unique adds with the same name never collide', async () => {
  // two panels / agents clicking "create" for the same feature at once: git
  // serializes the actual creation, the loser's "already exists" triggers the
  // unique retry to -2
  const [a, b] = await Promise.all([
    tools.git_worktree_add.execute({ name: 'race', unique: true }, exec),
    tools.git_worktree_add.execute({ name: 'race', unique: true }, exec),
  ])
  const paths = [a.path, b.path].sort()
  assert.deepEqual(paths, ['.dsh-wt/race', '.dsh-wt/race-2'], 'one wins the base name, the other retries to -2')
  assert.equal(a.branch !== b.branch, true, 'distinct branches')
  await tools.git_worktree_remove.execute({ path: join(repo, '.dsh-wt', 'race') }, exec)
  await tools.git_worktree_remove.execute({ path: join(repo, '.dsh-wt', 'race-2') }, exec)
})

t('status: dirty matrix — staged, unstaged, untracked, renamed, deleted', async () => {
  // committed baseline
  writeFileSync(join(repo, 'staged.txt'), 's\n')
  writeFileSync(join(repo, 'unstaged.txt'), 'u1\n')
  writeFileSync(join(repo, 'rename-src.txt'), 'r\n')
  writeFileSync(join(repo, 'deleted.txt'), 'd\n')
  git(repo, 'add', 'staged.txt', 'unstaged.txt', 'rename-src.txt', 'deleted.txt')
  git(repo, 'commit', '-q', '-m', 'dirty setup')
  // five independent dirty states
  writeFileSync(join(repo, 'staged.txt'), 's2\n')
  git(repo, 'add', 'staged.txt')                        // staged modification  -> "M  staged.txt"
  writeFileSync(join(repo, 'unstaged.txt'), 'u2\n')     // unstaged modification -> " M unstaged.txt"
  writeFileSync(join(repo, 'untracked.txt'), 'x\n')     // untracked             -> "?? untracked.txt"
  git(repo, 'mv', 'rename-src.txt', 'renamed.txt')      // staged rename         -> "R  rename-src.txt -> renamed.txt"
  const { rmSync } = await import('node:fs')
  rmSync(join(repo, 'deleted.txt'), { force: true })    // unstaged deletion     -> " D deleted.txt"
  const r = await tools.git_repo_status.execute({}, exec)
  assert.equal(r.clean, false)
  assert.ok(r.entries.some((e) => e.x === 'M' && e.y === ' ' && e.path === 'staged.txt'), 'staged modification')
  assert.ok(r.entries.some((e) => e.x === ' ' && e.y === 'M' && e.path === 'unstaged.txt'), 'unstaged modification')
  assert.ok(r.entries.some((e) => e.x === '?' && e.y === '?' && e.path === 'untracked.txt'), 'untracked')
  assert.ok(r.entries.some((e) => e.x === 'R' && e.path === 'rename-src.txt -> renamed.txt'), 'renamed')
  assert.ok(r.entries.some((e) => e.x === ' ' && e.y === 'D' && e.path === 'deleted.txt'), 'deleted')
  // restore a clean tree (git clean needs -d: empty untracked dirs like
  // the .dsh-wt/ parent left by earlier worktree removals are directories)
  git(repo, 'reset', '-q', '--hard', 'HEAD')
  git(repo, 'clean', '-f', '-d', '-q')
  assert.equal((await tools.git_repo_status.execute({}, exec)).clean, true, 'cleanup restored a clean tree')
})

t('add: a nonexistent commitIsh surfaces git\'s failure (branch left behind is git\'s artifact)', async () => {
  await rejects(
    tools.git_worktree_add.execute({ name: 'badish', newBranch: 'badish-b', commitIsh: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }, exec),
    /invalid reference|unknown revision|not a valid/i,
    'nonexistent commitIsh is refused',
  )
})

t('add: name and path together — path wins (documented precedence)', async () => {
  const explicit = join(root, 'both-given')
  const r = await tools.git_worktree_add.execute({ name: 'ignored', path: explicit, newBranch: 'both-b' }, exec)
  // the returned absolutePath is the caller's own path form (absolute args
  // pass through untouched); the worktree itself lives at the canonical form
  assert.equal(r.absolutePath, explicit, 'explicit path takes precedence over name')
  const list = await tools.git_worktree_list.execute({}, exec)
  assert.ok(list.worktrees.some((w) => w.absolutePath === canonicalize(explicit)), 'worktree created at the explicit path')
  assert.ok(!list.worktrees.some((w) => w.path.includes('ignored')), 'no worktree created for the ignored name')
  await tools.git_worktree_remove.execute({ path: explicit }, exec)
})

// ── AC4: fresh-name branch semantics ────────────────────────────────────────

t('add: name-based auto mode never reuses an existing branch; unique suffixes a NEW branch', async () => {
  const br = makeRepo(root, 'branch-sem')
  git(br, 'branch', 'feature') // feature at the initial commit (A)
  const A = git(br, 'rev-parse', 'feature').toString().trim()
  commitFile(br, 'b.txt', 'b\n', 'second') // main advances to B
  const B = git(br, 'rev-parse', 'HEAD').toString().trim()
  assert.notEqual(A, B)

  const r = await tools.git_worktree_add.execute({ repo: br, name: 'feature', unique: true }, execAt(br))
  assert.equal(r.branch, 'feature-2', 'collision created a NEW suffixed branch')
  const wtDir = join(br, '.dsh-wt', 'feature-2')
  assert.equal(git(wtDir, 'rev-parse', 'HEAD').toString().trim(), B, 'new branch starts at main HEAD, not the reused branch')
  assert.equal(git(br, 'rev-parse', 'feature').toString().trim(), A, 'the existing branch is untouched')
  await tools.git_worktree_remove.execute({ repo: br, path: wtDir }, execAt(br))

  // unique:false → strict failure instead of silently checking out the branch
  await rejects(
    tools.git_worktree_add.execute({ repo: br, name: 'feature' }, execAt(br)),
    /already exists|already used/,
    'non-unique name-based add fails rather than reuse an unchecked-out branch',
  )
  // --force must not bypass fresh-branch creation in auto-name mode
  await rejects(
    tools.git_worktree_add.execute({ repo: br, name: 'feature', force: true }, execAt(br)),
    /already exists|already used/,
    'force does not produce a shared-branch worktree',
  )
})

t('add: fresh / explicit-branch / newBranch-conflict / detach / commitIsh keep their semantics', async () => {
  const br = makeRepo(root, 'branch-modes')
  git(br, 'branch', 'existing')
  const E = git(br, 'rev-parse', 'existing').toString().trim()

  const fresh = await tools.git_worktree_add.execute({ repo: br, name: 'fresh' }, execAt(br))
  assert.equal(fresh.branch, 'fresh', 'normal fresh branch creation')

  await rejects(
    tools.git_worktree_add.execute({ repo: br, name: 'nb', newBranch: 'existing' }, execAt(br)),
    /already exists/,
    'explicit newBranch conflict stays git\'s strict failure',
  )

  const reuse = await tools.git_worktree_add.execute({ repo: br, name: 'reuse', branch: 'existing' }, execAt(br))
  assert.equal(reuse.branch, 'existing', 'explicit branch reuse preserved')
  assert.equal(git(join(br, '.dsh-wt', 'reuse'), 'rev-parse', 'HEAD').toString().trim(), E)

  const det = await tools.git_worktree_add.execute({ repo: br, name: 'det', detach: true }, execAt(br))
  assert.equal(det.detached, true)
  assert.equal(det.branch, null)

  const ci = await tools.git_worktree_add.execute({ repo: br, name: 'ci', commitIsh: E }, execAt(br))
  assert.equal(ci.detached, true, 'commitIsh without newBranch is a detached worktree')
  assert.equal(git(join(br, '.dsh-wt', 'ci'), 'rev-parse', 'HEAD').toString().trim(), E)

  for (const name of ['fresh', 'reuse', 'det', 'ci']) {
    await tools.git_worktree_remove.execute({ repo: br, path: join(br, '.dsh-wt', name) }, execAt(br))
  }
})

t('add: concurrent identical name+unique requests never share a branch', async () => {
  const br = makeRepo(root, 'branch-race')
  const [a, b] = await Promise.all([
    tools.git_worktree_add.execute({ repo: br, name: 'race', unique: true }, execAt(br)),
    tools.git_worktree_add.execute({ repo: br, name: 'race', unique: true }, execAt(br)),
  ])
  assert.deepEqual([a.path, b.path].sort(), ['.dsh-wt/race', '.dsh-wt/race-2'], 'base name and deduped sibling')
  assert.notEqual(a.branch, b.branch, 'distinct branches (no shared-branch race)')
  assert.equal(
    git(br, 'rev-parse', a.branch).toString().trim(),
    git(br, 'rev-parse', b.branch).toString().trim(),
    'both fresh branches point at the same main HEAD',
  )
  await tools.git_worktree_remove.execute({ repo: br, path: join(br, '.dsh-wt', 'race') }, execAt(br))
  await tools.git_worktree_remove.execute({ repo: br, path: join(br, '.dsh-wt', 'race-2') }, execAt(br))
})

// ── AC5: local info/exclude for the name-based parent ───────────────────────

const excludeOf = (dir) => join(
  git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir').toString().trim(),
  'info',
  'exclude',
)
const readExclude = (dir) => {
  try { return readFileSync(excludeOf(dir), 'utf8') } catch { return null }
}
const countRule = (content, rule) => content.split(/\r?\n/).filter((line) => line === rule).length

t('exclude: a name-based worktree keeps main clean and git add -A stages no gitlink', async () => {
  const ex = makeRepo(root, 'exclude-clean')
  await tools.git_worktree_add.execute({ repo: ex, name: 'wt' }, execAt(ex))
  assert.equal(git(ex, 'status', '--short').toString().trim(), '', 'clean main after a nested name-based worktree')
  const content = readExclude(ex)
  assert.equal(countRule(content, '/.dsh-wt/'), 1, 'the anchored local rule is present exactly once')

  writeFileSync(join(ex, 'unrelated.txt'), 'x\n')
  git(ex, 'add', '-A')
  const staged = git(ex, 'diff', '--cached', '--name-only').toString()
  assert.ok(staged.includes('unrelated.txt'), 'unrelated dirty files still staged')
  assert.ok(!staged.includes('.dsh-wt'), 'the nested worktree is NOT staged as a gitlink')
  await tools.git_worktree_remove.execute({ repo: ex, path: join(ex, '.dsh-wt', 'wt') }, execAt(ex))
})

t('exclude: idempotent, preserves existing bytes, and survives concurrent creation', async () => {
  const ex = makeRepo(root, 'exclude-idem')
  const file = excludeOf(ex)
  writeFileSync(file, 'custom-rule')
  await tools.git_worktree_add.execute({ repo: ex, name: 'one' }, execAt(ex))
  let content = readFileSync(file, 'utf8')
  assert.ok(content.startsWith('custom-rule\n'), 'existing bytes preserved and newline-separated')
  assert.equal(countRule(content, '/.dsh-wt/'), 1, 'one rule after the first create')
  await tools.git_worktree_add.execute({ repo: ex, name: 'two' }, execAt(ex))
  content = readFileSync(file, 'utf8')
  assert.ok(content.startsWith('custom-rule\n'), 'custom rule still first')
  assert.equal(countRule(content, '/.dsh-wt/'), 1, 'idempotent — no duplicate on the second create')

  const race = makeRepo(root, 'exclude-race')
  await Promise.all([
    tools.git_worktree_add.execute({ repo: race, name: 'a' }, execAt(race)),
    tools.git_worktree_add.execute({ repo: race, name: 'b' }, execAt(race)),
  ])
  const raceContent = readFileSync(excludeOf(race), 'utf8')
  assert.equal(countRule(raceContent, '/.dsh-wt/'), 1, 'concurrent creates leave exactly one rule')
})

t('exclude: an empty/non-newline exclude file is handled; a linked worktree writes the shared file', async () => {
  const ex = makeRepo(root, 'exclude-bytes')
  const file = excludeOf(ex)
  writeFileSync(file, '')
  await tools.git_worktree_add.execute({ repo: ex, name: 'wt' }, execAt(ex))
  assert.equal(readFileSync(file, 'utf8'), '/.dsh-wt/\n', 'empty file gains exactly the rule')

  // creating from INSIDE the linked worktree still targets the main root and
  // the shared common-dir exclude
  const wt = join(ex, '.dsh-wt', 'wt')
  await tools.git_worktree_add.execute({ repo: ex, name: 'from-linked' }, execAt(wt))
  assert.equal(countRule(readFileSync(file, 'utf8'), '/.dsh-wt/'), 1, 'shared exclude, still one rule')
  assert.equal(git(ex, 'status', '--short').toString().trim(), '', 'main stays clean')
})

t('exclude: configured parent with spaces and metacharacters', async () => {
  for (const [label, dirName, rule] of [['spaces', 'my wt', '/my wt/'], ['metachar', 'we[i]rd', '/we\\[i\\]rd/']]) {
    const ex = makeRepo(root, `exclude-${label}`)
    const plugin = await bootPlugin({ caps: { worktreesDir: dirName } })
    await plugin.tools.git_worktree_add.execute({ repo: ex, name: 'wt' }, execAt(ex))
    const content = readExclude(ex)
    assert.equal(countRule(content, rule), 1, `${label}: escaped anchored rule written`)
    assert.equal(git(ex, 'status', '--short').toString().trim(), '', `${label}: main stays clean`)
    git(ex, 'add', '-A')
    assert.ok(!git(ex, 'diff', '--cached', '--name-only').toString().includes(dirName), `${label}: worktree not staged`)
  }
})

t('exclude: a contained parent whose name starts with ".." is still ignored', async () => {
  // The traversal check must be segment-aware: "..worktrees" is a valid
  // INSIDE-root directory name, not a parent escape.
  const ex = makeRepo(root, 'exclude-dotdot')
  const plugin = await bootPlugin({ caps: { worktreesDir: '..worktrees' } })
  const made = await plugin.tools.git_worktree_add.execute({ repo: ex, name: 'wt' }, execAt(ex))
  assert.ok(made.absolutePath.includes('..worktrees'), 'worktree created under the contained ..-prefixed parent')
  assert.equal(countRule(readExclude(ex), '/..worktrees/'), 1, 'anchored rule written for the contained parent')
  assert.equal(git(ex, 'status', '--short').toString().trim(), '', 'main stays clean')
})

t('exclude: explicit paths and outside-repo parents get no unrelated ignore edits', async () => {
  const ex = makeRepo(root, 'exclude-explicit')
  const before = readExclude(ex)
  const outside = join(root, 'exclude-explicit-wt')
  await tools.git_worktree_add.execute({ repo: ex, path: outside, newBranch: 'exp-b' }, execAt(ex))
  assert.equal(readExclude(ex), before, 'explicit path does not edit info/exclude')
  await tools.git_worktree_remove.execute({ repo: ex, path: outside }, execAt(ex))

  const outsideParent = join(root, 'exclude-outside-parent')
  const plugin = await bootPlugin({ caps: { worktreesDir: outsideParent } })
  const before2 = readExclude(ex)
  const made = await plugin.tools.git_worktree_add.execute({ repo: ex, name: 'out' }, execAt(ex))
  assert.ok(made.absolutePath.startsWith(outsideParent), 'worktree lives under the outside parent')
  assert.equal(readExclude(ex), before2, 'an outside-repo parent gets no ignore edit')
  await plugin.tools.git_worktree_remove.execute({ repo: ex, path: made.absolutePath }, execAt(ex))
})

t('exclude: a write failure is reported, never a silent unprotected success', async () => {
  const ex = makeRepo(root, 'exclude-fail')
  const file = excludeOf(ex)
  // git can still READ the exclude file, so the worktree creation succeeds;
  // the plugin's APPEND then fails with EACCES and must surface the
  // unprotected worktree instead of returning a silent success.
  chmodSync(file, 0o444)
  await rejects(
    tools.git_worktree_add.execute({ repo: ex, name: 'wt' }, execAt(ex)),
    /local git exclusion could not be installed/,
    'the unprotected worktree is reported instead of a silent success',
  )
  chmodSync(file, 0o644)
})

// ── AC3: same-host occupancy guard (native agents registry) ─────────────────

t('occupancy: a missing agents service keeps the binding usable (honest limitation)', async () => {
  const r = await tools.git_session_binding.execute({}, execAt(repo))
  assert.equal(r.notARepo, false, 'no agents service → binding still resolves')
})

t('occupancy: caller ignored; running peer/child reported; idle peer not; longest-match separation', async () => {
  const occ = makeRepo(root, 'occ')
  const live = []
  const plugin = await bootPlugin({ agents: makeAgents(live) })
  const occTools = plugin.tools
  const wt = join(occ, '.dsh-wt', 'occ-wt')
  await occTools.git_worktree_add.execute({ repo: occ, name: 'occ-wt' }, execAt(occ))
  const deep = join(wt, 'deep')
  mkdirSync(deep, { recursive: true })

  live.length = 0
  live.push({ id: 'me', status: 'running', cwd: wt })
  let r = await occTools.git_session_binding.execute({}, execAt(wt, 'me'))
  assert.equal(r.bound, true, 'the caller itself is ignored')

  live.push({ id: 'other', status: 'running', cwd: wt })
  await rejects(occTools.git_session_binding.execute({}, execAt(wt, 'me')), /occupied by running agent/, 'running peer reported')
  await rejects(occTools.git_repo_status.execute({}, execAt(wt, 'me')), /occupied by running agent/, 'repo_status binding carries the same occupancy error')

  live[1].status = 'idle'
  r = await occTools.git_session_binding.execute({}, execAt(wt, 'me'))
  assert.equal(r.bound, true, 'an idle peer is not misrepresented as actively writing')

  live[1].status = 'running'
  live[1].cwd = deep
  await rejects(occTools.git_session_binding.execute({}, execAt(wt, 'me')), /occupied by running agent/, 'nested child cwd resolves to the same worktree')

  const docs = join(occ, 'docs')
  mkdirSync(docs, { recursive: true })
  live[1].cwd = docs
  r = await occTools.git_session_binding.execute({}, execAt(wt, 'me'))
  assert.equal(r.bound, true, 'a main-repo subdir writer does not occupy the linked worktree')
  await rejects(occTools.git_session_binding.execute({}, execAt(occ, 'me')), /occupied by running agent/, 'the primary worktree is occupied separately')

  live.length = 0
  await occTools.git_worktree_remove.execute({ repo: occ, path: wt }, execAt(occ, 'me'))
})

t('occupancy: worktreeRemove refuses a running occupant — caller included — even with force', async () => {
  const occ = makeRepo(root, 'occ-remove')
  const live = []
  const plugin = await bootPlugin({ agents: makeAgents(live) })
  const occTools = plugin.tools
  const wt = join(occ, '.dsh-wt', 'victim')
  await occTools.git_worktree_add.execute({ repo: occ, name: 'victim' }, execAt(occ))
  live.push({ id: 'me', status: 'running', cwd: wt })
  await rejects(
    occTools.git_worktree_remove.execute({ repo: occ, path: wt, force: true }, execAt(occ, 'me')),
    /refusing to remove worktree .*running agent/,
    'the caller occupant is refused even with force',
  )
  live.length = 0
  const removed = await occTools.git_worktree_remove.execute({ repo: occ, path: wt }, execAt(occ))
  assert.equal(removed.removed, '.dsh-wt/victim')
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
