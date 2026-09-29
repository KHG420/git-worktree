/**
 * Core git operations shared by the agent tools and the panel REST routes.
 * Each operation takes (ctx, exec, args, caps) and returns plain JSON.
 *
 * `exec` is either a tool execution context (has `.signal` and optionally
 * `.agent.session.header.cwd`) or a synthetic `{ cwd, signal }` from a route
 * handler. `caps` carries resolved plugin config (worktreesDir, timeout, byte
 * caps).
 *
 * @module dsh-git-worktree/operations
 */
import { basename, dirname, isAbsolute, relative, sep } from 'node:path'
import {
  DEFAULT_WORKTREES_DIR,
  GitError,
  canonicalize,
  ensureLocalExclude,
  isNotARepoError,
  resolvePathArg,
  resolveRepo,
  runGit,
  sessionCwd,
  toDisplayPath,
} from './git.js'
import { parseBranchList, parseStatus, parseWorktreeList } from './parse.js'

/** Resolve the requested repo dir to the git root, anchoring relative repo args to the base. */
async function repoRoot(ctx, exec, args, caps) {
  const base = canonicalize(sessionCwd(exec))
  const dir = args.repo === undefined ? base : resolvePathArg(args.repo, base)
  return resolveRepo(ctx, exec, dir, caps)
}

/**
 * The MAIN repository root (the primary worktree's path). `git rev-parse
 * --show-toplevel` returns the WORKTREE root when run inside a linked worktree,
 * but worktree-primary comparisons must run against the main root: the primary
 * worktree is the one whose path is the common git directory's parent.
 */
async function primaryRoot(ctx, exec, cwd, caps) {
  const abs = await commonGitDir(ctx, exec, cwd, caps)
  return basename(abs) === '.git' ? dirname(abs) : abs
}

/**
 * The repository's COMMON git directory (shared by every linked worktree), or
 * throws when the directory is not inside a repository. This is also where the
 * local `info/exclude` file lives.
 */
async function commonGitDir(ctx, exec, cwd, caps) {
  const res = await runGit(ctx, exec, {
    args: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    cwd,
    ...caps,
  })
  const common = res.stdout.trim()
  if (!common) throw new GitError('could not resolve the git common directory', -1, '')
  return canonicalize(common)
}

/** Resolve the main repo root, or null when the directory is not inside a repository. */
async function primaryRootOrNull(ctx, exec, dir, caps) {
  try {
    return await primaryRoot(ctx, exec, dir, caps)
  } catch (error) {
    if (isNotARepoError(error)) return null
    throw error
  }
}

/** True when `candidate` is `base` or a subdirectory of it (canonical forms). */
function isInsidePath(candidate, base) {
  if (candidate === base) return true
  const prefix = base.endsWith(sep) ? base : base + sep
  return candidate.startsWith(prefix)
}

/**
 * The most specific registered worktree containing `cwd`. The primary
 * worktree's path is the main repo root, so a directory under
 * `<root>/.dsh-wt/*` matches BOTH the primary and its own worktree — the
 * longest matching path wins.
 */
function longestMatch(worktrees, cwd) {
  return worktrees.reduce((best, wt) => {
    if (!isInsidePath(cwd, wt.path)) return best
    return best === null || wt.path.length > best.path.length ? wt : best
  }, null)
}

/**
 * Resolve a name-based worktree path and require it to stay inside the
 * worktrees directory under the main repo root. `resolvePathArg` normalizes
 * `..` segments, so a crafted name like `../../escape` would otherwise land
 * OUTSIDE the repo (git happily creates a worktree anywhere on disk), and
 * `../.git` would land on the repository's metadata dir. The documented
 * contract is `<root>/<worktreesDir>/<name>` — anything resolving outside
 * `<root>/<worktreesDir>/` is rejected instead of letting git run wild.
 */
function nameWorktreePath(anchor, dir, name) {
  const base = resolvePathArg(dir, anchor)
  const path = resolvePathArg(`${dir}/${name}`, anchor)
  if (!isInsidePath(path, base)) {
    throw new GitError(`worktree name must resolve inside the repository under ${dir}/: "${name}" -> ${path}`, -1, '')
  }
  return { path, base }
}

