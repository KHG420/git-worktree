/**
 * Phase-2 task collaboration tests (B1–B6): the four `git_task_*` tools against
 * real scratch git repos with a contract-shaped fake native agent runtime
 * (`ctx.agents.create`, Agent.session/status/cancel/whenIdle, delegated policy
 * and composition helpers). Records, setup commands, cancellation, restart
 * reconciliation, sequential integration, conflict preservation, and
 * verification retries are all exercised for real; only the model turn is
 * simulated.
 *
 * Run: node test/tasks.js
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { canonicalize } from '../lib/git.js'
import { bootPlugin, commitFile, makeRepo, scratchRoot } from './helpers.js'

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
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const rev = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString().trim()

const root = scratchRoot('dsh-gw-tasks')

// ── contract-shaped fake child agent ────────────────────────────────────────

function fakeChildCtx() {
  return {
    get: () => undefined,
    systemPrompt: { context: () => {}, section: () => {}, getContextOrder: () => 0, getSectionOrder: () => 0 },
    tools: { restrict: () => {} },
  }
}

function emitTurn(events, kind) {
  events.push({ type: 'turn/start', data: { turn: 1 } })
  events.push({ type: 'step/start', data: { turn: 1 } })
  events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `outcome:${kind}` }] }, stream: [] } })
  events.push({ type: 'turn/end', data: { turn: 1, reason: { kind } } })
}

/** Commit a per-task scratch file so the recorded HEAD is a real commit. */
function defaultWork(child) {
  const file = `task-${child.cwd.split('/').pop()}.txt`
  writeFileSync(join(child.cwd, file), `${child.id}\n`)
  execFileSync('git', ['-C', child.cwd, 'add', file], { stdio: 'pipe' })
  execFileSync('git', ['-C', child.cwd, 'commit', '-m', `task ${child.id}`], { stdio: 'pipe' })
}

/**
 * Build a task harness: a fresh repo, a mutable running-agent registry, and a
 * child factory whose model turn is simulated. `options.work(child)` runs at
 * followup time; the default commits one scratch file per task.
 */
function makeHarness({ name = 'repo', caps = {}, outcome = 'completed', hold = false, holdFirst = false, work, policy = false, disposeFailures = 0, disposeHook = null } = {}) {
  const repo = makeRepo(root, `${name}-${Math.random().toString(36).slice(2, 8)}`)
  const children = []
  const running = []
  const appends = []
  let remainingDisposeFailures = disposeFailures
  const factory = {
    async create(opts) {
      const childCtx = fakeChildCtx()
      const events = []
      const child = {
        id: opts.sessionId,
        options: opts.agentOptions,
        cwd: opts.meta.cwd,
        disposed: false,
        cancelled: false,
        messages: [],
        session: {
          header: {
            id: opts.sessionId,
            cwd: opts.meta.cwd,
            parentSession: opts.parentAgent?.id,
            origin: 'subagent',
            delegationDepth: opts.meta.delegationDepth,
          },
          append: (type, data) => appends.push({ type, data, childId: opts.sessionId }),
          snapshotEvents: () => events,
        },
        ctx: childCtx,
        _settled: false,
        _idle: null,
        followup(message) {
          this.messages.push(message)
          ;(work ?? defaultWork)(this)
          if (hold || (holdFirst && children.length === 1)) {
            events.push({ type: 'turn/start', data: { turn: 1 } })
            events.push({ type: 'step/start', data: { turn: 1 } })
            return
          }
          if (outcome !== 'missing') emitTurn(events, outcome)
          this._settled = true
          this._idle?.()
        },
        whenIdle() {
          return this._settled ? Promise.resolve() : new Promise((resolve) => { this._idle = resolve })
        },
        cancel() {
          this.cancelled = true
          this._settled = true
          this._idle?.()
        },
      }
      opts.setup?.(childCtx, child)
      children.push(child)
      return {
        agent: child,
        dispose: async () => {
          if (remainingDisposeFailures > 0) {
            remainingDisposeFailures -= 1
            throw new Error('disposer boom')
          }
          if (disposeHook !== null) await disposeHook(child)
          child.disposed = true
        },
      }
    },
  }
  const registry = { list: () => running.map((row) => ({ id: row.id, status: row.status, session: { header: { cwd: row.cwd } } })) }
  const services = {}
  if (policy) {
    services.sandboxPolicy = { overrideOf: () => 'workspace-write' }
    services.approval = {}
  }
  const parentAgent = {
    id: 'parent',
    options: { provider: 'test-provider', model: 'test-model', reasoningEffort: 'low', maxTokens: 512 },
    session: { header: { id: 'parent', cwd: repo }, requestHeader: () => undefined },
    ctx: {
      get: (key) => (key === 'agents' ? registry : services[key]),
      agents: factory,
    },
  }
  const exec = { agent: parentAgent, signal: new AbortController().signal }
  return { repo, children, running, appends, registry, parentAgent, exec, caps, boot: null }
}

async function boot(h, capsOverride = {}) {
  h.boot = await bootPlugin({ agents: h.registry, caps: { ...h.caps, ...capsOverride } })
  return h.boot
}

async function settle(h, taskId, tries = 200) {
  for (let i = 0; i < tries; i += 1) {
    const { tasks } = await h.boot.tools.git_task_status.execute({ taskId }, h.exec)
    if (!['preparing', 'running'].includes(tasks[0].status)) return tasks[0]
    await delay(15)
  }
  throw new Error(`task ${taskId} did not settle`)
}

const taskFile = (repo, id) => join(repo, '.git', 'dsh-git-worktree', 'tasks', `${id}.json`)

// ── B1: isolated parallel starts, inheritance, service availability ─────────

