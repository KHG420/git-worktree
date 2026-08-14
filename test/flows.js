/**
 * Real-user-operation flow tests: script the exact sequences a user drives
 * through the panel and the agent tools, against real git scratch repos.
 *
 * Panel flows mirror client.js's wiring: `POST add (unique)` → the
 * openBoundSession inject face (`workspaces.create` → `connectWorkspace` →
 * `sessions.open`) → `GET list` → `POST remove` (+ archive). Agent flows
 * mirror the tool docs: `git_session_binding` first, then create/list/remove.
 *
 * Run: node test/flows.js
 */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootPlugin, execAt, git, makeRepo, scratchRoot } from './helpers.js'
import { canonicalize } from '../lib/git.js'

let passed = 0
const tests = []
const t = (name, fn) => tests.push([name, fn])

const root = scratchRoot('dsh-gw-flows')
const repo = makeRepo(root, 'repo')

// The panel's route + inject faces against the REAL ops. The workspaces
// service is faked at the same surface the real one exposes.
function makePanel(plugin) {
  const sessions = { opened: [] }
  const workspaces = {
    created: [],
    connected: [],
    archived: [],
    async create({ path }) {
      const workspace = { workspaceId: `w-${this.created.length + 1}`, path }
      this.created.push(workspace)
      return workspace
    },
    async connectWorkspace(workspaceId) {
      this.connected.push(workspaceId)
      return `s-${this.connected.length}`
    },
    async archiveSession(id) {
      this.archived.push(id)
    },
  }
  const openBoundSession = async (path) => {
    try {
      const workspace = await workspaces.create({ path })
      const sessionId = await workspaces.connectWorkspace(workspace.workspaceId)
      sessions.opened.push(sessionId) // sessions.open in the real client
      return { ok: true, sessionId }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }
  const route = async (action, payload) => {
    const handler = plugin.routes[0].handler
    return new Promise((resolve, reject) => {
      const listeners = {}
      const req = {
        method: action === 'list' || action === 'status' ? 'GET' : 'POST',
        url: action === 'list' || action === 'status'
          ? `/dsh-git-worktree/${action}?repo=${encodeURIComponent(payload.repo ?? '')}`
          : `/dsh-git-worktree/${action}`,
        on: (ev, fn) => { (listeners[ev] ??= []).push(fn); return req },
        destroy: () => {},
      }
      const res = {
        writeHead: (status, headers) => { res.status = status; res.headers = headers },
        end: (body) => resolve({ status: res.status, payload: body === undefined ? '' : JSON.parse(body) }),
      }
      handler(req, res).catch(reject)
      if (action !== 'list' && action !== 'status') {
        for (const fn of listeners.data ?? []) fn(Buffer.from(JSON.stringify(payload)))
        for (const fn of listeners.end ?? []) fn()
      }
    })
  }
  return { openBoundSession, route, workspaces, sessions }
}

// ── FLOW 1: one-click bound conversation (panel) ────────────────────────────
t('flow: one-click bound conversation — add(unique) → workspace → session → bound', async () => {
  const plugin = await bootPlugin()
  const panel = makePanel(plugin)
  const exec = execAt(repo)

  // the panel's doCreate sequence
  const created = await panel.route('add', { repo, name: 'feature-flow', unique: true })
  assert.equal(created.status, 200)
  assert.equal(created.payload.data.branch, 'feature-flow')
  const absolutePath = created.payload.data.absolutePath
  assert.ok(absolutePath.endsWith('/.dsh-wt/feature-flow'), 'worktree under the repo')

  const opened = await panel.openBoundSession(absolutePath)
  assert.equal(opened.ok, true)
  assert.equal(panel.workspaces.created[0].path, absolutePath, 'workspace registered at the worktree')
  assert.equal(panel.workspaces.connected.length, 1, 'workspace connected')
  assert.equal(panel.sessions.opened.length, 1, 'session opened')

  // the new conversation's workspace is the worktree → the binding holds
  const binding = await plugin.tools.git_session_binding.execute({}, execAt(absolutePath))
  assert.equal(binding.bound, true, 'conversation inside the worktree is bound')
  assert.equal(binding.worktree.branch, 'feature-flow')

  // the panel refresh sees the new worktree + binding
  const list = await panel.route('list', { repo })
  assert.equal(list.status, 200)
  assert.ok(list.payload.data.worktrees.some((w) => w.absolutePath === canonicalize(absolutePath)))

  // cleanup: remove (the session was "archived" first in the real flow)
  await panel.workspaces.archiveSession(opened.sessionId)
  const removed = await panel.route('remove', { repo, path: absolutePath })
  assert.equal(removed.status, 200)
  assert.equal(git(repo, 'worktree', 'list', '--porcelain').toString().includes('feature-flow'), false)
  assert.ok(git(repo, 'branch', '--list', 'feature-flow').toString().includes('feature-flow'),
    'branch survives worktree removal (by design)')
})

// ── FLOW 2: agent prepares → developer opens (bound session) ───────────────
t('flow: agent creates the worktree, panel opens a bound session on it', async () => {
  const plugin = await bootPlugin()
  const panel = makePanel(plugin)
  const exec = execAt(repo)

  // agent: start-of-conversation binding check, then prepare a worktree
  const start = await plugin.tools.git_session_binding.execute({}, exec)
  assert.equal(start.bound, false)
  assert.equal(start.worktree.primary, true)

  const made = await plugin.tools.git_worktree_add.execute({ name: 'prepared', newBranch: 'prepared-b' }, exec)
  assert.equal(made.branch, 'prepared-b')
  const wt = canonicalize(join(repo, '.dsh-wt', 'prepared'))

  // developer: sees it in the panel and clicks 打开绑定会话
  const list = await panel.route('list', { repo })
  const row = list.payload.data.worktrees.find((w) => w.absolutePath === wt)
  assert.ok(row, 'prepared worktree listed')
  assert.equal(row.primary, false)

  const opened = await panel.openBoundSession(wt)
  assert.equal(opened.ok, true)

  const binding = await plugin.tools.git_session_binding.execute({}, execAt(wt))
  assert.equal(binding.bound, true)
  assert.equal(binding.worktree.branch, 'prepared-b')

  await plugin.tools.git_worktree_remove.execute({ path: wt }, exec)
})

// ── FLOW 3: full lifecycle — dirty worktree, force remove + archive ─────────
t('flow: dirty bound worktree is force-removed with archive; bindings degrade per-row', async () => {
  const plugin = await bootPlugin()
  const panel = makePanel(plugin)
  const exec = execAt(repo)

  const created = await panel.route('add', { repo, name: 'lifecycle', unique: true })
  const wt = created.payload.data.absolutePath
  await panel.openBoundSession(wt)
  writeFileSync(join(wt, 'uncommitted.txt'), 'dirty\n') // agent left work uncommitted

  // plain remove is refused (git protects the dirty worktree)
  const refused = await panel.route('remove', { repo, path: wt })
  assert.equal(refused.status, 400)

  // user checks "archive these sessions" and force-removes
  await panel.workspaces.archiveSession('s-1')
  const removed = await panel.route('remove', { repo, path: wt, force: true })
  assert.equal(removed.status, 200)

  // the session's cwd no longer exists → bindings degrade that row, not the batch
  const bindings = await panel.route('bindings', { paths: [repo, wt] })
  assert.equal(bindings.status, 200)
  const rows = bindings.payload.data.bindings
  assert.equal(rows.find((b) => b.path === repo).notARepo, false)
  const gone = rows.find((b) => b.path === wt)
  assert.equal(gone.notARepo, true, 'deleted worktree cwd degrades to notARepo per-row')
  assert.equal(gone.worktree, null)
})

// ── FLOW 4: cross-repo panel operation (server cwd ≠ target repo) ───────────
t('flow: panel creates a worktree in a foreign repo while the server runs elsewhere', async () => {
  const plugin = await bootPlugin()
  const panel = makePanel(plugin)
  const other = makeRepo(root, 'foreign')
  // exec is rooted at `repo`; the panel passes the foreign repo explicitly
  const created = await panel.route('add', { repo: other, name: 'cross', unique: true })
  assert.equal(created.status, 200)
  assert.ok(created.payload.data.absolutePath.startsWith(canonicalize(other)), 'worktree anchored to the FOREIGN repo root')
  const list = await panel.route('list', { repo: other })
  assert.equal(list.payload.data.worktrees.filter((w) => w.primary).length, 1, 'foreign primary flagged')
  await panel.route('remove', { repo: other, path: created.payload.data.absolutePath })
})

// ── FLOW 5: agent parallel-work loop (two bound conversations) ──────────────
t('flow: two bound conversations coexist without crossing; git refuses double-checkout', async () => {
  const plugin = await bootPlugin()
  const exec = execAt(repo)

  const a = await plugin.tools.git_worktree_add.execute({ name: 'conv-a', newBranch: 'conv-a' }, exec)
  const b = await plugin.tools.git_worktree_add.execute({ name: 'conv-b', newBranch: 'conv-b' }, exec)
  const wtA = canonicalize(join(repo, '.dsh-wt', 'conv-a'))
  const wtB = canonicalize(join(repo, '.dsh-wt', 'conv-b'))

  // each conversation is bound to its own worktree; peers visible to both
  const bindA = await plugin.tools.git_session_binding.execute({}, execAt(wtA))
  const bindB = await plugin.tools.git_session_binding.execute({}, execAt(wtB))
  assert.equal(bindA.bound, true)
  assert.equal(bindB.bound, true)
  assert.equal(bindA.worktree.absolutePath, wtA)
  assert.equal(bindB.worktree.absolutePath, wtB)
  assert.ok(bindA.peers.some((p) => p.absolutePath === wtB), 'A sees B as a peer')
  assert.ok(bindB.peers.some((p) => p.absolutePath === wtA), 'B sees A as a peer')

  // git refuses: A cannot check out B's branch (checked out in B's worktree)
  await assert.rejects(
    () => plugin.tools.git_branch_switch.execute({ name: 'conv-b' }, execAt(wtA)),
    (e) => /already used by worktree|checked out/i.test(e.message),
    'cross-worktree switch refused by git',
  )

  // cleanup both
  await plugin.tools.git_worktree_remove.execute({ path: wtA }, exec)
  await plugin.tools.git_worktree_remove.execute({ path: wtB }, exec)
  const final = await plugin.tools.git_worktree_list.execute({}, exec)
  assert.equal(final.worktrees.length, 1, 'only the primary remains')
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
console.log(`✅ flows: ${passed} assertions passed`)