/**
 * The optional native agent registry (`ctx.get('agents')`), or null when the
 * deployment has no agent service (minimal/headless profiles). Callers must
 * treat null as "occupancy unknown" and keep working — the same-host guard is
 * a best-effort protection, not a cross-process lock.
 */
function agentsService(ctx) {
  if (ctx === null || ctx === undefined) return null
  try {
    if (typeof ctx.get === 'function') {
      const service = ctx.get('agents')
      if (service !== null && service !== undefined) return service
    }
    return ctx.agents ?? null
  } catch {
    return null
  }
}

/**
 * Running native agents whose session cwd resolves to `worktreePath` by the
 * SAME longest-match rule the binding uses — a session in a nested directory
 * belongs to the most specific registered worktree, never to every ancestor.
 *
 * Only `status === 'running'` counts as actively writing; an idle peer sharing
 * the worktree is not an occupant. `excludeId` drops the caller (querying your
 * own binding must not report yourself). Returns null when the agents service
 * is unavailable.
 */
export function runningOccupants(ctx, worktrees, worktreePath, excludeId) {
  const agents = agentsService(ctx)
  if (agents === null || typeof agents.list !== 'function') return null
  const occupants = []
  for (const agent of agents.list()) {
    if (agent === null || agent === undefined) continue
    if (agent.status !== 'running') continue
    if (excludeId !== undefined && agent.id === excludeId) continue
    const cwd = agent.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') continue
    const match = longestMatch(worktrees, canonicalize(cwd))
    if (match !== null && match.path === worktreePath) occupants.push({ id: agent.id, cwd })
  }
  return occupants
}

/** Human-readable list of occupants for an occupancy error message. */
function occupantNames(occupants) {
  return occupants.map((occupant) => (occupant.id === undefined ? occupant.cwd : `${occupant.id} (${occupant.cwd})`)).join(', ')
}

/**
 * Refuse to report a binding whose worktree is being written by another
 * RUNNING native agent (a child subagent included). The caller is ignored;
 * idle peers are not occupants. Occupancy is a same-host warning, not a lock:
 * when no agents service exists there is no signal and the binding is
 * returned unchanged (honest limitation, documented).
 */
function assertNoRunningOccupants(ctx, exec, binding) {
  if (binding === null || binding.worktree === null) return
  const worktrees = binding.peers.map((peer) => ({ path: peer.absolutePath }))
  const occupants = runningOccupants(ctx, worktrees, binding.worktree.absolutePath, exec?.agent?.id)
  if (occupants === null || occupants.length === 0) return
  throw new GitError(
    `worktree ${binding.worktree.absolutePath} is occupied by running agent(s): ${occupantNames(occupants)}. `
    + 'This is a same-host check, not a cross-process lock — stop those agents or use a different worktree before writing here.',
    -1,
    '',
  )
}

/**
 * The worktree binding of one directory inside a repository: which registered
 * worktree it lives in (a session workspace may be a subdirectory of the
 * worktree), plus every peer worktree. `mainRoot` is the primary worktree's
 * path, which is what `primary` and `bound` compare against.
 */
async function bindingForCwd(ctx, exec, cwd, mainRoot, caps) {
  const res = await runGit(ctx, exec, { args: ['worktree', 'list', '--porcelain'], cwd: mainRoot, ...caps })
  const worktrees = parseWorktreeList(res.stdout)
  const current = longestMatch(worktrees, cwd)
  const peers = worktrees.map((wt) => ({
    path: toDisplayPath(wt.path, cwd),
    absolutePath: wt.path,
    branch: wt.branch,
    head: wt.head,
    detached: wt.detached,
    primary: wt.path === mainRoot,
  }))
  const repo = toDisplayPath(mainRoot, cwd)
  if (current === null) {
    return { bound: false, notARepo: false, repo, worktree: null, peers }
  }
  return {
    bound: current.path !== mainRoot,
    notARepo: false,
    repo,
    worktree: {
      path: toDisplayPath(current.path, cwd),
      absolutePath: current.path,
      branch: current.branch,
      head: current.head,
      detached: current.detached,
      primary: current.path === mainRoot,
      current: isInsidePath(cwd, current.path),
    },
    peers,
  }
}

