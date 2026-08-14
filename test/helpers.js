/**
 * Shared scaffolding for the dsh-git-worktree standalone test suites.
 *
 * - A faithful fake of the `ctx.subprocess` seam over real child processes:
 *   bounded collected output with lossy truncation (maxBytes), abort-signal →
 *   kill, and a test-only killAfterMs hook to exercise the killed-by-signal
 *   path. Production code only ever sees the same surface the real seam
 *   exposes (spawn(spec) → { collected, done }).
 * - A fake plugin ctx that captures tool registrations and webServer route
 *   registrations, then boots the REAL plugin `apply`.
 * - Scratch git repo builders (plain repo, unborn repo, bare remote).
 *
 * These tests run against the real `git` binary; every scratch repo lives in
 * a mkdtemp root that is removed on exit unless KEEP_SCRATCH is set.
 */

import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── subprocess seam fake ────────────────────────────────────────────────────

function makeCollector(maxBytes) {
  const chunks = []
  let total = 0
  let truncated = false
  return {
    push(c) {
      if (truncated) return
      const room = maxBytes - total
      if (room <= 0) {
        truncated = true
        return
      }
      if (c.length > room) {
        chunks.push(c.subarray(0, room))
        truncated = true
        total = maxBytes
      } else {
        chunks.push(c)
        total += c.length
      }
    },
    result() {
      return { text: Buffer.concat(chunks).toString('utf8'), lossy: truncated }
    },
  }
}

/**
 * Build a fake ctx.subprocess. Test-only hooks (never produced by production
 * code; the real seam has no such fields):
 * - `killAfterMs` — force-kills every spawned child after that many ms so
 *   tests can exercise runGit's "killed by signal" path without an abort.
 * - `slowCommands` — a Set of git subcommand names (spec.argv[1]) whose spawn
 *   is replaced with `sleep 30`, so an abort/kill deterministically lands
 *   mid-run instead of racing a fast git command.
 */
export function makeSubprocess({ killAfterMs = null, slowCommands = null } = {}) {
  return {
    spawn(spec) {
      const argv = slowCommands?.has(spec.argv[1]) ? ['sleep', '30'] : spec.argv
      const child = spawn(argv[0], argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const stdout = makeCollector(spec.stdio?.stdout?.maxBytes ?? Infinity)
      const stderr = makeCollector(spec.stdio?.stderr?.maxBytes ?? Infinity)
      child.stdout.on('data', (c) => stdout.push(c))
      child.stderr.on('data', (c) => stderr.push(c))
      const collected = {
        stdout: { readFrom: () => stdout.result() },
        stderr: { readFrom: () => stderr.result() },
      }
      const done = new Promise((resolve, reject) => {
        child.on('error', reject)
        child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
      })
      spec.signal?.addEventListener?.('abort', () => child.kill('SIGTERM'), { once: true })
      if (killAfterMs !== null) setTimeout(() => child.kill('SIGKILL'), killAfterMs)
      return { collected, done }
    },
  }
}

// ── plugin boot ─────────────────────────────────────────────────────────────

/**
 * Boot the real plugin against a fake ctx. Returns the tool registry (by
 * name), the webServer route registrations, and the fake ctx.
 */
export async function bootPlugin({ caps = {}, subprocess } = {}) {
  const registered = []
  const routeRegistrations = []
  const ctx = {
    subprocess: subprocess ?? makeSubprocess(),
    tools: { register: (tool) => registered.push(tool) },
    systemPrompt: { section: () => {} },
    effect: (fn) => fn(),
    inject: (names, callback) => {
      const scoped = { ...ctx, webServer: { register: (route) => routeRegistrations.push(route) } }
      callback(scoped)
      return { await: async () => {} }
    },
  }
  const plugin = (await import('../index.js')).default
  await plugin.apply(ctx, {
    worktreesDir: '.dsh-wt',
    timeoutMs: 30000,
    stdoutMaxBytes: 1_000_000,
    stderrMaxBytes: 64 * 1024,
    ...caps,
  })
  return {
    ctx,
    tools: Object.fromEntries(registered.map((t) => [t.name, t])),
    routes: routeRegistrations,
  }
}

/** A tool execution context rooted at `cwd` (the agent session header form). */
export function execAt(cwd) {
  return { agent: { session: { header: { cwd } } }, signal: new AbortController().signal }
}

/** A route-style execution context (no agent; cwd = server process cwd). */
export function routeExec() {
  return { cwd: process.cwd(), signal: null }
}

// ── scratch git repos ───────────────────────────────────────────────────────

export function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
}

/** git that is expected to fail; returns { code, stderr } instead of throwing. */
export function gitFail(dir, ...args) {
  try {
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
    return { code: 0, stderr: '' }
  } catch (error) {
    return { code: error.status, stderr: String(error.stderr ?? '') }
  }
}

/** Create and initialize a scratch root; returned root is removed on process exit. */
export function scratchRoot(label = 'dsh-gw') {
  const root = mkdtempSync(join(tmpdir(), `${label}-`))
  if (process.env.KEEP_SCRATCH !== '1') process.on('exit', () => rmSync(root, { recursive: true, force: true }))
  return root
}

/** A normal repo with one commit on main. Returns the repo dir. */
export function makeRepo(root, name = 'repo') {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  commitFile(dir, 'a.txt', 'hello\n', 'init')
  return dir
}

/** A repo with no commits yet (unborn branch). */
export function makeUnbornRepo(root, name = 'unborn') {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  return dir
}

/** A bare repo usable as a remote. Returns the remote dir. */
export function makeBareRemote(root, name = 'remote.git') {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '--bare', '-b', 'main')
  return dir
}

export function commitFile(dir, file, content, message = 'commit') {
  writeFileSync(join(dir, file), content)
  git(dir, 'add', file)
  git(dir, 'commit', '-m', message)
  return git(dir, 'rev-parse', 'HEAD').toString().trim()
}