t('B1: two starts from the same parent/name get distinct worktrees, branches, and cwds; model+depth inherited', async () => {
  const h = makeHarness({ name: 'b1a', policy: true })
  await boot(h)
  const [a, b] = await Promise.all([
    h.boot.tools.git_task_start.execute({ name: 'feat', prompt: 'task A' }, h.exec),
    h.boot.tools.git_task_start.execute({ name: 'feat', prompt: 'task B' }, h.exec),
  ])
  assert.notEqual(a.worktreePath, b.worktreePath, 'distinct worktrees')
  assert.notEqual(a.branch, b.branch, 'distinct branches')
  assert.equal(a.status, 'preparing', 'start returns promptly in preparing')

  const ta = await settle(h, a.taskId)
  const tb = await settle(h, b.taskId)
  assert.equal(ta.status, 'completed')
  assert.equal(tb.status, 'completed')
  assert.equal(h.children.length, 2)
  assert.deepEqual([...h.children.map((c) => c.session.header.cwd)].sort(), [ta.worktreePath, tb.worktreePath].sort())
  for (const child of h.children) {
    assert.equal(child.options.provider, 'test-provider', 'provider inherited')
    assert.equal(child.options.model, 'test-model', 'model inherited')
    assert.equal(child.options.subagentDepth, 1, 'child depth stamped')
  }
  // Delegated policy is pinned/composed: sandbox override carried, approval never.
  const sandbox = h.appends.filter((e) => e.type === 'sandbox/mode')
  const approval = h.appends.filter((e) => e.type === 'approval/policy')
  assert.ok(sandbox.length >= 2 && sandbox.every((e) => e.data.source === 'delegation'))
  assert.ok(approval.length >= 2 && approval.every((e) => e.data.policy === 'never'))

  // Both worktrees independently commit and stay isolated from the main tree.
  const mainClean = rev(h.repo, 'status', '--porcelain')
  assert.equal(mainClean, '', 'main worktree stays clean')
  assert.ok(rev(h.repo, 'branch', '--list', a.branch))
  assert.ok(rev(h.repo, 'branch', '--list', b.branch))
  assert.ok(ta.commit && tb.commit, 'both tasks recorded a commit')
})

