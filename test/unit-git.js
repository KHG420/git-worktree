/**
 * Unit tests for lib/git.js: path/display helpers and the runGit plumbing —
 * exit-code handling, allowExitCodes, abort-before-start, abort-while-running,
 * killed-by-signal, missing cwd, byte caps, spawn failures.
 *
 * Run: node test/unit-git.js
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import {
  DEFAULT_WORKTREES_DIR,
  GitError,
  canonicalize,
  gitCwdProblem,
  isNotARepoError,
  resolvePathArg,
  runGit,
  sessionCwd,
  toDisplayPath,
} from '../lib/git.js'
import { makeSubprocess, scratchRoot } from './helpers.js'

let passed = 0
const tests = []
const t = (name, fn) => tests.push([name, fn])

// ── sessionCwd ──────────────────────────────────────────────────────────────

t('sessionCwd: agent session header cwd wins', () => {
  assert.equal(sessionCwd({ agent: { session: { header: { cwd: '/a' } } }, cwd: '/b' }), '/a')
})

t('sessionCwd: falls back to exec.cwd then process.cwd', () => {
  assert.equal(sessionCwd({ cwd: '/b' }), '/b')
  assert.equal(sessionCwd({}), process.cwd())
  assert.equal(sessionCwd(undefined), process.cwd())
})

t('sessionCwd: missing agent session layers degrade safely', () => {
  assert.equal(sessionCwd({ agent: {} }), process.cwd())
  assert.equal(sessionCwd({ agent: { session: {} } }), process.cwd())
})

// ── resolvePathArg ──────────────────────────────────────────────────────────

t('resolvePathArg: undefined/null/empty pass through as undefined', () => {
  assert.equal(resolvePathArg(undefined, '/base'), undefined)
  assert.equal(resolvePathArg(null, '/base'), undefined)
  assert.equal(resolvePathArg('', '/base'), undefined)
})

t('resolvePathArg: absolute passes through, relative resolves', () => {
  assert.equal(resolvePathArg('/abs', '/base'), '/abs')
  assert.equal(resolvePathArg('sub', '/base'), '/base/sub')
  assert.equal(resolvePathArg('.', '/base'), '/base')
  assert.equal(resolvePathArg('..', '/base/sub'), '/base')
})

// ── toDisplayPath ───────────────────────────────────────────────────────────

t('toDisplayPath: repo-relative inside anchor, absolute outside', () => {
  assert.equal(toDisplayPath('/r/.dsh-wt/a', '/r'), '.dsh-wt/a')
  assert.equal(toDisplayPath('/r', '/r'), '.')
  assert.equal(toDisplayPath('/other', '/r'), '/other')
  assert.equal(toDisplayPath('rel', '/r'), 'rel')
})

// ── canonicalize ────────────────────────────────────────────────────────────

t('canonicalize: real path resolves (symlinks), missing path passes through', () => {
  const root = scratchRoot('dsh-gw-git')
  assert.equal(canonicalize(root), realpathSync(root))
  assert.equal(canonicalize('/nonexistent/dsh-gw-path'), '/nonexistent/dsh-gw-path')
})

// ── gitCwdProblem ───────────────────────────────────────────────────────────

t('gitCwdProblem: dir ok, missing dir, file-as-cwd', () => {
  const root = scratchRoot('dsh-gw-git2')
  assert.equal(gitCwdProblem(root), null)
  assert.equal(gitCwdProblem(join(root, 'nope')), 'no such directory')
  const f = join(root, 'f.txt')
  writeFileSync(f, 'x')
  assert.equal(gitCwdProblem(f), 'not a directory')
})

// ── isNotARepoError ─────────────────────────────────────────────────────────

t('isNotARepoError: matches only the not-a-repo GitError', () => {
  assert.equal(isNotARepoError(new GitError('not a git repository: /x')), true)
  assert.equal(isNotARepoError(new GitError('git exited 128: fatal: something else')), false)
  assert.equal(isNotARepoError(new Error('not a git repository: /x')), false)
  assert.equal(isNotARepoError(null), false)
})

// ── runGit ──────────────────────────────────────────────────────────────────

const ctxFor = (subprocess) => ({ subprocess })
const execSig = () => ({ signal: new AbortController().signal })

t('runGit: success returns stdout/stderr/exitCode', async () => {
  const r = await runGit(ctxFor(makeSubprocess()), execSig(), {
    args: ['--version'], cwd: process.cwd(),
  })
  assert.equal(r.exitCode, 0)
  assert.match(r.stdout, /^git version /)
})

t('runGit: non-zero exit throws GitError with excerpt', async () => {
  await assert.rejects(
    runGit(ctxFor(makeSubprocess()), execSig(), { args: ['nosuchcommand-xyz'], cwd: process.cwd() }),
    (e) => e instanceof GitError && e.exitCode !== 0 && /git exited/.test(e.message),
  )
})

t('runGit: allowExitCodes accepts the listed codes', async () => {
  const root = scratchRoot('dsh-gw-git5')
  const repo = join(root, 'r')
  mkdirSync(repo, { recursive: true })
  const { git } = await import('./helpers.js')
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 'T')
  const { commitFile } = await import('./helpers.js')
  commitFile(repo, 'a.txt', 'a\n', 'init')
  writeFileSync(join(repo, 'a.txt'), 'b\n') // dirty → git diff --exit-code exits 1
  const r = await runGit(ctxFor(makeSubprocess()), execSig(), {
    args: ['diff', '--exit-code'],
    cwd: repo,
    allowExitCodes: [1],
  })
  assert.equal(r.exitCode, 1)
})

t('runGit: pre-aborted signal refuses before spawn', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    runGit(ctxFor(makeSubprocess()), { signal: controller.signal }, { args: ['--version'], cwd: process.cwd() }),
    (e) => e instanceof GitError && e.message === 'aborted before git started',
  )
})

t('runGit: abort while running surfaces aborted', async () => {
  const controller = new AbortController()
  const promise = runGit(ctxFor(makeSubprocess({ slowCommands: new Set(['status']) })), { signal: controller.signal }, {
    args: ['status'], cwd: process.cwd(),
  })
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(promise, (e) => e instanceof GitError && /aborted while git ran/.test(e.message))
})

t('runGit: child killed by signal (no abort) surfaces the kill', async () => {
  const subprocess = makeSubprocess({ killAfterMs: 50, slowCommands: new Set(['status']) })
  await assert.rejects(
    runGit(ctxFor(subprocess), execSig(), { args: ['status'], cwd: process.cwd() }),
    (e) => e instanceof GitError && /killed by signal/.test(e.message),
  )
})

t('runGit: missing cwd is a classified not-a-repo failure', async () => {
  const root = scratchRoot('dsh-gw-git3')
  await assert.rejects(
    runGit(ctxFor(makeSubprocess()), execSig(), { args: ['status'], cwd: join(root, 'gone') }),
    (e) => e instanceof GitError && e.message.includes('no such directory') && isNotARepoError(e),
  )
})

t('runGit: file-as-cwd is a classified not-a-repo failure', async () => {
  const root = scratchRoot('dsh-gw-git4')
  const f = join(root, 'f.txt')
  writeFileSync(f, 'x')
  await assert.rejects(
    runGit(ctxFor(makeSubprocess()), execSig(), { args: ['status'], cwd: f }),
    (e) => e instanceof GitError && e.message.includes('not a directory') && isNotARepoError(e),
  )
})

t('runGit: spawn failure (missing binary) is wrapped', async () => {
  const subprocess = {
    spawn() {
      throw new Error('spawn ENOENT')
    },
  }
  await assert.rejects(
    runGit(ctxFor(subprocess), execSig(), { args: ['--version'], cwd: process.cwd() }),
    (e) => e instanceof GitError && /could not start git/.test(e.message),
  )
})

t('runGit: stdout byte cap truncates lossily', async () => {
  const r = await runGit(ctxFor(makeSubprocess()), execSig(), {
    args: ['--version'], cwd: process.cwd(), stdoutMaxBytes: 8,
  })
  assert.ok(r.stdout.length <= 8, 'stdout truncated to the cap')
})

t('runGit: caps flow through to the spawn spec', async () => {
  const seen = []
  const subprocess = {
    spawn(spec) {
      seen.push(spec)
      const child = makeSubprocess().spawn(spec)
      return child
    },
  }
  await runGit(ctxFor(subprocess), execSig(), {
    args: ['--version'], cwd: process.cwd(),
    stdoutMaxBytes: 111, stderrMaxBytes: 222, graceMs: 333,
  })
  assert.equal(seen[0].stdio.stdout.maxBytes, 111)
  assert.equal(seen[0].stdio.stderr.maxBytes, 222)
  assert.equal(seen[0].graceMs, 333)
})

t('DEFAULT_WORKTREES_DIR is .dsh-wt', () => {
  assert.equal(DEFAULT_WORKTREES_DIR, '.dsh-wt')
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
console.log(`✅ unit-git: ${passed} assertions passed`)
