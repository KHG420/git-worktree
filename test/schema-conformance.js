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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

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
assert.equal(Object.keys(tools).length, 9, 'expect 9 tools registered')

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

  // git_worktree_add (detached): the row reports branch: null — the schema
  // must accept it (git_session_binding / git_repo_status binding blocks and
  // git_worktree_list share this shape).
  const addedDetached = await tools.git_worktree_add.execute({ name: 'wt-detach', detach: true }, exec)
  check('git_worktree_add (detached)', tools.git_worktree_add.output.schema, addedDetached)
  assert.equal(addedDetached.branch, null, 'detached worktree reports branch null')
  const detachedPath = addedDetached.path
  assertions += 1

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

  console.log(`✅ schema conformance: ${assertions} assertions passed (all 9 tools conform to their declared output schemas)`)
} finally {
  rmSync(base, { recursive: true, force: true })
}