t('B1: task_start fails clearly without an agents service; status fails clearly outside a repo', async () => {
  const h = makeHarness({ name: 'b1b' })
  await boot(h)
  const noAgents = { agent: { id: 'x', session: { header: { cwd: h.repo } }, ctx: { get: () => undefined } }, signal: new AbortController().signal }
  await rejects(
    h.boot.tools.git_task_start.execute({ name: 'x', prompt: 'p' }, noAgents),
    /native agents service|agents service/i,
    'no agents service is a clear refusal',
  )
  const nonRepo = join(root, `nonrepo-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(nonRepo, { recursive: true })
  await rejects(
    h.boot.tools.git_task_status.execute({}, { agent: { id: 'p', session: { header: { cwd: nonRepo } } }, signal: new AbortController().signal }),
    /not a git repository/i,
    'read lookup outside a repo is a clear error',
  )
})

t('B1: a task child is depth-capped and cannot start a nested task (no orphan worktree)', async () => {
  const h = makeHarness({ name: 'b1d' })
  await boot(h)
  const nestedParent = { ...h.parentAgent, options: { ...h.parentAgent.options, subagentDepth: 1 } }
  const nestedExec = { agent: nestedParent, signal: new AbortController().signal }
  await rejects(
    h.boot.tools.git_task_start.execute({ name: 'nested', prompt: 'p' }, nestedExec),
    /exceeds maxDepth/i,
    'a depth-1 task child cannot delegate again',
  )
  assert.equal(h.children.length, 0, 'no agent launched')
  assert.equal(existsSync(join(h.repo, '.dsh-wt')), false, 'refused start creates no worktree')
})

t('B1: `base` pins the fresh task branch to the requested commit', async () => {
  const h = makeHarness({ name: 'b1base', work: () => {} })
  const first = rev(h.repo, 'rev-parse', 'HEAD')
  const second = commitFile(h.repo, 'second.txt', 'second\n', 'second')
  assert.notEqual(first, second)
  await boot(h)
  const started = await h.boot.tools.git_task_start.execute({ name: 'based', prompt: 'p', base: first }, h.exec)
  assert.equal(started.base, first)
  assert.equal(rev(started.worktreePath, 'rev-parse', 'HEAD'), first, 'fresh branch starts at base')
  const done = await settle(h, started.taskId)
  assert.equal(done.status, 'completed')
  assert.equal(done.commit, first, 'recorded commit is the base when the child made no changes')
})

t('B1: the original 9 git tools and 4 task tools are all registered', async () => {
  const h = makeHarness({ name: 'b1c' })
  await boot(h)
  const names = Object.keys(h.boot.tools).sort()
  assert.deepEqual(names, [
    'git_branch_create', 'git_branch_delete', 'git_branch_list', 'git_branch_switch',
    'git_repo_status', 'git_session_binding',
    'git_task_cancel', 'git_task_integrate', 'git_task_start', 'git_task_status',
    'git_worktree_add', 'git_worktree_list', 'git_worktree_remove',
  ])
})

// ── B2: setup commands ──────────────────────────────────────────────────────

t('B2: a successful setup argv runs in the child cwd before the agent is created', async () => {
  const h = makeHarness({ name: 'b2a' })
  await boot(h, { setupCommands: [['node', '-e', 'require("fs").writeFileSync("setup.txt","ok")']] })
  let sawSetupAtCreate = null
  // The setup file must already exist when create() runs: record that.
  const factory = h.parentAgent.ctx.agents
  const originalCreate = factory.create
  factory.create = async (opts) => {
    sawSetupAtCreate = existsSync(join(opts.meta.cwd, 'setup.txt'))
    return originalCreate(opts)
  }
  const started = await h.boot.tools.git_task_start.execute({ name: 'setup-ok', prompt: 'p' }, h.exec)
  const done = await settle(h, started.taskId)
  assert.equal(done.status, 'completed')
  assert.equal(sawSetupAtCreate, true, 'setup ran before agent creation')
  assert.equal(readFileSync(join(started.worktreePath, 'setup.txt'), 'utf8'), 'ok')
  assert.equal(done.setup.ok, true)
})

t('B2: a failing setup command prevents launch and reports bounded diagnostics', async () => {
  const h = makeHarness({ name: 'b2b' })
  await boot(h, { setupCommands: [['node', '-e', 'process.stderr.write("boom"); process.exit(3)']] })
  const started = await h.boot.tools.git_task_start.execute({ name: 'setup-fail', prompt: 'p' }, h.exec)
  const done = await settle(h, started.taskId)
  assert.equal(done.status, 'setup_failed')
  assert.equal(h.children.length, 0, 'no agent launched')
  assert.ok(done.error.includes('boom') || done.error.includes('exited 3'), 'actionable error')
  assert.equal(done.setup.ok, false)
  assert.equal(done.setup.exitCode, 3)
  assert.ok(done.setup.output.length <= 8 * 1024 + 64, 'output bounded')
  assert.ok(existsSync(started.worktreePath), 'worktree preserved for diagnosis')
})

t('B2: a setup timeout fails the task before launch', async () => {
  const h = makeHarness({ name: 'b2c' })
  await boot(h, { timeoutMs: 250, setupCommands: [['node', '-e', 'setTimeout(() => {}, 60000)']] })
  const started = await h.boot.tools.git_task_start.execute({ name: 'setup-timeout', prompt: 'p' }, h.exec)
  const done = await settle(h, started.taskId)
  assert.equal(done.status, 'setup_failed')
  assert.equal(h.children.length, 0)
  assert.match(done.error, /timed out/)
})

t('B2: cancelling during setup stops the subprocess and never launches the child', async () => {
  const h = makeHarness({ name: 'b2d' })
  await boot(h, { setupCommands: [['node', '-e', 'setTimeout(() => {}, 60000)']] })
  const started = await h.boot.tools.git_task_start.execute({ name: 'setup-cancel', prompt: 'p' }, h.exec)
  await delay(60)
  const cancelled = await h.boot.tools.git_task_cancel.execute({ taskId: started.taskId }, h.exec)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(h.children.length, 0, 'child never launched')
  // The runtime settled the record durably.
  assert.equal((await h.boot.tools.git_task_status.execute({ taskId: started.taskId }, h.exec)).tasks[0].status, 'cancelled')
})

t('B2: default config runs no setup commands and never copies .env', async () => {
  const h = makeHarness({ name: 'b2e' })
  await boot(h)
  writeFileSync(join(h.repo, '.env'), 'SECRET=1\n')
  const started = await h.boot.tools.git_task_start.execute({ name: 'no-setup', prompt: 'p' }, h.exec)
  const done = await settle(h, started.taskId)
  assert.equal(done.status, 'completed')
  assert.equal(done.setup, null, 'no setup block when no commands configured')
  assert.equal(existsSync(join(started.worktreePath, '.env')), false, 'untracked .env is not copied')
})

t('B2: invalid setupCommands configuration is rejected at plugin load', async () => {
  const plugin = (await import('../index.js')).default
  assert.throws(() => plugin.Config({ setupCommands: [[]] }), /length >= 1/)
  assert.throws(() => plugin.Config({ setupCommands: [['']] }), /expected string/i)
  assert.throws(() => plugin.Config({ setupCommands: 'pnpm install' }), /array/i)
})

// ── B3: authoritative outcomes ──────────────────────────────────────────────

t('B3: a completed native turn => completed + summary + commit; handles disposed', async () => {
  const h = makeHarness({ name: 'b3a' })
  await boot(h)
  const started = await h.boot.tools.git_task_start.execute({ name: 'ok', prompt: 'p' }, h.exec)
  const done = await settle(h, started.taskId)
  assert.equal(done.status, 'completed')
  assert.equal(done.summary, 'outcome:completed')
  assert.equal(done.commit, rev(started.worktreePath, 'rev-parse', 'HEAD'))
  assert.equal(h.children[0].disposed, true, 'child handle disposed')
})

for (const [outcome, expected] of [['error', 'failed'], ['blocked', 'failed'], ['aborted', 'cancelled'], ['missing', 'failed']]) {
  t(`B3: ${outcome} turn-end is non-success (${expected})`, async () => {
    const h = makeHarness({ name: `b3-${outcome}`, outcome })
    await boot(h)
    const started = await h.boot.tools.git_task_start.execute({ name: outcome, prompt: 'p' }, h.exec)
    const done = await settle(h, started.taskId)
    assert.equal(done.status, expected)
    assert.equal(done.commit, null, 'no success commit on a non-success outcome')
    if (outcome === 'missing') assert.match(done.error, /missing|invalid turn-end/i)
    assert.equal(h.children[0].disposed, true)
  })
}

t('B3: cancelling a running task drains it, persists cancelled, and disposes the child', async () => {
  const h = makeHarness({ name: 'b3-cancel', hold: true })
  await boot(h)
  const started = await h.boot.tools.git_task_start.execute({ name: 'cancel', prompt: 'p' }, h.exec)
  await delay(40)
  const cancelled = await h.boot.tools.git_task_cancel.execute({ taskId: started.taskId }, h.exec)
  assert.equal(cancelled.cancelled, true)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(h.children[0].cancelled, true)
  assert.equal(h.children[0].disposed, true)
  // Idempotent on a finished task.
  const again = await h.boot.tools.git_task_cancel.execute({ taskId: started.taskId }, h.exec)
  assert.equal(again.status, 'cancelled')
  assert.match(again.message, /already finished/i)
})

t('B3: plugin teardown cancels and disposes owned children', async () => {
  const h = makeHarness({ name: 'b3-teardown', hold: true })
  await boot(h)
  const started = await h.boot.tools.git_task_start.execute({ name: 'teardown', prompt: 'p' }, h.exec)
  await delay(40)
  for (const dispose of h.boot.effects) await dispose()
  const final = (await h.boot.tools.git_task_status.execute({ taskId: started.taskId }, h.exec)).tasks[0]
  assert.equal(final.status, 'cancelled')
  assert.equal(h.children[0].disposed, true)
  assert.equal(h.children[0].cancelled, true)
})

// ── B4: persistence, restart reconciliation, validation ─────────────────────

t('B4: records are atomic per task and distinct concurrent tasks do not overwrite', async () => {
  const h = makeHarness({ name: 'b4a' })
  await boot(h)
  const a = await h.boot.tools.git_task_start.execute({ name: 'r1', prompt: 'p' }, h.exec)
  const b = await h.boot.tools.git_task_start.execute({ name: 'r2', prompt: 'p' }, h.exec)
  await settle(h, a.taskId)
  await settle(h, b.taskId)
  assert.ok(existsSync(taskFile(h.repo, a.taskId)))
  assert.ok(existsSync(taskFile(h.repo, b.taskId)))
  const dir = join(h.repo, '.git', 'dsh-git-worktree', 'tasks')
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp files left behind')
  const parsed = JSON.parse(readFileSync(taskFile(h.repo, a.taskId), 'utf8'))
  assert.equal(parsed.version, 1)
  assert.equal(parsed.taskId, a.taskId)
})

t('B4: linked worktrees resolve the same records', async () => {
  const h = makeHarness({ name: 'b4b' })
  await boot(h)
  const a = await h.boot.tools.git_task_start.execute({ name: 'shared', prompt: 'p' }, h.exec)
  await settle(h, a.taskId)
  const fromLinked = await h.boot.tools.git_task_status.execute({ repo: a.worktreePath, taskId: a.taskId }, h.exec)
  assert.equal(fromLinked.tasks[0].taskId, a.taskId)
  assert.equal(fromLinked.tasks[0].status, 'completed')
})

t('B4: a dead owner marks an active record interrupted; a live foreign owner is preserved', async () => {
  const h = makeHarness({ name: 'b4c' })
  await boot(h)
  const dir = join(h.repo, '.git', 'dsh-git-worktree', 'tasks')
  mkdirSync(dir, { recursive: true })
  const base = {
    version: 1, name: 'ghost', repoRoot: canonicalize(h.repo), worktreePath: canonicalize(join(h.repo, '.dsh-wt', 'ghost')),
    branch: 'ghost', base: null, status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    parentSessionId: 'parent', sessionId: 'dead', summary: null, commit: null, error: null, setup: null, integration: null,
  }
  const deadId = 'task-000000000000dead'
  writeFileSync(taskFile(h.repo, deadId), JSON.stringify({ ...base, taskId: deadId, owner: { pid: 2147483647, startedAt: 0 } }))
  const foreignId = 'task-000000000000beef'
  writeFileSync(taskFile(h.repo, foreignId), JSON.stringify({ ...base, taskId: foreignId, owner: { pid: process.ppid, startedAt: 0 } }))

  const dead = (await h.boot.tools.git_task_status.execute({ taskId: deadId }, h.exec)).tasks[0]
  assert.equal(dead.status, 'interrupted', 'proven-dead owner is interrupted')
  const foreign = (await h.boot.tools.git_task_status.execute({ taskId: foreignId }, h.exec)).tasks[0]
  assert.equal(foreign.status, 'running', 'live foreign owner is not overwritten')
  // cancel refuses to signal the foreign live owner
  const cancellation = await h.boot.tools.git_task_cancel.execute({ taskId: foreignId }, h.exec)
  assert.equal(cancellation.cancelled, false)
  assert.match(cancellation.message, /another live DSH process/i)
})

t('B4: traversal ids and corrupt records return clear errors', async () => {
  const h = makeHarness({ name: 'b4d' })
  await boot(h)
  await rejects(h.boot.tools.git_task_status.execute({ taskId: '../../etc/passwd' }, h.exec), /invalid task id/i)
  await rejects(h.boot.tools.git_task_cancel.execute({ taskId: 'not-a-task' }, h.exec), /invalid task id/i)
  const corruptId = 'task-000000000000c0de'
  mkdirSync(join(h.repo, '.git', 'dsh-git-worktree', 'tasks'), { recursive: true })
  writeFileSync(taskFile(h.repo, corruptId), '{not json')
  await rejects(h.boot.tools.git_task_status.execute({ taskId: corruptId }, h.exec), /corrupt/i)
  await rejects(h.boot.tools.git_task_status.execute({ taskId: 'task-000000000000ffff' }, h.exec), /no task record/i)
})

// ── B5: integration ─────────────────────────────────────────────────────────

t('B5: two independently committed task branches integrate sequentially with real verification', async () => {
  const h = makeHarness({ name: 'b5a' })
  await boot(h)
  const a = await h.boot.tools.git_task_start.execute({ name: 'one', prompt: 'p' }, h.exec)
  const b = await h.boot.tools.git_task_start.execute({ name: 'two', prompt: 'p' }, h.exec)
  const ta = await settle(h, a.taskId)
  const tb = await settle(h, b.taskId)
  assert.equal(ta.status, 'completed')
  assert.equal(tb.status, 'completed')

  const verify = [['node', '-e', 'process.exit(0)']]
  const first = await h.boot.tools.git_task_integrate.execute({ taskId: a.taskId, verifyCommands: verify }, h.exec)
  assert.equal(first.verified, true)
  assert.equal(first.merged, true)
  assert.equal(first.status, 'verified')
  const second = await h.boot.tools.git_task_integrate.execute({ taskId: b.taskId, verifyCommands: verify }, h.exec)
  assert.equal(second.verified, true)
  assert.equal(second.merged, true)
  assert.ok(existsSync(join(h.repo, `task-${a.branch}.txt`)))
  assert.ok(existsSync(join(h.repo, `task-${b.branch}.txt`)))
  // source stays available
  assert.ok(existsSync(a.worktreePath) && existsSync(b.worktreePath))
  assert.ok(rev(h.repo, 'branch', '--list', a.branch))
})

t('B5: repeated integration does not duplicate the merge', async () => {
  const h = makeHarness({ name: 'b5b' })
  await boot(h)
  const a = await h.boot.tools.git_task_start.execute({ name: 'once', prompt: 'p' }, h.exec)
  await settle(h, a.taskId)
  await h.boot.tools.git_task_integrate.execute({ taskId: a.taskId, verifyCommands: [['node', '-e', 'process.exit(0)']] }, h.exec)
  const headAfterFirst = rev(h.repo, 'rev-parse', 'HEAD')
  const again = await h.boot.tools.git_task_integrate.execute({ taskId: a.taskId }, h.exec)
  assert.equal(again.merged, false, 'already-merged task is not merged again')
  assert.equal(rev(h.repo, 'rev-parse', 'HEAD'), headAfterFirst, 'no new commit')
})

t('B5: dirty/active sources, dirty targets, and source==target are rejected; the caller in the target is allowed', async () => {
  const h = makeHarness({ name: 'b5c' })
  await boot(h)
  const a = await h.boot.tools.git_task_start.execute({ name: 'guards', prompt: 'p' }, h.exec)
  await settle(h, a.taskId)

  // Caller occupies the target: allowed (its own target).
  h.running.push({ id: 'parent', status: 'running', cwd: canonicalize(h.repo) })
  const ok = await h.boot.tools.git_task_integrate.execute({ taskId: a.taskId, verifyCommands: [['node', '-e', 'process.exit(0)']] }, h.exec)
  assert.equal(ok.status, 'verified')
  h.running.length = 0

  // Another writer in the target: blocked.
  h.running.push({ id: 'other', status: 'running', cwd: canonicalize(h.repo) })
  await rejects(h.boot.tools.git_task_integrate.execute({ taskId: a.taskId }, h.exec), /occupied by running agent/i)
  h.running.length = 0

  // dirty target
  writeFileSync(join(h.repo, 'dirty.txt'), 'x')
  await rejects(h.boot.tools.git_task_integrate.execute({ taskId: a.taskId }, h.exec), /target worktree is dirty/i)
  execFileSync('git', ['-C', h.repo, 'clean', '-fd'], { stdio: 'pipe' })

  // source == target
  await rejects(h.boot.tools.git_task_integrate.execute({ repo: a.worktreePath, taskId: a.taskId }, h.exec), /same worktree/i)

  // dirty source
  writeFileSync(join(a.worktreePath, 'left.txt'), 'x')
  await rejects(h.boot.tools.git_task_integrate.execute({ taskId: a.taskId }, h.exec), /source worktree has uncommitted changes/i)
  execFileSync('git', ['-C', a.worktreePath, 'clean', '-fd'], { stdio: 'pipe' })

  // running source writer
  h.running.push({ id: 'writer', status: 'running', cwd: canonicalize(a.worktreePath) })
  await rejects(h.boot.tools.git_task_integrate.execute({ taskId: a.taskId }, h.exec), /source worktree .*running agent/i)
  h.running.length = 0

  // active (non-completed) task
  const active = makeHarness({ name: 'b5c-active', hold: true })
  await boot(active)
  const runningTask = await active.boot.tools.git_task_start.execute({ name: 'active', prompt: 'p' }, active.exec)
  await delay(30)
  await rejects(active.boot.tools.git_task_integrate.execute({ taskId: runningTask.taskId }, active.exec), /is running|only a completed task/i)
})

// ── B6: conflicts + verification retry ──────────────────────────────────────

t('B6: a real conflict is preserved for manual resolution and the retry verifies without re-merging', async () => {
  const sharedWork = (child) => {
    writeFileSync(join(child.cwd, 'shared.txt'), `${child.cwd.split('/').pop()}\n`)
    execFileSync('git', ['-C', child.cwd, 'add', 'shared.txt'], { stdio: 'pipe' })
    execFileSync('git', ['-C', child.cwd, 'commit', '-m', 'shared'], { stdio: 'pipe' })
  }
  // Seed shared.txt on main so both branches modify the same file.
  const h = makeHarness({ name: 'b6a', work: sharedWork })
  writeFileSync(join(h.repo, 'shared.txt'), 'base\n')
  execFileSync('git', ['-C', h.repo, 'add', 'shared.txt'], { stdio: 'pipe' })
  execFileSync('git', ['-C', h.repo, 'commit', '-m', 'base shared'], { stdio: 'pipe' })

  await boot(h)
  const a = await h.boot.tools.git_task_start.execute({ name: 'c-one', prompt: 'p' }, h.exec)
  await settle(h, a.taskId)
  const b = await h.boot.tools.git_task_start.execute({ name: 'c-two', prompt: 'p' }, h.exec)
  await settle(h, b.taskId)

  const first = await h.boot.tools.git_task_integrate.execute({ taskId: a.taskId }, h.exec)
  assert.equal(first.status, 'unverified', 'no commands => unverified')
  assert.equal(first.verified, false)
  const conflict = await h.boot.tools.git_task_integrate.execute({ taskId: b.taskId }, h.exec)
  assert.equal(conflict.status, 'conflicted')
  assert.equal(conflict.verified, false)
  assert.ok(conflict.conflicts.includes('shared.txt'))
  assert.match(conflict.message, /conflict/i)
  // conflict markers remain (no abort/reset)
  assert.match(rev(h.repo, 'status', '--porcelain'), /UU shared\.txt/)
  assert.ok(rev(h.repo, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'))

  // Manual resolution → commit → retry resumes verification (already merged).
  writeFileSync(join(h.repo, 'shared.txt'), 'resolved\n')
  execFileSync('git', ['-C', h.repo, 'add', 'shared.txt'], { stdio: 'pipe' })
  execFileSync('git', ['-C', h.repo, 'commit', '--no-edit', '-m', 'merge resolved'], { stdio: 'pipe' })
  const retry = await h.boot.tools.git_task_integrate.execute({ taskId: b.taskId, verifyCommands: [['node', '-e', 'process.exit(0)']] }, h.exec)
  assert.equal(retry.status, 'verified')
  assert.equal(retry.merged, false, 'retry does not create another merge')
})

t('B6: failed verification is unverified, and a retry reruns verification without re-merging even after the target advances', async () => {
  const h = makeHarness({ name: 'b6b' })
  await boot(h)
  const a = await h.boot.tools.git_task_start.execute({ name: 'verify', prompt: 'p' }, h.exec)
  await settle(h, a.taskId)

  const failed = await h.boot.tools.git_task_integrate.execute({ taskId: a.taskId, verifyCommands: [['node', '-e', 'process.exit(4)']] }, h.exec)
  assert.equal(failed.status, 'unverified')
  assert.equal(failed.verified, false)
  assert.equal(failed.verification.results[0].exitCode, 4)
  assert.equal(failed.verification.results[0].ok, false)
  const headAfterMerge = rev(h.repo, 'rev-parse', 'HEAD')

  // Target advances: a stale verification must never be reused.
  writeFileSync(join(h.repo, 'advance.txt'), 'advance\n')
  execFileSync('git', ['-C', h.repo, 'add', 'advance.txt'], { stdio: 'pipe' })
  execFileSync('git', ['-C', h.repo, 'commit', '-m', 'advance'], { stdio: 'pipe' })
  const advancedHead = rev(h.repo, 'rev-parse', 'HEAD')
  assert.notEqual(advancedHead, headAfterMerge)

  const retried = await h.boot.tools.git_task_integrate.execute({ taskId: a.taskId, verifyCommands: [['node', '-e', 'process.exit(0)']] }, h.exec)
  assert.equal(retried.status, 'verified')
  assert.equal(retried.verified, true)
  assert.equal(retried.merged, false, 'merge not repeated')
  assert.equal(retried.target.headAfter, advancedHead, 'verification ran against the advanced head')
})

t('B6: no verification commands integrates but is explicitly unverified', async () => {
  const h = makeHarness({ name: 'b6c' })
  await boot(h)
  const a = await h.boot.tools.git_task_start.execute({ name: 'noverify', prompt: 'p' }, h.exec)
  await settle(h, a.taskId)
  const integrated = await h.boot.tools.git_task_integrate.execute({ taskId: a.taskId }, h.exec)
  assert.equal(integrated.status, 'unverified')
  assert.equal(integrated.verified, false)
  assert.equal(integrated.verification, null)
  assert.match(integrated.message, /not independently verified/i)
})

// ── R-repairs: targeted regressions from the independent review ─────────────

t('R1-R4: explicit repo anchors the task; foreign status/cancel isolated; preparing worktree guarded', async () => {
  const pending = [['node', '-e', 'setTimeout(() => {}, 60000)']]
  const h = makeHarness({ name: 'scope-owner', caps: { setupCommands: pending, timeoutMs: 65000 } })
  await boot(h)
  const b = makeRepo(root, `scope-target-${Math.random().toString(36).slice(2, 8)}`)
  const started = await h.boot.tools.git_task_start.execute({ name: 'scoped', prompt: 'p', repo: b }, h.exec)
  assert.ok(typeof started.worktreePath === 'string' && !relative(b, started.worktreePath).startsWith('..'),
    'worktree is anchored in the requested repository')
  const list = await h.boot.tools.git_task_status.execute({ repo: h.repo }, h.exec)
  assert.ok(!list.tasks.some((task) => task.taskId === started.taskId), 'status does not mix tasks from another repository')
  await rejects(
    h.boot.tools.git_task_cancel.execute({ repo: h.repo, taskId: started.taskId }, h.exec),
    /no task record/i,
    'wrong-repo cancel is rejected before touching the task',
  )
  const foreign = (await h.boot.tools.git_task_status.execute({ repo: b, taskId: started.taskId }, h.exec)).tasks[0]
  assert.equal(foreign.status, 'preparing', 'foreign cancel left the task untouched')
  await rejects(
    h.boot.tools.git_worktree_remove.execute({ repo: b, path: started.worktreePath, force: true }, h.exec),
    /live git_task_\* task owns it/i,
    'a preparing task worktree cannot be removed, even with force',
  )
  await h.boot.tools.git_task_cancel.execute({ repo: b, taskId: started.taskId }, h.exec)
})

t('R5: verification that modifies a tracked target file is unverified and preserved', async () => {
  const h = makeHarness({ name: 'r5-mutation' })
  await boot(h)
  const a = await h.boot.tools.git_task_start.execute({ name: 'mut', prompt: 'p' }, h.exec)
  await settle(h, a.taskId)
  const result = await h.boot.tools.git_task_integrate.execute({
    taskId: a.taskId,
    verifyCommands: [['node', '-e', "require('fs').writeFileSync('a.txt','changed by verification')"]],
  }, h.exec)
  assert.equal(result.verified, false, 'modified tracked file cannot certify')
  assert.equal(result.status, 'unverified')
  assert.match(result.message, /altered the target worktree/i)
  assert.equal(readFileSync(join(h.repo, 'a.txt'), 'utf8'), 'changed by verification', 'change preserved, not reset')
})

t('R6: parent lifetime disposal cancels an in-flight preparing task', async () => {
  const h = makeHarness({ name: 'r6-parent', caps: { setupCommands: [['node', '-e', 'setTimeout(() => {}, 60000)']] } })
  const disposers = []
  h.parentAgent.ctx.effect = (fn) => {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  }
  await boot(h)
  const started = await h.boot.tools.git_task_start.execute({ name: 'prepare', prompt: 'p' }, h.exec)
  await delay(60)
  for (const dispose of disposers) await dispose()
  const state = (await h.boot.tools.git_task_status.execute({ taskId: started.taskId }, h.exec)).tasks[0]
  assert.equal(state.status, 'cancelled', 'parent disposal cancels setup before agent creation')
  assert.equal(h.children.length, 0, 'no child launched after parent disposal')
})

t('R7: concurrent same-name, base-pinned starts both succeed with distinct worktrees/branches', async () => {
  const h = makeHarness({ name: 'r7-base', work: () => {} })
  const first = rev(h.repo, 'rev-parse', 'HEAD')
  commitFile(h.repo, 'second.txt', 'second\n', 'second')
  await boot(h)
  const [a, b] = await Promise.all([
    h.boot.tools.git_task_start.execute({ name: 'pinned', prompt: 'p', base: first }, h.exec),
    h.boot.tools.git_task_start.execute({ name: 'pinned', prompt: 'p', base: first }, h.exec),
  ])
  assert.notEqual(a.worktreePath, b.worktreePath, 'collision retried to distinct paths')
  assert.notEqual(a.branch, b.branch, 'collision retried to distinct branches')
  assert.equal(rev(a.worktreePath, 'rev-parse', 'HEAD'), first)
  assert.equal(rev(b.worktreePath, 'rev-parse', 'HEAD'), first)
  assert.ok(existsSync(a.worktreePath) && existsSync(b.worktreePath))
})

t('R8: concurrent integrations into one target serialize (no invalidated verification)', async () => {
  const h = makeHarness({ name: 'r8-lock' })
  await boot(h)
  const a = await h.boot.tools.git_task_start.execute({ name: 'lock-one', prompt: 'p' }, h.exec)
  await settle(h, a.taskId)
  const b = await h.boot.tools.git_task_start.execute({ name: 'lock-two', prompt: 'p' }, h.exec)
  await settle(h, b.taskId)

  // Marker lives OUTSIDE the target repo (an untracked file inside it would
  // legitimately make the target dirty for the second integrate call).
  const marker = join(root, `r8-verify-started-${Math.random().toString(36).slice(2, 8)}.txt`)
  const slowVerify = ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'1');const t=Date.now();while(Date.now()-t<700){}`]
  const first = h.boot.tools.git_task_integrate.execute({ taskId: a.taskId, verifyCommands: [slowVerify] }, h.exec)
  for (let i = 0; i < 300 && !existsSync(marker); i += 1) await delay(10)
  assert.ok(existsSync(marker), 'first verification started')
  const second = h.boot.tools.git_task_integrate.execute({ taskId: b.taskId, verifyCommands: [['node', '-e', 'process.exit(0)']] }, h.exec)
  const [ra, rb] = await Promise.all([first, second])
  assert.equal(ra.verified, true, 'first integration stays verified (no interleaved merge)')
  assert.equal(rb.verified, true, 'second integration verified')
  assert.equal(rb.target.headBefore, ra.target.headAfter, 'second began only after the first released the lock')
})

