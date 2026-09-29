/**
 * Tool output ↔ declared output schema conformance suite.
 *
 * The harness validates every successful tool body against the tool's declared
 * `output.schema` with `validateJsonSchemaValue` (additionalProperties: false
 * is enforced) — a tool that returns a property its schema does not declare
 * dies at dispatch with INVALID_TOOL_OUTPUT. This suite replays that exact
 * runtime validation for all 9 tools against a real scratch repo, so schema
 * drift between `lib/operations.js` and `lib/tools.js` is caught in the
 * plugin's own tests instead of in a live session.
 *
 * Regression: git_worktree_list returned `worktrees[].absolutePath` while its
 * schema omitted it — every `git_worktree_list` call failed live with
 * `"value.worktrees[0].absolutePath" is not a declared property`.
 *
 * Run: node test/schema-conformance.js
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Use an explicitly selected host validator when supplied; otherwise validate
// against the DSH version pinned by this plugin. A stale global DSH install
// must not silently make a new-version conformance run pass.
const runtimeValidatorCandidates = [process.env.DSH_TOOLS]
let validateJsonSchemaValue
let validatorSource = '@deepseek-ai/dsh-tools (pinned plugin dependency)'
for (const candidate of runtimeValidatorCandidates) {
  if (!candidate || !existsSync(candidate)) continue
  try {
    const mod = await import(pathToFileURL(candidate).href)
    if (typeof mod.validateJsonSchemaValue === 'function') {
      validateJsonSchemaValue = mod.validateJsonSchemaValue
      validatorSource = candidate
      break
    }
  } catch {
    /* candidate present but not importable — fall through to the local dependency */
  }
}
if (validateJsonSchemaValue === undefined) {
  ({ validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools'))
}
console.log(`schema validator: ${validatorSource}`)

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

// ── fake ctx + plugin boot (same shape as test.js) ────────────────────────
const registered = []
const ctx = {
  subprocess: makeSubprocess(),
  tools: { register: (tool) => registered.push(tool) },
  systemPrompt: { section: () => {} },
  effect: (fn) => fn(),
  inject: (names, callback) => {
    const scoped = { ...ctx, webServer: { register: () => {} } }
    callback(scoped)
    return { await: async () => {} }
  },
}

const plugin = (await import('../index.js')).default
await plugin.apply(ctx, { worktreesDir: '.dsh-wt', timeoutMs: 30000, stdoutMaxBytes: 1_000_000, stderrMaxBytes: 64 * 1024 })

const tools = Object.fromEntries(registered.map((t) => [t.name, t]))
assert.equal(Object.keys(tools).length, 13, 'expect 13 tools registered (9 git + 4 task)')
assert.deepEqual(Object.keys(tools).sort(), [
  'git_branch_create', 'git_branch_delete', 'git_branch_list', 'git_branch_switch',
  'git_repo_status', 'git_session_binding',
  'git_task_cancel', 'git_task_integrate', 'git_task_start', 'git_task_status',
  'git_worktree_add', 'git_worktree_list', 'git_worktree_remove',
])

// ── scratch repo ──────────────────────────────────────────────────────────
const base = mkdtempSync(join(tmpdir(), 'dsh-gw-schema-'))
const execAt = (cwd) => ({ agent: { session: { header: { cwd } } }, signal: new AbortController().signal })

let assertions = 0
const check = (name, schema, value) => {
  const violations = validateJsonSchemaValue(schema, value, 'value')
  assert.deepEqual(
    violations,
    [],
    `${name} output must conform to its declared schema; violations: ${violations.join('; ')}`,
  )
  assertions += 1
}

try {
  execFileSync('git', ['init', '-b', 'main', base], { stdio: 'ignore' })
  execFileSync('git', ['-C', base, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', base, 'config', 'user.name', 'Test'])
  writeFileSync(join(base, 'a.txt'), 'hello\n')
  execFileSync('git', ['-C', base, 'add', '.'])
  execFileSync('git', ['-C', base, 'commit', '-m', 'init'], { stdio: 'ignore' })

  const exec = execAt(base)

  // git_session_binding: primary-worktree session (unbound) — the schema must
  // accept every field, including the worktree/peer absolutePath.
  const binding = await tools.git_session_binding.execute({}, exec)
  check('git_session_binding', tools.git_session_binding.output.schema, binding)
  assert.equal(binding.bound, false, 'primary-worktree session is unbound')
  assert.equal(binding.worktree.primary, true, 'the primary worktree is reported as primary')

  // git_session_binding (non-repo): `repo` and `worktree` are null — the first
  // declared worktree path must accept null.
  const nonRepoBase = mkdtempSync(join(tmpdir(), 'dsh-gw-nonrepo-'))
  try {
    const nonRepoBinding = await tools.git_session_binding.execute({}, execAt(nonRepoBase))
    assert.equal(nonRepoBinding.notARepo, true, 'non-repo dir reports notARepo')
    assert.equal(nonRepoBinding.repo, null, 'non-repo binding reports repo null')
    assert.equal(nonRepoBinding.worktree, null, 'non-repo binding reports worktree null')
    check('git_session_binding (nonrepo)', tools.git_session_binding.output.schema, nonRepoBinding)
  } finally {
    rmSync(nonRepoBase, { recursive: true, force: true })
  }

  // git_repo_status: clean repo, no binding attached; then with a worktree
  // present so the binding block (incl. absolutePath) is exercised.
  const status = await tools.git_repo_status.execute({}, exec)
  check('git_repo_status', tools.git_repo_status.output.schema, status)

  // git_worktree_add: create a worktree (also gives git_worktree_list a real
  // second row to report).
  const added = await tools.git_worktree_add.execute({ name: 'wt-conf' }, exec)
  check('git_worktree_add', tools.git_worktree_add.output.schema, added)
  const wtPath = added.path
  assert.ok(wtPath.includes('.dsh-wt'), 'worktree placed under .dsh-wt')
  assertions += 1

  // git_repo_status from INSIDE the linked worktree: the binding attaches and
  // reports bound:true (repo status in a linked session must work).
  const linkedExec = execAt(added.absolutePath)
  const linkedStatus = await tools.git_repo_status.execute({ repo: added.absolutePath }, linkedExec)
  check('git_repo_status (linked worktree)', tools.git_repo_status.output.schema, linkedStatus)
  assert.equal(linkedStatus.binding.bound, true, 'linked-worktree session is bound')
  assert.equal(linkedStatus.binding.worktree.primary, false, 'linked worktree is not primary')
  const linkedBinding = await tools.git_session_binding.execute({}, linkedExec)
  check('git_session_binding (linked)', tools.git_session_binding.output.schema, linkedBinding)
  assert.equal(linkedBinding.bound, true, 'linked session binding is bound')

  // git_worktree_add (detached): the row reports branch: null — the schema
  // must accept it (git_session_binding / git_repo_status binding blocks and
  // git_worktree_list share this shape).
  const addedDetached = await tools.git_worktree_add.execute({ name: 'wt-detach', detach: true }, exec)
  check('git_worktree_add (detached)', tools.git_worktree_add.output.schema, addedDetached)
  assert.equal(addedDetached.branch, null, 'detached worktree reports branch null')
  const detachedPath = addedDetached.path
  assertions += 1
  // A session bound to the DETACHED worktree reports branch:null through the
  // binding schema too (nullable branch inside the nullable worktree object).
  const detachedBinding = await tools.git_session_binding.execute({}, execAt(addedDetached.absolutePath))
  check('git_session_binding (detached)', tools.git_session_binding.output.schema, detachedBinding)
  assert.equal(detachedBinding.bound, true, 'detached worktree session is still bound')
  assert.equal(detachedBinding.worktree.branch, null, 'detached binding reports branch null')

  // git_worktree_list: THE regression — the operation returns
  // worktrees[].absolutePath, which the declared schema must declare; the
  // detached row also carries branch: null.
  const listed = await tools.git_worktree_list.execute({}, exec)
  check('git_worktree_list', tools.git_worktree_list.output.schema, listed)
  assert.ok(Array.isArray(listed.worktrees) && listed.worktrees.length >= 3, 'lists primary + created + detached worktrees')
  assert.ok(
    listed.worktrees.every((wt) => typeof wt.absolutePath === 'string'),
    'every worktree row carries absolutePath',
  )
  assert.ok(
    listed.worktrees.some((wt) => wt.detached && wt.branch === null),
    'detached row reports branch null and still validates',
  )
  assertions += 3

  // git_repo_status again — now the binding block attaches (worktree peers
  // carry absolutePath too).
  const statusBound = await tools.git_repo_status.execute({}, exec)
  check('git_repo_status (bound)', tools.git_repo_status.output.schema, statusBound)

  // The SECOND declared worktree path: git_repo_status.binding.worktree must
  // accept null too (the operation's no-match branch returns null there). A
  // real no-match is rare, so validate the declared path directly.
  check('git_repo_status binding worktree null', tools.git_repo_status.output.schema, {
    ...statusBound,
    binding: { ...statusBound.binding, worktree: null },
  })

  // Nullable widening must not weaken either object branch: an unknown key or
  // a non-object worktree is still rejected at BOTH declared paths.
  const goodWorktree = {
    path: '.', absolutePath: '/repo', branch: null, head: null,
    detached: false, primary: true, current: true,
  }
  const sessionMalformed = {
    bound: false, notARepo: false, repo: '/repo',
    worktree: { ...goodWorktree, bogus: 1 },
    peers: [],
  }
  const statusMalformed = {
    bound: false, notARepo: false, repo: '/repo',
    worktree: { ...goodWorktree, bogus: 1 },
    peers: [],
  }
  for (const [label, schema, value] of [
    ['git_session_binding', tools.git_session_binding.output.schema, sessionMalformed],
    ['git_repo_status binding', tools.git_repo_status.output.schema.properties.binding, statusMalformed],
  ]) {
    const unknown = validateJsonSchemaValue(schema, value, 'value')
    assert.ok(unknown.some((v) => v.includes('worktree')), `${label} must reject an unknown worktree key: ${unknown.join('; ')}`)
    assertions += 1
    const wrongType = validateJsonSchemaValue(schema, { ...value, worktree: 'nope' }, 'value')
    assert.ok(wrongType.some((v) => v.includes('worktree')), `${label} must reject a non-object worktree: ${wrongType.join('; ')}`)
    assertions += 1
  }

  // git_branch_list: local + all (remote-tracking rows, if any).
  const branches = await tools.git_branch_list.execute({}, exec)
  check('git_branch_list', tools.git_branch_list.output.schema, branches)
  const branchesAll = await tools.git_branch_list.execute({ all: true }, exec)
  check('git_branch_list (all)', tools.git_branch_list.output.schema, branchesAll)

  // git_branch_create (with switch) → git_branch_switch back → git_branch_delete
  // round trip: delete only a branch that is not checked out anywhere.
  const created = await tools.git_branch_create.execute({ name: 'br-conf', switch: true }, exec)
  check('git_branch_create', tools.git_branch_create.output.schema, created)
  const switched = await tools.git_branch_switch.execute({ name: 'main' }, exec)
  check('git_branch_switch', tools.git_branch_switch.output.schema, switched)
  const deleted = await tools.git_branch_delete.execute({ name: 'br-conf' }, exec)
  check('git_branch_delete', tools.git_branch_delete.output.schema, deleted)

  // git_worktree_remove: the created worktrees (branches stay).
  const removed = await tools.git_worktree_remove.execute({ path: wtPath }, exec)
  check('git_worktree_remove', tools.git_worktree_remove.output.schema, removed)
  const removedDetached = await tools.git_worktree_remove.execute({ path: detachedPath }, exec)
  check('git_worktree_remove (detached)', tools.git_worktree_remove.output.schema, removedDetached)

  // ── task tools (13-tool strict schemas, incl. nullable/error outcomes) ────
  const taskDir = join(base, '.git', 'dsh-git-worktree', 'tasks')
  mkdirSync(taskDir, { recursive: true })
  const completedId = 'task-0123456789abcdef'
  const completedRecord = {
    version: 1,
    taskId: completedId,
    name: 'conf-task',
    repoRoot: base,
    worktreePath: join(base, '.dsh-wt', 'conf-task'),
    branch: 'conf-task',
    base: null,
    status: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    owner: { pid: process.pid, startedAt: 0 },
    parentSessionId: 'parent',
    sessionId: 'child',
    summary: 'done',
    commit: 'abc123',
    error: null,
    setup: { ok: false, commands: [['x']], failedCommand: ['x'], exitCode: null, output: 'o' },
    integration: null,
  }
  writeFileSync(join(taskDir, `${completedId}.json`), JSON.stringify(completedRecord, null, 2))

  const taskStatus = await tools.git_task_status.execute({ taskId: completedId }, exec)
  check('git_task_status (one)', tools.git_task_status.output.schema, taskStatus)
  assert.equal(taskStatus.tasks[0].taskId, completedId)
  const taskList = await tools.git_task_status.execute({}, exec)
  check('git_task_status (list)', tools.git_task_status.output.schema, taskList)
  const cancelled = await tools.git_task_cancel.execute({ taskId: completedId }, exec)
  check('git_task_cancel (finished)', tools.git_task_cancel.output.schema, cancelled)

  // An unavailable agents service is a clear error, not a schema violation.
  await assert.rejects(
    tools.git_task_start.execute({ name: 'x', prompt: 'p' }, exec),
    /agents service/i,
    'task start without the agents service must fail clearly',
  )

  // Nullable-heavy and fully-populated synthetic summaries both validate.
  const nullSummary = {
    taskId: completedId, name: 'x', status: 'preparing', branch: null, worktreePath: '/r/wt',
    repo: '/r', base: null, sessionId: null, summary: null, commit: null, error: null,
    createdAt: null, updatedAt: null, setup: null, integration: null,
  }
  check('git_task_start summary (nullable)', tools.git_task_start.output.schema, nullSummary)
  check('git_task_status item (nullable)', tools.git_task_status.output.schema, { tasks: [nullSummary] })
  const fullSummary = {
    ...nullSummary, status: 'completed', branch: 'b', sessionId: 's', summary: 'done', commit: 'abc',
    createdAt: 't', updatedAt: 't',
    setup: { ok: false, failedCommand: ['a'], exitCode: null, output: 'o' },
    integration: {
      status: 'verified', verified: true, targetWorktreePath: '/r', targetBranch: 'main',
      mergedCommit: 'abc', targetHeadAtMerge: 'def', conflicts: [],
      verification: {
        commands: [['a']], verified: true, at: 't',
        results: [{ command: ['a'], exitCode: 0, timedOut: false, ok: true, output: '' }],
      },
    },
  }
  check('git_task_status item (full)', tools.git_task_status.output.schema, { tasks: [fullSummary] })
  check('git_task_status item (null verification)', tools.git_task_status.output.schema, {
    tasks: [{ ...fullSummary, integration: { ...fullSummary.integration, verification: null } }],
  })

  // Strictness has teeth: an unknown summary key must still be rejected.
  const unknownViolations = validateJsonSchemaValue(tools.git_task_start.output.schema, { ...nullSummary, bogus: 1 }, 'value')
  assert.ok(unknownViolations.some((v) => v.includes('bogus')), `start schema must reject unknown keys: ${unknownViolations.join('; ')}`)
  assertions += 1

  // integrate output: verified, unverified (no commands), and conflicted shapes.
  const integrateSchema = tools.git_task_integrate.output.schema
  const verifiedOut = {
    taskId: completedId, status: 'verified', merged: true, verified: true, conflicts: [],
    verification: {
      commands: [['a']], verified: true, at: 't',
      results: [{ command: ['a'], exitCode: 0, timedOut: false, ok: true, output: '' }],
    },
    target: { repo: '/r', worktreePath: '/r', branch: 'main', headBefore: 'a', headAfter: 'b' },
    message: 'm',
  }
  check('git_task_integrate (verified)', integrateSchema, verifiedOut)
  check('git_task_integrate (unverified)', integrateSchema, { ...verifiedOut, status: 'unverified', verified: false, verification: null })
  check('git_task_integrate (conflicted)', integrateSchema, {
    taskId: completedId, status: 'conflicted', merged: false, verified: false, conflicts: ['f'],
    verification: null,
    target: { repo: '/r', worktreePath: '/r', branch: 'main', headBefore: 'a', headAfter: null },
    message: 'm',
  })
  await assert.rejects(
    tools.git_task_integrate.execute({ taskId: 'task-0000000000000000' }, exec),
    /no task record/i,
    'integrating an unknown task is a clear refusal',
  )

  // ── teeth check: the validator must actually flag an undeclared property,
  // or this suite proves nothing. Replay the pre-fix drift: git_worktree_list
  // schema without absolutePath must reject the operation's output. ─────────
  const driftSchema = structuredClone(tools.git_worktree_list.output.schema)
  for (const key of Object.keys(driftSchema.properties.worktrees.items.properties)) {
    if (key === 'absolutePath') delete driftSchema.properties.worktrees.items.properties[key]
  }
  const violations = validateJsonSchemaValue(driftSchema, listed, 'value')
  assert.ok(
    violations.some((v) => v.includes('absolutePath') && v.includes('not a declared property')),
    'validator must reject the drifted schema — this suite has teeth',
  )
  assertions += 1

  console.log(`✅ schema conformance: ${assertions} assertions passed (all 13 tools conform to their declared output schemas)`)
} finally {
  rmSync(base, { recursive: true, force: true })
}
