/**
 * Panel REST routes for dsh-git-worktree, served by `ctx.webServer` under the
 * `/dsh-git-worktree` prefix. Plain same-origin JSON — the browser panel calls
 * these with fetch. The dev-facing webserver applies no auth by design (see
 * dsh-host-webserver); bind posture stays loopback unless a deployment
 * deliberately exposes it.
 *
 * Every handler returns `{ ok: true, data }` (200) or
 * `{ ok: false, error: { message, exitCode? } }` (400 for git/argument
 * failures, 500 for unexpected errors). The read routes (`status`, `list`)
 * are the panel's probe surface: a path that is not inside a git repository
 * answers `{ ok: true, data: { notARepo: true, ... } }` so the panel can
 * render a hint instead of an error; mutations and the agent tools keep the
 * strict 400.
 *
 * @module dsh-git-worktree/routes
 */
import { GitError, isNotARepoError, sessionCwd } from './git.js'
import * as ops from './operations.js'

const PREFIX = '/dsh-git-worktree'

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function ok(res, data) {
  json(res, 200, { ok: true, data })
}

function fail(res, status, message, exitCode) {
  json(res, status, { ok: false, error: { message, ...(exitCode !== undefined ? { exitCode } : {}) } })
}

/**
 * Client/request-level failure (malformed JSON, oversized body). Distinct from
 * GitError so the catch-all maps it to a 4xx instead of a 500 — a bad request
 * is the caller's fault, not the server's.
 */
class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (c) => {
      chunks.push(c)
      total += c.length
      if (total > 1_000_000) {
        reject(new HttpError(413, 'request body too large'))
      }
    })
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new HttpError(400, `invalid JSON body: ${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Execute a git operation behind an abort signal that fires after the timeout,
 * so a hung git never leaks past the request.
 */
async function withTimeout(ctx, caps, fn) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), caps.timeoutMs)
  try {
    return await fn(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Read-side guard: resolve a "not a git repository" failure to an empty
 * result the panel renders as a hint; every other git failure stays strict.
 * @param fn - the operation call.
 * @param empty - the tolerant success payload for this operation.
 */
async function tolerantRead(fn, empty) {
  try {
    return await fn()
  } catch (error) {
    if (isNotARepoError(error)) return empty
    throw error
  }
}

function routeExec(req) {
  // No agent on the host route path: the panel passes the repo explicitly, and
  // the git run carries its own abort signal from withTimeout.
  return { cwd: process.cwd(), signal: null }
}

/**
 * Register the panel routes.
 * @param ctx - context (used for effect lifecycle).
 * @param webServer - the `webServer` service, resolved via ctx.get by the caller.
 * @param caps - resolved plugin config (timeoutMs, byte caps).
 */
export function registerRoutes(ctx, webServer, caps) {
  const handle = async (req, res) => {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      fail(res, 400, 'malformed request URL')
      return
    }
    const pathname = url.pathname
    if (!pathname.startsWith(PREFIX)) {
      fail(res, 404, 'not found')
      return
    }
    const action = pathname.slice(PREFIX.length).replace(/^\/+|\/+$/g, '')
    const exec = routeExec(req)
    try {
      switch (action) {
        case 'status': {
          if (req.method !== 'GET') return fail(res, 405, 'method not allowed')
          const args = { repo: url.searchParams.get('repo') ?? undefined }
          const data = await withTimeout(ctx, caps, (signal) => tolerantRead(
            () => ops.repoStatus(ctx, { ...exec, signal }, args, caps),
            { notARepo: true, root: null, branch: null, ahead: 0, behind: 0, clean: true, entries: [] },
          ))
          return ok(res, data)
        }
        case 'list': {
          if (req.method !== 'GET') return fail(res, 405, 'method not allowed')
          const args = { repo: url.searchParams.get('repo') ?? undefined }
          const data = await withTimeout(ctx, caps, (signal) => tolerantRead(
            () => ops.worktreeList(ctx, { ...exec, signal }, args, caps),
            { notARepo: true, root: null, worktrees: [] },
          ))
          return ok(res, data)
        }
        case 'branches': {
          if (req.method !== 'GET') return fail(res, 405, 'method not allowed')
          const args = {
            repo: url.searchParams.get('repo') ?? undefined,
            all: url.searchParams.get('all') === '1' || url.searchParams.get('all') === 'true',
          }
          const data = await withTimeout(ctx, caps, (signal) => ops.branchList(ctx, { ...exec, signal }, args, caps))
          return ok(res, data)
        }
        case 'add': {
          if (req.method !== 'POST') return fail(res, 405, 'method not allowed')
          const body = await readBody(req)
          const args = { ...body, repo: body.repo ?? undefined }
          const data = await withTimeout(ctx, caps, (signal) => ops.worktreeAdd(ctx, { ...exec, signal }, args, caps))
          return ok(res, data)
        }
        case 'remove': {
          if (req.method !== 'POST') return fail(res, 405, 'method not allowed')
          const body = await readBody(req)
          const args = { ...body, repo: body.repo ?? undefined }
          const data = await withTimeout(ctx, caps, (signal) => ops.worktreeRemove(ctx, { ...exec, signal }, args, caps))
          return ok(res, data)
        }
        case 'bindings': {
          if (req.method !== 'POST') return fail(res, 405, 'method not allowed')
          const body = await readBody(req)
          const args = { paths: body.paths }
          const data = await withTimeout(ctx, caps, (signal) => ops.resolveBindings(ctx, { ...exec, signal }, args, caps))
          return ok(res, data)
        }
        default:
          return fail(res, 404, `unknown action: ${action || '(empty)'}`)
      }
    } catch (error) {
      if (error instanceof HttpError) {
        return fail(res, error.status, error.message)
      }
      if (error instanceof GitError) {
        return fail(res, 400, error.message, error.exitCode)
      }
      return fail(res, 500, error instanceof Error ? error.message : String(error))
    }
  }
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: handle,
  }), 'dsh-git-worktree: panel routes')
}

export { PREFIX, sessionCwd }