t('R9: a failed child disposal is honest, retains the reservation, and is drained by cancel', async () => {
  const h = makeHarness({ name: 'r9-dispose', disposeFailures: 1 })
  await boot(h)
  const started = await h.boot.tools.git_task_start.execute({ name: 'dispose', prompt: 'p' }, h.exec)
  const done = await settle(h, started.taskId)
  assert.equal(done.status, 'failed', 'uncompleted disposal is not a success')
  assert.match(done.error, /disposal failed/i)
  await rejects(
    h.boot.tools.git_worktree_remove.execute({ repo: h.repo, path: started.worktreePath, force: true }, h.exec),
    /live git_task_\* task owns it/i,
    'reservation retained while disposal is unfinished',
  )
  const cancelled = await h.boot.tools.git_task_cancel.execute({ taskId: started.taskId }, h.exec)
  assert.equal(h.children[0].disposed, true, 'cancel retried and completed disposal')
  assert.ok(['failed', 'cancelled'].includes(cancelled.status))
  const removed = await h.boot.tools.git_worktree_remove.execute({ repo: h.repo, path: started.worktreePath, force: true }, h.exec)
  assert.ok(removed.removed.length > 0, 'reservation released after successful drain')
})

t('R11: integrate refuses a source whose child disposal is still pending', async () => {
  let release
  const held = new Promise((resolve) => { release = resolve })
  let entered = false
  const h = makeHarness({
    name: 'r11-pending',
    disposeHook: async () => { entered = true; await held },
  })
  await boot(h)
  const started = await h.boot.tools.git_task_start.execute({ name: 'pending', prompt: 'p' }, h.exec)
  for (let i = 0; i < 200 && !entered; i += 1) await delay(10)
  assert.ok(entered, 'child disposal began')
  // The record is already `completed`, yet the undisposed child still owns the
  // worktree: integrating over it would race the pending drain.
  await rejects(
    h.boot.tools.git_task_integrate.execute({ taskId: started.taskId }, h.exec),
    /not been disposed|reserved/i,
    'a completed record whose drain is pending cannot be integrated',
  )
  release()
  await delay(50)
  const ok = await h.boot.tools.git_task_integrate.execute({
    taskId: started.taskId,
    verifyCommands: [['node', '-e', 'process.exit(0)']],
  }, h.exec)
  assert.equal(ok.status, 'verified', 'once the drain completes the integration succeeds')
})