/**
 * This conversation's worktree binding: the repository, the worktree its
 * session workspace lives in, the checked-out branch, and peers. Tolerant of a
 * non-repo workspace — the agent learns it is unbound instead of failing.
 */
export async function sessionBinding(ctx, exec, _args, caps) {
  const base = canonicalize(sessionCwd(exec))
  const mainRoot = await primaryRootOrNull(ctx, exec, base, caps)
  if (mainRoot === null) return { bound: false, notARepo: true, repo: null, worktree: null, peers: [] }
  const binding = await bindingForCwd(ctx, exec, base, mainRoot, caps)
  // Occupancy is a same-host warning, not a lock: when another RUNNING native
  // agent (a child subagent included) resolves to this worktree, silently
  // reporting a clean binding would misrepresent it as safe to write. The
  // caller itself is ignored. No agents service → no signal → proceed.
  assertNoRunningOccupants(ctx, exec, binding)
  return binding
}

/**
 * Resolve many directories to their worktree bindings in one pass (the panel's
 * bindings join): each path is classified as not-a-repo, inside the primary
 * worktree, or inside a dedicated worktree. `git worktree list` runs once per
 * distinct repository; paths are canonicalized and deduplicated.
 */
export async function resolveBindings(ctx, exec, args, caps) {
  const inputs = Array.isArray(args.paths) ? args.paths.slice(0, 500) : []
  // Dedupe by the RAW input, one row per unique requested cwd — never by the
  // canonical path. Two distinct raw cwds that canonicalize to the same
  // worktree (a symlinked `/var` vs its `/private/var` realpath) are different
  // sessions/targets and each must get its own row; the caller maps every raw
  // cwd back to the host-resolved `worktree.path` and matches exactly there.
  // Collapsing them here would silently drop one session from the roster.
  const seen = new Set()
  const rootCache = new Map()
  const worktreeCache = new Map()
  const bindings = []
  for (const raw of inputs) {
    if (typeof raw !== 'string' || raw === '') continue
    if (seen.has(raw)) continue
    seen.add(raw)
    const path = canonicalize(raw)
    let mainRoot = rootCache.get(path)
    if (mainRoot === undefined) {
      mainRoot = await primaryRootOrNull(ctx, exec, path, caps)
      rootCache.set(path, mainRoot)
    }
    if (mainRoot === null) {
      bindings.push({ path: raw, notARepo: true, root: null, worktree: null })
      continue
    }
    let worktrees = worktreeCache.get(mainRoot)
    if (worktrees === undefined) {
      const res = await runGit(ctx, exec, { args: ['worktree', 'list', '--porcelain'], cwd: mainRoot, ...caps })
      worktrees = parseWorktreeList(res.stdout)
      worktreeCache.set(mainRoot, worktrees)
    }
    const wt = longestMatch(worktrees, path)
    bindings.push({
      path: raw,
      notARepo: false,
      root: mainRoot,
      worktree: wt === null ? null : {
        path: wt.path,
        branch: wt.branch,
        head: wt.head,
        detached: wt.detached,
        primary: wt.path === mainRoot,
      },
    })
  }
  return { bindings }
}

/** Repository overview: branch, ahead/behind, dirty entries. */
export async function repoStatus(ctx, exec, args, caps) {
  const base = canonicalize(sessionCwd(exec))
  const root = await repoRoot(ctx, exec, args, caps)
  const res = await runGit(ctx, exec, { args: ['status', '--short', '--branch'], cwd: root, ...caps })
  const parsed = parseStatus(res.stdout)
  const data = {
    root: toDisplayPath(root, base),
    branch: parsed.branch,
    ahead: parsed.ahead,
    behind: parsed.behind,
    clean: parsed.entries.length === 0,
    entries: parsed.entries,
  }
  // Attach this session's own worktree binding when the query targets a
  // directory of the session's repository (a foreign repo has no bearing on
  // the session). Compare the QUERIED repo's MAIN root with the session's:
  // `root` alone cannot be compared — inside a linked worktree
  // `rev-parse --show-toplevel` returns the WORKTREE root, which for a
  // worktree created at an explicit path outside the main root (a supported
  // `git_worktree_add` shape) would not be inside the session's main root
  // even though the query targets the session's own repository. Comparing
  // main roots also stops a nested repo inside the session repo from picking
  // up the session's binding.
  const sessionMain = await primaryRootOrNull(ctx, exec, base, caps)
  if (sessionMain !== null) {
    const queriedMain = await primaryRootOrNull(ctx, exec, root, caps)
    if (queriedMain !== null && queriedMain === sessionMain) {
      const binding = await bindingForCwd(ctx, exec, base, sessionMain, caps)
      // Same occupancy signal as git_session_binding: a status query must not
      // present a binding as safe while a running native agent shares it.
      assertNoRunningOccupants(ctx, exec, binding)
      data.binding = binding
    }
  }
  return data
}



