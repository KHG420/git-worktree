/**
 * Git execution plumbing for dsh-git-worktree.
 *
 * All git commands run through the `ctx.subprocess` seam — explicit argv, no
 * shell layer, scrubbed environment, cooperative cancellation — mirroring the
 * reference implementation in @deepseek-ai/dsh-tool-fs-search. Nothing here
 * ever builds a shell string.
 *
 * @module dsh-git-worktree/git
 */
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { realpathSync, statSync } from 'node:fs'

/** Structured git failure carrying the exit code and retained stderr excerpt. */
export class GitError extends Error {
  constructor(message, exitCode = -1, stderr = '') {
    super(message)
    this.name = 'GitError'
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

/**
 * The session's working directory as git operations anchor to: the agent's
 * session header cwd, falling back to the process cwd for host-side callers
 * (webServer routes) that have no agent.
 * @param exec - tool execution context, or a bare { cwd } for route callers.
 */
export function sessionCwd(exec) {
  return exec?.agent?.session?.header?.cwd ?? exec?.cwd ?? process.cwd()
}

/**
 * Resolve a path argument against a base directory. Absolute paths pass
 * through; relative paths (including "." / "..") resolve against `base`.
 */
export function resolvePathArg(value, base) {
  if (value === undefined || value === null || value === '') return undefined
  return isAbsolute(value) ? value : resolve(base, value)
}

/**
 * Why a git command's working directory is unusable, or null when the spawn
 * should proceed. git cannot start in a directory that is missing or is a
 * plain file — Node's spawn then fails with ENOENT/ENOTDIR, which surfaces as
 * the opaque "could not start git: spawn git ENOENT" and bypasses the
 * not-a-repository tolerance. That matters in practice: a session workspace
 * whose directory was deleted (e.g. a removed worktree whose session record
 * lives on) would otherwise 400 the panel's whole `bindings` refresh, since
 * every session cwd is joined in one call. Classifying the missing directory
 * as "not a git repository" lets read-side tolerance degrade that one path
 * per-row while mutations surface an accurate message. Exotic stat failures
 * (e.g. EACCES) return null and let the spawn error surface as before.
 */
function gitCwdProblem(cwd) {
  try {
    return statSync(cwd).isDirectory() ? null : 'not a directory'
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 'no such directory'
    return null
  }
}

/**
 * Run one git command and return its complete captured stdout/stderr.
 *
 * @param ctx - plugin context with a `subprocess` service.
 * @param exec - carries the abort signal; host-side route callers pass a
 *   synthetic `{ signal }`.
 * @param opts.args - git argv AFTER the `git` binary (no `-C`; cwd is the spec).
 * @param opts.cwd - process working directory for the command.
 * @param opts.allowExitCodes - exit codes treated as success (e.g. 1).
 * @returns {{ stdout: string, stderr: string, exitCode: number }}
 */
export async function runGit(ctx, exec, opts) {
  const caps = {
    stdoutMaxBytes: opts.stdoutMaxBytes ?? 1_000_000,
    stderrMaxBytes: opts.stderrMaxBytes ?? 64 * 1024,
    graceMs: opts.graceMs ?? 3000,
  }
  const signal = exec?.signal ?? new AbortController().signal
  if (signal.aborted) throw new GitError('aborted before git started', -1, '')

  const cwdProblem = typeof opts.cwd === 'string' ? gitCwdProblem(opts.cwd) : null
  if (cwdProblem !== null) {
    throw new GitError(`not a git repository: ${opts.cwd} (${cwdProblem})`, -1, '')
  }

  let handle
  try {
    handle = ctx.subprocess.spawn({
      argv: ['git', ...opts.args],
      cwd: opts.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: caps.stdoutMaxBytes },
        stderr: { maxBytes: caps.stderrMaxBytes },
      },
      graceMs: caps.graceMs,
      signal,
    })
  } catch (error) {
    if (signal.aborted) throw new GitError('aborted before git started', -1, '')
    throw new GitError(`could not start git: ${error.message}`, -1, '')
  }

  let outcome
  try {
    outcome = await handle.done
  } catch (error) {
    throw new GitError(`could not start git: ${error.message}`, -1, '')
  }
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  if (stdout === undefined || stderr === undefined) {
    throw new GitError('git produced no collected output streams', -1, '')
  }
  if (signal.aborted) throw new GitError('aborted while git ran', -1, '')
  if (outcome.signal !== null || outcome.exitCode === null) {
    throw new GitError(`git was killed by signal ${outcome.signal ?? '(unknown)'}`, -1, stderr.text)
  }
  const exitCode = outcome.exitCode
  if (exitCode !== 0 && !(opts.allowExitCodes ?? []).includes(exitCode)) {
    const excerpt = stderr.text.trim()
    throw new GitError(`git exited ${exitCode}${excerpt ? `: ${excerpt}` : ''}`, exitCode, stderr.text)
  }
  return { stdout: stdout.text, stderr: stderr.text, exitCode }
}

/**
 * Resolve the git repository root for a requested directory. Returns the
 * absolute top-level path; throws GitError when the directory is not inside a
 * repository.
 */
export async function resolveRepo(ctx, exec, dir, caps) {
  const res = await runGit(ctx, exec, {
    args: ['rev-parse', '--show-toplevel'],
    cwd: dir,
    ...caps,
  })
  const root = res.stdout.trim()
  if (!root) throw new GitError(`not a git repository: ${dir}`, -1, '')
  return root
}

/**
 * True when the error means the requested directory is not inside a git
 * repository. Read-side panel routes use this to answer "not a repo" as data
 * instead of an error; mutations and the agent tools keep the strict failure.
 */
export function isNotARepoError(error) {
  return error instanceof GitError && /not a git repository/.test(error.message)
}

export { gitCwdProblem }

/**
 * Display form for a path: repo-relative when inside the anchor, absolute
 * otherwise. Keeps tool output short and follow-up-readable.
 */
export function toDisplayPath(path, anchor) {
  if (!isAbsolute(path)) return path
  const rel = relative(anchor, path)
  if (rel.length === 0) return '.'
  if (rel === '..' || rel.startsWith(`..${sep}`)) return path
  return rel
}

/**
 * Canonicalize a path for equality comparisons and display. git reports
 * realpath-resolved paths (e.g. /private/var/... on macOS while the session
 * cwd may be the /var symlink form), so string comparisons must run on
 * canonical forms. A nonexistent path passes through unchanged.
 */
export function canonicalize(p) {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** Default parent directory for new worktrees, relative to the repo root. */
export const DEFAULT_WORKTREES_DIR = '.dsh-wt'
