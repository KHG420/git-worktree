/**
 * Local task records + agent orchestration for dsh-git-worktree.
 *
 * A *task* is one isolated worktree/branch plus the native child agent that
 * works inside it. Records live as versioned JSON under the repository's
 * COMMON git directory (`<common>/.git/dsh-git-worktree/tasks/<id>.json`), so a
 * linked worktree resolves the same records as the primary one. Writes are
 * atomic (temp file + rename); ids and paths are validated before any file is
 * touched, and no credential-shaped field is ever stored.
 *
 * The in-memory registry only tracks tasks owned by THIS process. A record that
 * is still active on disk but absent here is left alone when its recorded owner
 * pid is a live process (another DSH host); it is marked `interrupted` only
 * when that owner is proven gone. Liveness uses `process.kill(pid, 0)`, which
 * sends NO signal — the plugin never signals a pid it read from disk.
 *
 * @module dsh-git-worktree/tasks
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  appendDelegatedPolicyOverrides,
  applyChildComposition,
  captureDelegatedPolicyOverrides,
  childSessionMeta,
  finalAssistantOutput,
  resolveChildAgentOptions,
  resolveChildDepth,
} from '@deepseek-ai/dsh-subagent'
import { GitError, canonicalize, resolvePathArg, resolveRepo, runGit, sessionCwd } from './git.js'
import { parseWorktreeList } from './parse.js'
import { runningOccupants, worktreeAdd } from './operations.js'

/** Schema version written into every record; unknown versions are corrupt. */
export const TASK_RECORD_VERSION = 1

/** Plugin-owned record directory name under the common git dir. */
const TASK_DIR_NAME = 'dsh-git-worktree'
const TASKS_SUBDIR = 'tasks'

/** Task ids are generated locally and must be safe as a single path segment. */
const TASK_ID_RE = /^task-[0-9a-f]{16}$/

/**
 * Hard recursion cap for task children. A main agent (depth 0) may start task
 * children (depth 1); a task child cannot itself start another task. Reusing
 * the DSH subagent depth accounting keeps nested spawn/fork consistent.
 */
const TASK_MAX_DEPTH = 1

/** Bounded final summary kept on the record. */
const SUMMARY_MAX = 8 * 1024
/** Bounded combined stdout+stderr excerpt kept per setup/verification command. */
const OUTPUT_MAX = 8 * 1024
/** Upper bound on a single integrate call's verification command list. */
const VERIFY_MAX_COMMANDS = 50

/** Terminal statuses never change and are safe to report idempotently. */
const TERMINAL_STATUSES = new Set(['completed', 'setup_failed', 'failed', 'cancelled', 'interrupted'])

/** Thrown internally to unwind a task whose owning AbortController fired. */
class TaskCancelled extends Error {
  constructor(message = 'task cancelled') {
    super(message)
    this.name = 'TaskCancelled'
  }
}

// ── small helpers ───────────────────────────────────────────────────────────

/** The single-segment child session id for a task. */
const newTaskId = () => `task-${randomUUID().replace(/-/g, '').slice(0, 16)}`

/** Truncate a string to a bounded number of characters. */
const truncate = (value, max) => {
  if (typeof value !== 'string') return ''
  return value.length <= max ? value : `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`
}

const messageOf = (error) => (error instanceof Error ? error.message : String(error))
const nowIso = () => new Date().toISOString()

/** Reject any id that is not exactly our safe single-segment shape. */
function assertTaskId(taskId) {
  if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) {
    throw new GitError(`invalid task id: ${JSON.stringify(taskId)}`, -1, '')
  }
}

/** Validate and normalize the user-facing task name. */
function validateName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new GitError('git_task_start requires a non-empty name', -1, '')
  }
  const trimmed = name.trim()
  if (trimmed.length > 80) throw new GitError('task name must be 80 characters or fewer', -1, '')
  return trimmed
}

/** Validate the task prompt. */
function validatePrompt(prompt) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new GitError('git_task_start requires a non-empty prompt', -1, '')
  }
  return prompt
}

/** Validate integrate({verifyCommands}) into an array of non-empty argv arrays. */
function normalizeVerifyCommands(raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new GitError('verifyCommands must be an array of argv arrays', -1, '')
  if (raw.length > VERIFY_MAX_COMMANDS) throw new GitError(`verifyCommands is limited to ${VERIFY_MAX_COMMANDS} commands`, -1, '')
  return raw.map((argv, index) => {
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== 'string' || part === '')) {
      throw new GitError(`verifyCommands[${index}] must be a non-empty array of non-empty strings`, -1, '')
    }
    return [...argv]
  })
}