t('R12: a persistently failing disposal is not a clean cancel and retains the reservation', async () => {
  const h = makeHarness({ name: 'r12-persistent', disposeFailures: Infinity })
  await boot(h)
  const started = await h.boot.tools.git_task_start.execute({ name: 'stuck', prompt: 'p' }, h.exec)
  const done = await settle(h, started.taskId)
  assert.equal(done.status, 'failed', 'an undisposed completion is not a success')
  assert.match(done.error, /disposal failed/i)

  await rejects(
    h.boot.tools.git_task_cancel.execute({ taskId: started.taskId }, h.exec),
    /could not be disposed|retained for retry/i,
    'cancel must not claim a clean stop while disposal still fails',
  )
  const after = (await h.boot.tools.git_task_status.execute({ taskId: started.taskId }, h.exec)).tasks[0]
  assert.equal(after.status, 'failed', 'a failed drain never flips to cancelled')
  assert.match(after.error, /disposal failed/i)
  assert.equal(h.children[0].disposed, false, 'the child handle is retained for retry')
  await rejects(
    h.boot.tools.git_worktree_remove.execute({ repo: h.repo, path: started.worktreePath, force: true }, h.exec),
    /live git_task_\* task owns it/i,
    'the worktree reservation is retained while the handle is undisposed',
  )
})