/** All worktrees of the repo, with display paths and the current-session marker. */
export async function worktreeList(ctx, exec, args, caps) {
  const base = canonicalize(sessionCwd(exec))
  const root = await repoRoot(ctx, exec, args, caps)
  // The primary worktree is the one whose path equals the MAIN root of the
  // queried repo — resolve it from `root`, not the session cwd, so a foreign
  // repo query (panel input, explicit repo arg) gets correct `primary` flags.
  const mainRoot = (await primaryRootOrNull(ctx, exec, root, caps)) ?? root
  const res = await runGit(ctx, exec, { args: ['worktree', 'list', '--porcelain'], cwd: root, ...caps })
  const worktrees = parseWorktreeList(res.stdout)
  const current = longestMatch(worktrees, base)
  return {
    root: toDisplayPath(root, base),
    worktrees: worktrees.map((wt) => ({
      path: toDisplayPath(wt.path, base),
      absolutePath: wt.path,
      branch: wt.branch,
      head: wt.head,
      detached: wt.detached,
      bare: wt.bare,
      primary: wt.path === mainRoot,
      current: current === wt,
    })),
  }
}



/**
 * Create a worktree. `path` wins when given; otherwise the worktree is placed
 * at `<root>/<worktreesDir>/<name>`. A NAME-based request with no explicit
 * `branch`/`newBranch`/`detach`/`commitIsh` checks out a FRESH branch named
 * after the path's last component (`git worktree add -b <basename>`), so an
 * existing unchecked-out branch is never silently reused. Explicit paths keep
 * git's own inference.
 *
 * `unique` dedupes name collisions (the worktree path or an auto-created
 * branch) by suffixing the candidate name (-2, -3, …). The panel's one-click
 * binding flow uses it; the agent tools leave it off so git's own error
 * surfaces. An explicitly named `newBranch` is never silently renamed — a
 * collision there stays git's strict failure.
 *
 * Name-based worktrees that nest inside their own repository also install a
 * local (untracked, shared) `info/exclude` rule for the configured parent
 * directory, so `git add -A` in the main worktree does not stage the nested
 * worktree as an embedded gitlink.
 */