/** True when the record's owner pid is a live process. Sends no signal (0). */
function ownerAlive(record) {
  const pid = record?.owner?.pid
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

// ── repository context ──────────────────────────────────────────────────────

/**
 * Resolve the repository for a task argument: the worktree root of `args.repo`
 * (default: the session workspace), plus the shared common git dir and the
 * main worktree root used to key records.
 */
async function repoContext(ctx, exec, args, caps) {
  const base = canonicalize(sessionCwd(exec))
  const dir = args && args.repo !== undefined && args.repo !== null && args.repo !== ''
    ? resolvePathArg(args.repo, base)
    : base
  const root = await resolveRepo(ctx, exec, dir, caps)
  const res = await runGit(ctx, exec, {
    args: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    cwd: root,
    ...caps,
  })
  const commonDir = canonicalize(res.stdout.trim())
  if (!commonDir) throw new GitError(`could not resolve the git common directory for ${root}`, -1, '')
  const mainRoot = basename(commonDir) === '.git' ? canonicalize(dirname(commonDir)) : commonDir
  return { base, root, commonDir, mainRoot }
}

/** Directory holding this repository's task records. */
const taskDir = (commonDir) => join(commonDir, TASK_DIR_NAME, TASKS_SUBDIR)

// ── persistence ─────────────────────────────────────────────────────────────

/**
 * Atomically write one record. The temp file shares the record directory so the
 * rename stays on one filesystem and is therefore atomic.
 */
function writeRecord(commonDir, record) {
  const dir = taskDir(commonDir)
  mkdirSync(dir, { recursive: true })
  const target = join(dir, `${record.taskId}.json`)
  const tmp = join(dir, `.${record.taskId}.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  renameSync(tmp, target)
}

/**
 * Validate a persisted record against the v1 shape. Only fields a Git
 * operation would trust are required: a record whose `repoRoot` or
 * `worktreePath` is not an absolute path (or whose identity/version does not
 * match its filename) is refused instead of being used to drive git.
 */
function assertRecordShape(parsed, taskId) {
  const corrupt = (why) => {
    throw new GitError(`task record "${taskId}" is corrupt (${why})`, -1, '')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) corrupt('unexpected shape')
  if (parsed.version !== TASK_RECORD_VERSION) corrupt(`unsupported version ${JSON.stringify(parsed.version)}`)
  if (parsed.taskId !== taskId) corrupt(`taskId ${JSON.stringify(parsed.taskId)} does not match its file`)
  if (typeof parsed.status !== 'string' || parsed.status === '') corrupt('status is missing')
  if (typeof parsed.repoRoot !== 'string' || !isAbsolute(parsed.repoRoot)) corrupt('repoRoot is not an absolute path')
  if (typeof parsed.worktreePath !== 'string' || !isAbsolute(parsed.worktreePath)) corrupt('worktreePath is not an absolute path')
  if (parsed.branch !== null && parsed.branch !== undefined && typeof parsed.branch !== 'string') corrupt('branch is not a string or null')
  return parsed
}

/**
 * Read one validated record, throwing a clear error when the id is malformed,
 * absent, or the file is corrupt.
 */
function readRecord(commonDir, taskId) {
  assertTaskId(taskId)
  const path = join(taskDir(commonDir), `${taskId}.json`)
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') throw new GitError(`no task record "${taskId}" in this repository`, -1, '')
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new GitError(`task record "${taskId}" is corrupt (invalid JSON)`, -1, '')
  }
  return assertRecordShape(parsed, taskId)
}

/**
 * Read every record in the record directory. A malformed sibling is a hard,
 * clearly-named error rather than a silent skip: swallowing it would let a
 * repository look healthy while one of its records is unusable. Non-record
 * files (temp files, unrelated names) are still ignored.
 */
function readRecords(commonDir) {
  const dir = taskDir(commonDir)
  let names
  try {
    names = readdirSync(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const records = []
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue
    const taskId = name.slice(0, -'.json'.length)
    if (!TASK_ID_RE.test(taskId)) continue
    records.push(readRecord(commonDir, taskId))
  }
  return records
}

/** Apply a patch to a record, stamp `updatedAt`, and persist it atomically. */
function persist(entry, patch) {
  Object.assign(entry.record, patch, { updatedAt: nowIso() })
  writeRecord(entry.commonDir, entry.record)
  return entry.record
}

/** Apply a patch to a record that is not backed by a live entry. */
function persistRecord(commonDir, record, patch) {
  Object.assign(record, patch, { updatedAt: nowIso() })
  writeRecord(commonDir, record)
  return record
}

// ── subprocess commands (setup + verification) ──────────────────────────────

/**
 * Run one arbitrary argv command with the plugin's existing caps: bounded
 * collected output, cooperative abort, and a caller-owned timeout deadline.
 * Never shell-interpreted.
 */
async function runArgv(ctx, argv, cwd, signal, caps) {
  const controller = new AbortController()
  const forward = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', forward, { once: true })
  }
  let timedOut = false
  const timeoutMs = Number.isInteger(caps.timeoutMs) && caps.timeoutMs > 0 ? caps.timeoutMs : 0
  const timer = timeoutMs > 0
    ? setTimeout(() => { timedOut = true; controller.abort(new Error('command timed out')) }, timeoutMs)
    : null
  try {
    let handle
    try {
      handle = ctx.subprocess.spawn({
        argv: [...argv],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: caps.stdoutMaxBytes ?? 1_000_000 },
          stderr: { maxBytes: caps.stderrMaxBytes ?? 64 * 1024 },
        },
        graceMs: 3000,
        signal: controller.signal,
      })
    } catch (error) {
      throw new GitError(`could not start command ${argv[0]}: ${messageOf(error)}`, -1, '')
    }
    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      throw new GitError(`command ${argv[0]} failed to run: ${messageOf(error)}`, -1, '')
    }
    const stdout = handle.collected.stdout?.readFrom(0)
    const stderr = handle.collected.stderr?.readFrom(0)
    if (stdout === undefined || stderr === undefined) {
      throw new GitError(`command ${argv[0]} produced no collected output`, -1, '')
    }
    const stderrText = stderr.text.trim()
    return {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut,
      aborted: signal?.aborted === true,
      output: truncate(`${stdout.text}${stderrText ? `\n${stderrText}` : ''}`.trim(), OUTPUT_MAX),
    }
  } finally {
    if (timer) clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', forward)
  }
}

/**
 * Run the configured setup commands sequentially inside the task worktree.
 * Returns a failure descriptor on the first failure, or null when every
 * command succeeded. A cancellation unwinds via {@link TaskCancelled}.
 */
async function runSetup(ctx, entry, caps) {
  const commands = Array.isArray(caps.setupCommands) ? caps.setupCommands : []
  if (commands.length === 0) return null
  const ran = []
  for (const argv of commands) {
    if (entry.controller.signal.aborted) throw new TaskCancelled()
    const res = await runArgv(ctx, argv, entry.record.worktreePath, entry.controller.signal, caps)
    if (entry.controller.signal.aborted) throw new TaskCancelled()
    ran.push({ command: [...argv], exitCode: res.exitCode, timedOut: res.timedOut, output: res.output })
    if (res.timedOut || res.signal !== null || res.exitCode !== 0) {
      const why = res.timedOut
        ? `timed out after ${caps.timeoutMs}ms`
        : res.signal !== null
          ? `was killed by ${res.signal}`
          : `exited ${res.exitCode}`
      return {
        ok: false,
        commands: commands.map((command) => [...command]),
        failedCommand: [...argv],
        exitCode: res.exitCode,
        output: res.output,
        error: `setup command ${why}: ${argv.join(' ')}`,
      }
    }
  }
  return null
}

// ── child agent lifecycle ───────────────────────────────────────────────────

/** Build the model-facing task brief appended ahead of the caller's prompt. */
function buildTaskPrompt(record, prompt) {
  const lines = [
    'You are a delegated task agent running in an isolated git worktree.',
    `- Worktree: ${record.worktreePath}`,
    `- Branch: ${record.branch ?? '(detached)'}`,
    record.base ? `- Base: ${record.base}` : null,
    '',
    'Rules:',
    '- Work only inside this worktree; never modify another worktree or the shared main checkout.',
    '- Complete the requested task, then run the relevant tests/checks for your change.',
    '- Commit your own changes (git add/commit) so the worktree is clean; never leave it dirty.',
    '- Never push, never deploy, and never rewrite shared history.',
    '- Finish with a concise summary: what changed, the commit sha, and the tests you ran with their results.',
    '',
    'Requested task:',
    prompt,
  ]
  return lines.filter((line) => line !== null).join('\n')
}

/**
 * Authoritative completion read for one child: the DSH stop reason folded from
 * the child's own turn-end events plus the final assistant output. `idle` is
 * never success — only a real `completed` turn-end is.
 */
function readTaskResult(child, cancelled) {
  let events = []
  try {
    events = child.session.snapshotEvents()
  } catch {
    events = []
  }
  const end = foldConsumedWork(events).end
  const kind = end?.data?.reason?.kind
  const output = finalAssistantOutput(events) ?? []
  const summary = output
    .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
    .trim()
  if (cancelled && kind !== 'completed') return { status: 'cancelled', kind, summary, missing: false }
  switch (kind) {
    case 'completed': return { status: 'completed', kind, summary, missing: false }
    case 'aborted':
    case 'interrupted': return { status: 'cancelled', kind, summary, missing: false }
    case 'error':
    case 'blocked':
    case 'max-tokens': return { status: 'failed', kind, summary, missing: false }
    default:
      return { status: 'failed', kind: kind ?? null, summary, missing: true }
  }
}

/** HEAD sha of a worktree, or null when it cannot be read. */
async function headOf(ctx, exec, cwd, caps) {
  try {
    const res = await runGit(ctx, exec, { args: ['rev-parse', 'HEAD'], cwd, ...caps })
    return res.stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * Dispose a task's child handle. A failed disposal is NOT swallowed and the
 * handle is NOT cleared: the record is stamped non-success and the entry keeps
 * its handle so a later cancel or shutdown can retry the drain. Only a
 * successful disposal clears the handle and lets the entry be released.
 */
async function disposeEntry(entry) {
  const handle = entry.handle
  if (handle === null) {
    entry.child = null
    entry.disposed = true
    return
  }
  try {
    await handle.dispose()
    entry.handle = null
    entry.child = null
    entry.disposed = true
    entry.disposalError = null
  } catch (error) {
    entry.disposalError = error
    entry.disposed = false
    const prior = entry.record.error
    // A failed drain is NEVER a cancelled/completed success: the record stays
    // `failed` with an actionable error and the handle is retained for retry.
    persist(entry, {
      status: 'failed',
      error: `${prior ? `${prior}; ` : ''}child disposal failed: ${messageOf(error)} (child handle retained for retry)`,
    })
    throw error
  }
}

/**
 * Release a fully-disposed entry from the process registry and the
 * plugin-runtime worktree occupancy set. A partially-disposed entry
 * (`entry.disposed === false`) keeps both, so a retry or shutdown can drain it.
 * The concrete release closure is installed by {@link createTaskRuntime}.
 */
function releaseEntry(entry) {
  if (!entry.disposed) return
  if (typeof entry.release === 'function') entry.release()
}

/**
 * Create the task's native child agent (cwd frozen to the task worktree at
 * creation), send the task prompt, wait for the turn to settle, then record the
 * authoritative outcome. Disposal is owned by {@link runTask}'s `finally`, so a
 * failed drain persists an honest state instead of a completed success.
 */
async function launchAgent(ctx, entry, prompt, caps) {
  const parent = entry.parent
  const create = parent?.ctx?.agents?.create
  if (typeof create !== 'function') {
    throw new GitError('git_task_start: the native agents service became unavailable before the child could be created', -1, '')
  }
  const setup = (childCtx, child) => {
    appendDelegatedPolicyOverrides(child.session, entry.inherited)
    applyChildComposition(childCtx, parent, {})
  }
  let handle
  try {
    handle = await create.call(parent.ctx.agents, {
      sessionId: entry.childId,
      parentAgent: parent,
      // meta.cwd MUST be the task worktree: childSessionMeta inherits the
      // parent's cwd, so it is spread first and overridden here.
      meta: { ...entry.meta, cwd: entry.record.worktreePath },
      agentOptions: entry.agentOptions,
      signal: entry.controller.signal,
      setup,
    })
  } catch (error) {
    if (entry.cancelled || entry.controller.signal.aborted) throw new TaskCancelled()
    throw error
  }
  entry.handle = handle
  entry.child = handle.agent
  entry.disposed = false
  persist(entry, { status: 'running', sessionId: handle.agent.id })
  if (!entry.cancelled && !entry.controller.signal.aborted) {
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: buildTaskPrompt(entry.record, prompt) }],
      source: { kind: 'user' },
    }))
  }
  await handle.agent.whenIdle()
  const result = readTaskResult(handle.agent, entry.cancelled)
  const patch = { status: result.status, summary: truncate(result.summary, SUMMARY_MAX) || null }
  if (result.status === 'completed') {
    patch.commit = await headOf(ctx, handle.agent, entry.record.worktreePath, caps)
    patch.error = null
  } else {
    patch.error = result.missing
      ? 'task ended without a completed turn (missing/invalid turn-end)'
      : `task ended: ${result.kind ?? 'unknown'}`
  }
  persist(entry, patch)
}

/** Drive one task from setup through child settlement, persisting every state. */
async function runTask(ctx, entry, prompt, caps) {
  try {
    if (entry.cancelled || entry.controller.signal.aborted) throw new TaskCancelled()
    const setupFailure = await runSetup(ctx, entry, caps)
    if (setupFailure !== null) {
      persist(entry, { status: 'setup_failed', setup: setupFailure, error: setupFailure.error })
      return
    }
    if (entry.cancelled || entry.controller.signal.aborted) throw new TaskCancelled()
    const configuredSetup = Array.isArray(caps.setupCommands) ? caps.setupCommands : []
    persist(entry, {
      status: 'running',
      ...(configuredSetup.length > 0 ? { setup: { ok: true, commands: configuredSetup.map((c) => [...c]) } } : {}),
    })
    await launchAgent(ctx, entry, prompt, caps)
  } catch (error) {
    if (entry.cancelled || error instanceof TaskCancelled || entry.controller.signal.aborted) {
      persist(entry, { status: 'cancelled', error: 'task cancelled' })
    } else {
      persist(entry, { status: 'failed', error: messageOf(error) })
    }
  } finally {
    try {
      await disposeEntry(entry)
    } catch {
      /* disposeEntry already persisted the honest non-success state */
    }
    entry.settled = true
    releaseEntry(entry)
  }
}

// ── record → tool summary ───────────────────────────────────────────────────

/** Project a record onto the stable, schema-checked tool summary. */
function toSummary(record) {
  const setup = record.setup
  const integration = record.integration
  return {
    taskId: record.taskId,
    name: record.name,
    status: record.status,
    branch: record.branch ?? null,
    worktreePath: record.worktreePath,
    repo: record.repoRoot,
    base: record.base ?? null,
    sessionId: record.sessionId ?? null,
    summary: record.summary ?? null,
    commit: record.commit ?? null,
    error: record.error ?? null,
    createdAt: record.createdAt ?? null,
    updatedAt: record.updatedAt ?? null,
    setup: setup === null || setup === undefined
      ? null
      : {
          ok: setup.ok === true,
          failedCommand: Array.isArray(setup.failedCommand) ? [...setup.failedCommand] : null,
          exitCode: Number.isInteger(setup.exitCode) ? setup.exitCode : null,
          output: typeof setup.output === 'string' ? setup.output : '',
        },
    integration: integration === null || integration === undefined
      ? null
      : {
          status: integration.status ?? 'unknown',
          verified: integration.verified === true,
          targetWorktreePath: integration.targetWorktreePath ?? null,
          targetBranch: integration.targetBranch ?? null,
          mergedCommit: integration.mergedCommit ?? null,
          targetHeadAtMerge: integration.targetHeadAtMerge ?? null,
          conflicts: Array.isArray(integration.conflicts) ? [...integration.conflicts] : [],
          verification: integration.verification === null || integration.verification === undefined
            ? null
            : {
                commands: (integration.verification.commands ?? []).map((c) => [...c]),
                verified: integration.verification.verified === true,
                at: typeof integration.verification.at === 'string' ? integration.verification.at : null,
                results: (integration.verification.results ?? []).map((r) => ({
                  command: [...(r.command ?? [])],
                  exitCode: Number.isInteger(r.exitCode) ? r.exitCode : null,
                  timedOut: r.timedOut === true,
                  ok: r.ok === true,
                  output: typeof r.output === 'string' ? r.output : '',
                })),
              },
        },
  }
}

// ── integration helpers ─────────────────────────────────────────────────────

/** Parse `git worktree list --porcelain` for the common dir's worktrees. */
async function listWorktrees(ctx, exec, cwd, caps) {
  const res = await runGit(ctx, exec, { args: ['worktree', 'list', '--porcelain'], cwd, ...caps })
  return parseWorktreeList(res.stdout)
}

/** True when `commit` is already an ancestor of the target worktree's HEAD. */
async function isAncestor(ctx, exec, commit, cwd, caps) {
  const res = await runGit(ctx, exec, {
    args: ['merge-base', '--is-ancestor', commit, 'HEAD'],
    cwd,
    ...caps,
    allowExitCodes: [1],
  })
  return res.exitCode === 0
}

/** Run one command capturing a structured result without throwing on failure. */
async function runAllowFailure(ctx, exec, args, cwd, caps) {
  try {
    const res = await runGit(ctx, exec, { args, cwd, ...caps, allowExitCodes: [1, 2] })
    return { exitCode: res.exitCode, output: `${res.stdout}${res.stderr ? `\n${res.stderr}` : ''}`.trim() }
  } catch (error) {
    return { exitCode: error instanceof GitError ? error.exitCode : -1, output: messageOf(error) }
  }
}

/** True when a merge output describes unresolved conflicts. */
const looksConflicted = (output) => /CONFLICT|Automatic merge failed|fix conflicts/i.test(output)

/** Run each verification command in the target worktree, preserving order. */
async function runVerifications(ctx, commands, targetPath, signal, caps) {
  const results = []
  let verified = true
  for (const argv of commands) {
    const res = await runArgv(ctx, argv, targetPath, signal, caps)
    const ok = !res.timedOut && res.signal === null && res.exitCode === 0
    if (!ok) verified = false
    results.push({ command: [...argv], exitCode: res.exitCode, timedOut: res.timedOut, ok, output: res.output })
  }
  return { commands: commands.map((c) => [...c]), results, verified, at: nowIso() }
}

// ── runtime ─────────────────────────────────────────────────────────────────

/**
 * Create the per-plugin task runtime. `caps` is the resolved plugin config
 * (worktreesDir, timeout, byte caps, setupCommands).
 */
export function createTaskRuntime(caps) {
  /** Live tasks owned by THIS process: taskId → entry. */
  const live = new Map()

  /**
   * Worktree paths owned by a live task in THIS plugin runtime (including
   * `preparing` setup and an unfinished disposal). Shared with the removal
   * operations via `caps` so `git_worktree_remove` refuses to delete a
   * directory a task is actively using, even with `force` and even when the
   * native agents service is absent.
   */
  const taskWorktreePaths = caps?.taskWorktreePaths instanceof Set ? caps.taskWorktreePaths : new Set()

  /** The live entry for `taskId` only when it belongs to `commonDir`. */
  const liveEntryFor = (commonDir, taskId) => {
    const entry = live.get(taskId)
    return entry !== undefined && entry.commonDir === commonDir ? entry : undefined
  }

  /** Reconcile active on-disk records that this process does not own. */
  function reconcile(commonDir, records) {
    for (const record of records) {
      if (TERMINAL_STATUSES.has(record.status)) continue
      if (liveEntryFor(commonDir, record.taskId) !== undefined) continue
      if (record.owner?.pid !== process.pid && ownerAlive(record)) continue // foreign live owner
      try {
        Object.assign(record, { status: 'interrupted', updatedAt: nowIso() })
        writeRecord(commonDir, record)
      } catch {
        /* a read-only/vanished record directory must not break status */
      }
    }
  }

  /**
   * Load, reconcile, and return records for one repository. Only live entries
   * whose `commonDir` matches are merged: another repository's in-memory task
   * must never appear in this repository's list.
   */
  function loadAll(commonDir) {
    const records = readRecords(commonDir)
    reconcile(commonDir, records)
    // Live in-memory records win over their (identical) disk copies.
    for (const [taskId, entry] of live) {
      if (entry.commonDir !== commonDir) continue
      const index = records.findIndex((record) => record.taskId === taskId)
      if (index === -1) records.push(entry.record)
      else records[index] = entry.record
    }
    return records
  }

  /**
   * Abort + drain every live task; used by cancel and by plugin teardown.
   * Retries disposal for an entry whose earlier drain failed, then releases it
   * only once the handle is truly gone. Returns `true` only when the child
   * handle was verifiably disposed; `false` means the entry is retained (the
   * honest `failed` record was already persisted) so the caller can decide how
   * to surface the unresolved cleanup instead of claiming success.
   */
  async function stopEntry(entry) {
    entry.cancelled = true
    try {
      entry.controller.abort(new Error('task cancelled'))
    } catch {
      /* already aborted */
    }
    if (entry.child) {
      try {
        entry.child.cancel({ kind: 'parent' })
      } catch {
        /* child already settled */
      }
    }
    if (entry.completion) await entry.completion.catch(() => {})
    if (!entry.disposed && entry.handle !== null) {
      try {
        await disposeEntry(entry)
      } catch {
        /* the honest non-success state was already persisted */
      }
    }
    if (entry.disposed) {
      entry.settled = true
      releaseEntry(entry)
    }
    return entry.disposed
  }

  /**
   * Live plugin-owned entries that still reserve `path` because their child has
   * not been verifiably disposed (preparing, running, or an unfinished/failed
   * drain). `exceptAgent` drops exactly the entry whose child agent IS the
   * invoking agent — a task agent may legitimately integrate into its own
   * worktree (native invoking-parent exception). No exception is ever applied
   * on the source side: a source worktree whose disposal is unfinished always
   * blocks. This is an in-memory reservation, not a cross-process lock.
   */
  function pendingReservations(path, exceptAgent) {
    const out = []
    for (const entry of live.values()) {
      if (entry.disposed) continue
      if (canonicalize(entry.record.worktreePath) !== path) continue
      if (exceptAgent !== undefined && exceptAgent !== null) {
        const owned = entry.child === exceptAgent
          || (entry.child != null && entry.child.id === exceptAgent.id)
          || (entry.record.sessionId != null && entry.record.sessionId === exceptAgent.id)
        if (owned) continue
      }
      out.push(entry)
    }
    return out
  }

  /** Human-readable task ids for a reservation error. */
  const reservationIds = (entries) => entries.map((entry) => entry.record.taskId).join(', ')

  /**
   * Minimal same-process serialization per TARGET worktree, held across merge
   * AND verification. Native cwd occupancy does not cover two integrations
   * whose callers live elsewhere, so two merges could otherwise interleave and
   * invalidate each other's verification. No generic scheduler: one FIFO chain
   * per target path, released in `finally`.
   */
  const targetLocks = new Map()
  async function withTargetLock(path, fn) {
    let slot = targetLocks.get(path)
    if (slot === undefined) {
      slot = { chain: Promise.resolve(), count: 0 }
      targetLocks.set(path, slot)
    }
    slot.count += 1
    const wait = slot.chain
    let release
    slot.chain = new Promise((resolve) => { release = resolve })
    try {
      await wait
      return await fn()
    } finally {
      release()
      slot.count -= 1
      if (slot.count === 0) targetLocks.delete(path)
    }
  }


  return {
    /** Test/teardown introspection: ids currently owned by this process. */
    liveIds: () => [...live.keys()],

    /**
     * git_task_start: create the worktree/branch, persist the record, return
     * promptly with status `preparing`, and run setup + the child agent in the
     * task's own lifetime.
     */
    async start(ctx, exec, args) {
      const parent = exec?.agent
      const agents = parent?.ctx?.agents
      if (parent === undefined || parent === null || typeof agents?.create !== 'function') {
        throw new GitError(
          'git_task_start is unavailable: this deployment has no native agents service '
          + '(a calling agent with ctx.agents.create is required). Normal git tools still work.',
          -1,
          '',
        )
      }
      const name = validateName(args?.name)
      const prompt = validatePrompt(args?.prompt)
      // Depth is checked BEFORE creating any worktree so a refused start leaves
      // no orphan worktree behind. The policy snapshot is taken synchronously,
      // before any await, so a later parent switch cannot widen this child.
      let childDepth
      try {
        childDepth = resolveChildDepth(parent, TASK_MAX_DEPTH)
      } catch (error) {
        throw new GitError(`git_task_start: ${messageOf(error)}`, -1, '')
      }
      const inherited = captureDelegatedPolicyOverrides(parent)
      const meta = childSessionMeta(parent, childDepth, false)
      const agentOptions = resolveChildAgentOptions(parent, undefined, childDepth)

      const rc = await repoContext(ctx, exec, args, caps)
      // R1: the actual `git worktree add` is anchored to the RESOLVED requested
      // repository (`rc.root`), never to the caller's session cwd. Without this,
      // an explicit `repo` gets a worktree under the caller's repo.
      const wt = await taskWorktreeAdd(ctx, exec, rc, name, args?.base, caps)
      const worktreePath = canonicalize(wt.absolutePath ?? wt.path)
      const branch = wt.branch ?? null

      const record = {
        version: TASK_RECORD_VERSION,
        taskId: newTaskId(),
        name,
        repoRoot: rc.mainRoot,
        worktreePath,
        branch,
        base: args?.base ?? null,
        status: 'preparing',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        owner: { pid: process.pid, startedAt: Date.now() },
        parentSessionId: parent.id ?? parent.session?.header?.id ?? null,
        sessionId: null,
        summary: null,
        commit: null,
        error: null,
        setup: null,
        integration: null,
      }
      writeRecord(rc.commonDir, record)

      const controller = new AbortController()
      const entry = {
        record,
        commonDir: rc.commonDir,
        controller,
        cancelled: false,
        child: null,
        handle: null,
        disposed: false,
        disposalError: null,
        settled: false,
        parent,
        childId: randomUUID(),
        childDepth,
        inherited,
        meta,
        agentOptions,
        completion: null,
      }
      live.set(record.taskId, entry)
      // Occupy the worktree from the moment it exists (preparing included) until
      // the child handle is verifiably disposed.
      taskWorktreePaths.add(record.worktreePath)
      entry.release = () => {
        if (live.get(record.taskId) === entry) live.delete(record.taskId)
        taskWorktreePaths.delete(entry.record.worktreePath)
      }

      // R6: bind the task to the parent agent's lifetime BEFORE asynchronous
      // preparation begins, so disposing the parent during `preparing` aborts
      // setup and drains the task instead of leaving it running.
      if (typeof parent.ctx?.effect === 'function') {
        try {
          parent.ctx.effect(() => () => stopEntry(entry))
        } catch (error) {
          entry.cancelled = true
          try { controller.abort(new Error('task cancelled')) } catch { /* already aborted */ }
          entry.disposed = true
          live.delete(record.taskId)
          taskWorktreePaths.delete(worktreePath)
          throw new GitError(`git_task_start: could not bind the task to the parent lifetime: ${messageOf(error)}`, -1, '')
        }
      }

      entry.completion = runTask(ctx, entry, prompt, caps)
        .catch((error) => {
          try {
            persist(entry, { status: entry.cancelled ? 'cancelled' : 'failed', error: messageOf(error) })
          } catch {
            /* the record write must not become an unhandled rejection */
          }
        })
        .finally(() => {
          entry.settled = true
          releaseEntry(entry)
        })
      return toSummary(record)
    },

    /**
     * git_task_status: one task (taskId) or every task for this repository's
     * common git dir, with dead-owner active records flagged `interrupted`.
     */
    async status(ctx, exec, args) {
      const rc = await repoContext(ctx, exec, args, caps)
      const taskId = args?.taskId
      if (taskId !== undefined && taskId !== null && taskId !== '') {
        const record = readRecord(rc.commonDir, taskId)
        reconcile(rc.commonDir, [record])
        const entry = liveEntryFor(rc.commonDir, taskId)
        return { tasks: [toSummary(entry?.record ?? record)] }
      }
      return { tasks: loadAll(rc.commonDir).map(toSummary) }
    },

    /**
     * git_task_cancel: abort/drain a task owned by this process; idempotent on
     * finished tasks; a foreign live owner is reported, never signalled.
     */
    async cancel(ctx, exec, args) {
      assertTaskId(args?.taskId)
      const rc = await repoContext(ctx, exec, args, caps)
      // R3: only a live entry that belongs to THIS repository may be cancelled;
      // scope is validated before any abort/cancel/persist. A task owned by
      // another repo (or another process) falls through to readRecord, which
      // rejects a record that does not exist here.
      const entry = liveEntryFor(rc.commonDir, args.taskId)
      if (entry !== undefined) {
        const drained = await stopEntry(entry)
        if (!drained) {
          // The child could not be disposed, so this is NOT a clean cancel: the
          // record stays `failed`, the handle/reservation are retained for a
          // retry, and the caller gets a hard, actionable error instead of a
          // false `cancelled: true`.
          throw new GitError(
            `git_task_cancel: task ${args.taskId} was aborted but its child could not be disposed `
            + `(${messageOf(entry.disposalError)}); the handle and worktree reservation are retained for retry `
            + 'and the task is NOT reported as cancelled',
            -1,
            '',
          )
        }
        const latest = liveEntryFor(rc.commonDir, args.taskId)?.record ?? readRecord(rc.commonDir, args.taskId)
        return {
          taskId: args.taskId,
          status: latest.status,
          cancelled: latest.status === 'cancelled',
          message: 'task stopped; its worktree and branch were preserved',
        }
      }
      const record = readRecord(rc.commonDir, args.taskId)
      if (TERMINAL_STATUSES.has(record.status)) {
        return {
          taskId: args.taskId,
          status: record.status,
          cancelled: record.status === 'cancelled',
          message: 'task already finished; nothing to cancel',
        }
      }
      if (record.owner?.pid !== process.pid && ownerAlive(record)) {
        return {
          taskId: args.taskId,
          status: record.status,
          cancelled: false,
          message: 'task is owned by another live DSH process; this plugin will not signal it',
        }
      }
      Object.assign(record, { status: 'interrupted', updatedAt: nowIso() })
      writeRecord(rc.commonDir, record)
      return {
        taskId: args.taskId,
        status: 'interrupted',
        cancelled: false,
        message: 'stale active task had no live owner and was marked interrupted',
      }
    },

    /**
     * git_task_integrate: merge a completed task's verified commit into the
     * target worktree, then run explicit verification. No force/reset/clean,
     * no push, and conflicts are preserved for manual resolution.
     */
    async integrate(ctx, exec, args) {
      assertTaskId(args?.taskId)
      const verifyCommands = normalizeVerifyCommands(args?.verifyCommands)
      const rc = await repoContext(ctx, exec, args, caps)
      const record = readRecord(rc.commonDir, args.taskId)
      if (record.repoRoot !== rc.mainRoot) {
        throw new GitError(`task ${args.taskId} belongs to a different repository (${record.repoRoot})`, -1, '')
      }
      if (record.status !== 'completed') {
        throw new GitError(`task ${args.taskId} is ${record.status}; only a completed task can be integrated`, -1, '')
      }
      if (!record.commit) throw new GitError(`task ${args.taskId} has no recorded commit`, -1, '')
      const sourcePath = canonicalize(record.worktreePath)
      const targetPath = canonicalize(rc.root)
      if (sourcePath === targetPath) {
        throw new GitError('source and target are the same worktree', -1, '')
      }

      // R8: one same-process FIFO per target worktree, held across merge AND
      // verification, released in `finally`. Concurrent callers from anywhere
      // serialize instead of interleaving merges and invalidating verification.
      return withTargetLock(targetPath, async () => {
        const worktrees = await listWorktrees(ctx, exec, rc.root, caps)
        // R10: never drive git with a record path that is not a registered
        // worktree of this repository. A tampered/stale path is refused before
        // any HEAD read or merge.
        const sourceEntry = worktrees.find((wt) => wt.path === sourcePath)
        if (sourceEntry === undefined) {
          throw new GitError(
            `task ${args.taskId}: recorded worktreePath ${record.worktreePath} is not a registered `
            + `worktree of ${rc.mainRoot}; the record is stale or corrupt`,
            -1,
            '',
          )
        }
        if (record.branch != null && sourceEntry.branch !== null && record.branch !== sourceEntry.branch) {
          throw new GitError(
            `task ${args.taskId}: recorded branch ${record.branch} does not match ${sourcePath} `
            + `(checked out: ${sourceEntry.branch ?? 'detached'}); the record is stale or corrupt`,
            -1,
            '',
          )
        }
        if (worktrees.every((wt) => wt.path !== targetPath)) {
          throw new GitError(`target ${targetPath} is not a registered worktree of ${rc.mainRoot}`, -1, '')
        }

        // Source must still be exactly the committed, clean, verified head.
        let sourceHead
        try {
          sourceHead = (await runGit(ctx, exec, { args: ['rev-parse', 'HEAD'], cwd: sourcePath, ...caps })).stdout.trim()
        } catch (error) {
          throw new GitError(`source worktree ${sourcePath} is unavailable: ${messageOf(error)}`, -1, '')
        }
        if (sourceHead !== record.commit) {
          throw new GitError(`source HEAD ${sourceHead} no longer matches the recorded commit ${record.commit}; re-complete the task or fix the worktree`, -1, '')
        }
        const sourceDirty = (await runGit(ctx, exec, { args: ['status', '--porcelain'], cwd: sourcePath, ...caps })).stdout.trim()
        if (sourceDirty !== '') {
          throw new GitError('source worktree has uncommitted changes; commit them before integrating', -1, '')
        }

        const targetBranch = (await runGit(ctx, exec, { args: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd: targetPath, ...caps })).stdout.trim()
        if (targetBranch === record.branch) {
          throw new GitError('source and target are the same branch; refusing to merge a branch into itself', -1, '')
        }
        const targetDirty = (await runGit(ctx, exec, { args: ['status', '--porcelain'], cwd: targetPath, ...caps })).stdout.trim()
        if (targetDirty !== '') {
          throw new GitError('target worktree is dirty; commit or stash its changes before integrating', -1, '')
        }

        // Same-host occupancy guard (best effort, not a cross-process lock). The
        // invoking parent is ignored when it is the caller validating its own
        // target worktree.
        const targetOccupants = runningOccupants(ctx, worktrees, targetPath, exec?.agent?.id)
        if (targetOccupants !== null && targetOccupants.length > 0) {
          throw new GitError(
            `target worktree ${targetPath} is occupied by running agent(s): ${targetOccupants.map((o) => o.cwd).join(', ')}. Stop them first (same-host check).`,
            -1,
            '',
          )
        }
        const sourceOccupants = runningOccupants(ctx, worktrees, sourcePath, undefined)
        if (sourceOccupants !== null && sourceOccupants.length > 0) {
          throw new GitError(
            `source worktree ${sourcePath} still has running agent(s): ${sourceOccupants.map((o) => o.cwd).join(', ')}. Stop them first.`,
            -1,
            '',
          )
        }

        // Plugin-owned reservations (this process): an entry whose child handle
        // is not yet verifiably disposed still owns its worktree — preparing,
        // running, or a drain that failed/is still in flight. Held inside the
        // target lock immediately before any Git mutation, so a `completed`
        // record whose disposal is merely pending cannot be integrated over.
        // The SOURCE never gets the invoking-agent exception; the TARGET drops
        // exactly the invoking task agent's own entry (native invoking-parent).
        const sourceReservations = pendingReservations(sourcePath, undefined)
        if (sourceReservations.length > 0) {
          throw new GitError(
            `source worktree ${sourcePath} is still reserved by task(s) ${reservationIds(sourceReservations)} `
            + 'whose child has not been disposed; wait for the task to finish draining, then integrate',
            -1,
            '',
          )
        }
        const targetReservations = pendingReservations(targetPath, exec?.agent)
        if (targetReservations.length > 0) {
          throw new GitError(
            `target worktree ${targetPath} is still reserved by task(s) ${reservationIds(targetReservations)} `
            + '(preparing/running/undisposed); stop them before integrating',
            -1,
            '',
          )
        }

        const targetHeadBefore = (await runGit(ctx, exec, { args: ['rev-parse', 'HEAD'], cwd: targetPath, ...caps })).stdout.trim()
        const alreadyMerged = await isAncestor(ctx, exec, record.commit, targetPath, caps)
        let mergeOutput = ''
        if (!alreadyMerged) {
          const merge = await runAllowFailure(ctx, exec, ['merge', '--no-edit', record.commit], targetPath, caps)
          mergeOutput = merge.output
          if (merge.exitCode !== 0) {
            if (looksConflicted(mergeOutput)) {
              const conflicts = (await runAllowFailure(ctx, exec, ['diff', '--name-only', '--diff-filter=U'], targetPath, caps))
                .output.split('\n').map((line) => line.trim()).filter((line) => line !== '')
              const integration = {
                status: 'conflicted',
                verified: false,
                targetWorktreePath: targetPath,
                targetBranch,
                mergedCommit: record.commit,
                targetHeadAtMerge: null,
                conflicts,
                verification: null,
              }
              persistRecord(rc.commonDir, record, { integration })
              return {
                taskId: args.taskId,
                status: 'conflicted',
                merged: false,
                verified: false,
                conflicts,
                verification: null,
                target: { repo: rc.mainRoot, worktreePath: targetPath, branch: targetBranch, headBefore: targetHeadBefore, headAfter: null },
                message: 'merge conflict: the target worktree is left in the conflicted state. Resolve the conflicts, commit the merge, then rerun git_task_integrate to verify; no abort/reset was performed.',
              }
            }
            throw new GitError(`merge failed in ${targetPath}: ${truncate(mergeOutput, OUTPUT_MAX)}`, merge.exitCode, '')
          }
        }

        // R5: capture the head the merge produced, run verification fresh, then
        // re-check the final HEAD and tracked/index state. A verification command
        // that commits or modifies a tracked file must NOT be certified — the
        // changes are preserved and the task reports unverified.
        const mergedHead = (await runGit(ctx, exec, { args: ['rev-parse', 'HEAD'], cwd: targetPath, ...caps })).stdout.trim()
        const verification = verifyCommands.length > 0
          ? await runVerifications(ctx, verifyCommands, targetPath, exec?.signal ?? null, caps)
          : null
        const finalHead = (await runGit(ctx, exec, { args: ['rev-parse', 'HEAD'], cwd: targetPath, ...caps })).stdout.trim()
        const postStatus = (await runGit(ctx, exec, { args: ['status', '--porcelain'], cwd: targetPath, ...caps })).stdout
        const trackedChanges = postStatus.split('\n')
          .map((line) => line.trimEnd())
          .filter((line) => line !== '' && line.slice(0, 2) !== '??')
          .map((line) => line.slice(3))
        const headMoved = finalHead !== mergedHead
        const mutated = headMoved || trackedChanges.length > 0
        const verified = verification !== null && verification.verified === true && !mutated
        const integration = {
          status: verified ? 'verified' : 'unverified',
          verified,
          targetWorktreePath: targetPath,
          targetBranch,
          mergedCommit: record.commit,
          targetHeadAtMerge: mergedHead,
          alreadyMerged,
          conflicts: [],
          verification,
          updatedAt: nowIso(),
        }
        persistRecord(rc.commonDir, record, { integration })
        let message
        if (verified) {
          message = `merged into ${targetPath} at ${mergedHead} and independently verified`
        } else if (verification === null) {
          message = `merged into ${targetPath} at ${mergedHead}, but NOT independently verified (no verifyCommands provided)`
        } else if (mutated) {
          const changed = [
            headMoved ? `HEAD moved ${mergedHead} -> ${finalHead}` : null,
            trackedChanges.length > 0 ? `tracked changes: ${trackedChanges.join(', ')}` : null,
          ].filter(Boolean).join('; ')
          message = `merged into ${targetPath} at ${mergedHead}, but verification altered the target worktree (${changed}); the changes were preserved and NOT certified. Clean them up and rerun git_task_integrate (the merge will not repeat).`
        } else {
          message = `merged into ${targetPath} at ${mergedHead}, but verification failed; fix the target and rerun git_task_integrate (the merge will not repeat)`
        }
        return {
          taskId: args.taskId,
          status: integration.status,
          merged: !alreadyMerged,
          verified,
          conflicts: [],
          verification,
          target: { repo: rc.mainRoot, worktreePath: targetPath, branch: targetBranch, headBefore: targetHeadBefore, headAfter: finalHead },
          message,
        }
      })
    },

    /**
     * Cancel and dispose every task this process still owns (plugin teardown).
     * Retries any earlier failed drain; an entry that still cannot be disposed
     * is retained (never released, never marked disposed) and makes shutdown
     * REJECT with an aggregate error instead of resolving as if cleanup
     * succeeded. A later shutdown call retries the retained handles.
     */
    async shutdown() {
      const entries = [...live.values()]
      await Promise.all(entries.map((entry) => stopEntry(entry).catch(() => false)))
      // Any entry whose runTask finally already fired is gone; wait a tick for
      // the last disposals to settle so teardown leaves no owned active child.
      await Promise.all(entries.map((entry) => entry.completion?.catch(() => {})))
      // Retry any disposal that failed earlier; retain it if it still cannot drain.
      const failures = []
      for (const entry of [...live.values()]) {
        if (!entry.disposed && entry.handle !== null) {
          try {
            await disposeEntry(entry)
          } catch (error) {
            failures.push({ taskId: entry.record.taskId, error: messageOf(error) })
          }
        }
        if (entry.disposed) {
          entry.settled = true
          releaseEntry(entry)
        }
      }
      if (failures.length > 0) {
        throw new GitError(
          `git-worktree teardown: ${failures.length} task child(ren) could not be disposed and were retained for retry: `
          + failures.map((failure) => `${failure.taskId} (${failure.error})`).join('; '),
          -1,
          '',
        )
      }
      return { ok: true }
    },
  }
}

// ── task worktree creation ──────────────────────────────────────────────────

/** Git errors that mean "the name/path/branch is already taken". */
const WORKTREE_COLLISION_RE = /already exists|already used|already checked out|already registered/

/**
 * Create a task's worktree anchored to the RESOLVED repository, with a fresh
 * branch. A default (unpinned) start delegates name deduplication to
 * `worktreeAdd`'s `unique` handling. A `base`-pinned start needs an explicit
 * `newBranch`, which `worktreeAdd` deliberately never renames — so this loop
 * retries the actual `git worktree add` on a real collision, suffixing the
 * candidate. The public `git_worktree_add` semantics are untouched.
 */
async function taskWorktreeAdd(ctx, exec, rc, name, base, caps) {
  const pinned = base !== undefined && base !== null && base !== ''
  if (!pinned) {
    return worktreeAdd(ctx, exec, { repo: rc.root, name, unique: true }, caps)
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = attempt === 0 ? name : `${name}-${attempt + 1}`
    try {
      return await worktreeAdd(ctx, exec, {
        repo: rc.root,
        name: candidate,
        newBranch: candidate,
        commitIsh: base,
      }, caps)
    } catch (error) {
      const collision = error instanceof GitError && WORKTREE_COLLISION_RE.test(error.message)
      if (!collision || attempt >= 19) throw error
    }
  }
  throw new GitError(`could not find a free task name for "${name}"`, -1, '')
}