t('R13: only the invoking task agent is excepted on its own target; other reservations still block', async () => {
  const h = makeHarness({ name: 'r13-owner', holdFirst: true })
  await boot(h)
  const owner = await h.boot.tools.git_task_start.execute({ name: 'owner', prompt: 'p' }, h.exec)
  for (let i = 0; i < 200 && h.children.length === 0; i += 1) await delay(10)
  const ownerChild = h.children[0]
  assert.ok(ownerChild, 'owner child is live')
  const src = await h.boot.tools.git_task_start.execute({ name: 'source', prompt: 'p' }, h.exec)
  await settle(h, src.taskId)

  // A different invoker (the main parent) is NOT the owner: the live owner
  // reservation on the target still blocks.
  await rejects(
    h.boot.tools.git_task_integrate.execute({ repo: owner.worktreePath, taskId: src.taskId }, h.exec),
    /reserved by task/i,
    'a foreign invoker cannot integrate over a live task reservation',
  )
  // The invoking task agent integrating its OWN worktree is the native exception.
  const ownerExec = { agent: ownerChild, signal: h.exec.signal }
  const ok = await h.boot.tools.git_task_integrate.execute({
    repo: owner.worktreePath,
    taskId: src.taskId,
    verifyCommands: [['node', '-e', 'process.exit(0)']],
  }, ownerExec)
  assert.equal(ok.status, 'verified', 'the invoking task agent may integrate into its own target')
  await h.boot.tools.git_task_cancel.execute({ taskId: owner.taskId }, h.exec)
})