export async function worktreeAdd(ctx, exec, args, caps) {
  const base = canonicalize(sessionCwd(exec))
  const root = await repoRoot(ctx, exec, args, caps)
  const dir = caps.worktreesDir || DEFAULT_WORKTREES_DIR
  let path
  let candidateName = null
  let nameBase = null
  // Name-based worktrees land under the MAIN root of the repo being modified
  // (`root`, already resolved from the repo argument or session cwd) — never
  // nested inside a linked worktree the caller happens to sit in, and never
  // anchored to the session/process cwd when the target repo differs (the
  // panel can create a worktree for any repo while the server runs from
  // another).
  const anchor = (await primaryRootOrNull(ctx, exec, root, caps)) ?? root
  if (args.path !== undefined && args.path !== null && args.path !== '') {
    path = resolvePathArg(args.path, base)
  } else if (args.name !== undefined && args.name !== null && args.name !== '') {
    candidateName = args.name
    const resolved = nameWorktreePath(anchor, dir, candidateName)
    path = resolved.path
    nameBase = resolved.base
  } else {
    throw new GitError('git_worktree_add requires a path or a name (worktree is placed under <root>/<worktreesDir>/<name>)', -1, '')
  }

  const hasBranch = args.branch !== undefined && args.branch !== null && args.branch !== ''
  const hasNewBranch = args.newBranch !== undefined && args.newBranch !== null && args.newBranch !== ''
  const hasCommitIsh = args.commitIsh !== undefined && args.commitIsh !== null && args.commitIsh !== ''
  const implicitBranch = candidateName !== null && !hasBranch && !hasNewBranch && !hasCommitIsh && args.detach !== true

  let attempt = 0
  for (;;) {
    const argv = ['worktree', 'add']
    if (args.force) argv.push('--force')
    if (args.detach) argv.push('--detach')
    if (hasNewBranch) argv.push('-b', args.newBranch)
    else if (implicitBranch) argv.push('-b', basename(path))
    argv.push(path)
    if (hasCommitIsh) argv.push(args.commitIsh)
    else if (hasBranch) argv.push(args.branch)
    try {
      await runGit(ctx, exec, { args: argv, cwd: root, ...caps })
      break
    } catch (error) {
      const canRetry = args.unique === true
        && candidateName !== null
        && attempt < 20
        && !hasNewBranch
        && error instanceof GitError
        && /already exists|already used|already checked out|already registered/.test(error.message)
      if (!canRetry) throw error
      attempt += 1
      candidateName = `${args.name}-${attempt + 1}`
      const resolved = nameWorktreePath(anchor, dir, candidateName)
      path = resolved.path
      nameBase = resolved.base
    }
  }

  // Protect the main worktree from staging the nested worktree as a gitlink:
  // one anchored local exclude rule for the configured name-based parent. Only
  // name-based parents INSIDE the repository are touched (never explicit paths,
  // never an outside-repo parent, never the repository root). A write failure
  // is surfaced rather than reporting an unprotected success.
  if (candidateName !== null && nameBase !== null) {
    const rel = relative(anchor, nameBase)
    if (rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
      try {
        await ensureLocalExclude(await commonGitDir(ctx, exec, root, caps), rel)
      } catch (error) {
        throw new GitError(
          `worktree created at ${path}, but its local git exclusion could not be installed `
          + `(git add -A in the main worktree may stage it as a gitlink): ${error instanceof Error ? error.message : String(error)}`,
          -1,
          '',
        )
      }
    }
  }

  // Resolve the checked-out branch of the new worktree (git reports canonical paths).
  const list = await runGit(ctx, exec, { args: ['worktree', 'list', '--porcelain'], cwd: root, ...caps })
  const created = parseWorktreeList(list.stdout).find((wt) => wt.path === canonicalize(path))
  const branch = created?.branch ?? args.newBranch ?? args.branch ?? null
  return {
    path: toDisplayPath(path, base),
    absolutePath: path,
    branch,
    detached: Boolean(args.detach) || created?.detached === true,
  }
}

/**
 * Remove a worktree. Only paths registered to this repo are accepted; the
 * branch stays behind.
 */