t('R10: corrupt sibling records fail clearly; tampered record paths are refused', async () => {
  const h = makeHarness({ name: 'r10-corrupt' })
  await boot(h)
  const a = await h.boot.tools.git_task_start.execute({ name: 'tamper', prompt: 'p' }, h.exec)
  await settle(h, a.taskId)
  const dir = join(h.repo, '.git', 'dsh-git-worktree', 'tasks')
  writeFileSync(join(dir, 'task-0000000000000bad.json'), '{not json')
  await rejects(h.boot.tools.git_task_status.execute({}, h.exec), /corrupt/i, 'corrupt sibling is not silently skipped')

  const record = JSON.parse(readFileSync(taskFile(h.repo, a.taskId), 'utf8'))
  const fake = join(h.repo, 'not-a-worktree')
  mkdirSync(fake, { recursive: true })
  record.worktreePath = fake
  writeFileSync(taskFile(h.repo, a.taskId), JSON.stringify(record))
  await rejects(
    h.boot.tools.git_task_integrate.execute({ taskId: a.taskId }, h.exec),
    /not a registered worktree|stale or corrupt/i,
    'a record path that is not a registered worktree is refused before git runs',
  )

  writeFileSync(taskFile(h.repo, a.taskId), JSON.stringify({ ...record, version: 99 }))
  await rejects(h.boot.tools.git_task_status.execute({ taskId: a.taskId }, h.exec), /corrupt/i, 'unknown version is refused')
})

// ── runner ──────────────────────────────────────────────────────────────────
for (const [name, fn] of tests) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    console.error(`✗ ${name}`)
    throw error
  }
}
console.log(`✅ tasks: ${passed} assertions passed`)