export async function worktreeRemove(ctx, exec, args, caps) {
  const base = canonicalize(sessionCwd(exec))
  const root = await repoRoot(ctx, exec, args, caps)
  if (args.path === undefined || args.path === null || args.path === '') {
    throw new GitError('git_worktree_remove requires a path', -1, '')
  }
  const target = canonicalize(resolvePathArg(args.path, base))

  const list = await runGit(ctx, exec, { args: ['worktree', 'list', '--porcelain'], cwd: root, ...caps })
  const registered = parseWorktreeList(list.stdout)
  const found = registered.find((wt) => wt.path === target)
  if (!found) {
    const known = registered.map((wt) => wt.path).join(', ')
    throw new GitError(`not a worktree of this repo: ${args.path}${known ? ` (registered: ${known})` : ''}`, -1, '')
  }
  const mainRoot = (await primaryRootOrNull(ctx, exec, base, caps)) ?? root
  if (found.path === mainRoot) {
    throw new GitError('refusing to remove the primary worktree (the repo root)', -1, '')
  }

  // Same-host occupancy guard: refuse while any RUNNING native agent — the
  // caller included — is writing in the target worktree, even with `force`.
  // Removing the directory out from under a running writer is never what
  // `force` means; it only waives git's dirty-worktree check. An unreadable
  // agents service is not a refusal signal.
  const occupants = runningOccupants(ctx, registered, target, undefined)
  if (occupants !== null && occupants.length > 0) {
    throw new GitError(
      `refusing to remove worktree ${target}: running agent(s) ${occupantNames(occupants)} are working in it. `
      + 'This is a same-host check, not a cross-process lock — stop those agents first.',
      -1,
      '',
    )
  }

  // Plugin-runtime occupancy: a `git_task_*` task owns its worktree from the
  // moment it exists (worktree creation) until its child handle is verifiably
  // disposed — including the asynchronous `preparing` (setup) phase, before
  // any native agent exists, and any unfinished disposal. The native agents
  // check above cannot see those states, so `force` must not bypass this one.
  if (caps?.taskWorktreePaths instanceof Set && caps.taskWorktreePaths.has(target)) {
    throw new GitError(
      `refusing to remove worktree ${target}: a live git_task_* task owns it `
      + '(preparing, running, or still disposing). Cancel and drain the task first; `force` does not waive this.',
      -1,
      '',
    )
  }

  const argv = ['worktree', 'remove']
  if (args.force) argv.push('--force')
  argv.push(target)
  await runGit(ctx, exec, { args: argv, cwd: root, ...caps })
  return { removed: toDisplayPath(target, base) }
}

/** Branch list; `all` additionally includes remote-tracking branches. */
export async function branchList(ctx, exec, args, caps) {
  const base = canonicalize(sessionCwd(exec))
  const root = await repoRoot(ctx, exec, args, caps)
  const fmt = '%(refname:short)%09%(HEAD)%09%(objectname:short)%09%(upstream:short)'
  const heads = await runGit(ctx, exec, {
    args: ['for-each-ref', `--format=${fmt}`, '--sort=-committerdate', 'refs/heads'],
    cwd: root,
    ...caps,
  })
  const branches = parseBranchList(heads.stdout).map((b) => ({ ...b, remote: false }))
  if (args.all) {
    const remotes = await runGit(ctx, exec, {
      args: ['for-each-ref', `--format=${fmt}`, '--sort=-committerdate', 'refs/remotes'],
      cwd: root,
      ...caps,
    })
    for (const b of parseBranchList(remotes.stdout)) {
      branches.push({ ...b, remote: true })
    }
  }
  return { root: toDisplayPath(root, base), branches }
}

/** Create a branch; `switch` checks it out after creating. */
export async function branchCreate(ctx, exec, args, caps) {
  const root = await repoRoot(ctx, exec, args, caps)
  if (!args.name || args.name === '') throw new GitError('git_branch_create requires a name', -1, '')
  if (args.switch) {
    const argv = ['switch', '-c', args.name]
    if (args.from) argv.push(args.from)
    await runGit(ctx, exec, { args: argv, cwd: root, ...caps })
  } else {
    const argv = ['branch', args.name]
    if (args.from) argv.push(args.from)
    await runGit(ctx, exec, { args: argv, cwd: root, ...caps })
  }
  return { name: args.name, switched: Boolean(args.switch) }
}

/** Switch the current worktree's branch; `create` creates it first. */
export async function branchSwitch(ctx, exec, args, caps) {
  const root = await repoRoot(ctx, exec, args, caps)
  if (!args.name || args.name === '') throw new GitError('git_branch_switch requires a name', -1, '')
  const argv = ['switch']
  if (args.create) argv.push('-c')
  argv.push(args.name)
  await runGit(ctx, exec, { args: argv, cwd: root, ...caps })
  return { name: args.name, created: Boolean(args.create) }
}

/** Delete a branch; `force` uses -D. Git refuses branches checked out anywhere. */
export async function branchDelete(ctx, exec, args, caps) {
  const root = await repoRoot(ctx, exec, args, caps)
  if (!args.name || args.name === '') throw new GitError('git_branch_delete requires a name', -1, '')
  const argv = ['branch', args.force ? '-D' : '-d', args.name]
  await runGit(ctx, exec, { args: argv, cwd: root, ...caps })
  return { name: args.name, deleted: true }
}
