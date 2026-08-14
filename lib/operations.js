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
import { basename, dirname, sep } from 'node:path'
import {
  DEFAULT_WORKTREES_DIR,
  GitError,
  canonicalize,
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
  const res = await runGit(ctx, exec, {
    args: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    cwd,
    ...caps,
  })
  const common = res.stdout.trim()
  if (!common) throw new GitError('could not resolve the git common directory', -1, '')
  const abs = canonicalize(common)
  return basename(abs) === '.git' ? dirname(abs) : abs
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
  return path
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
  return bindingForCwd(ctx, exec, base, mainRoot, caps)
}

/**
 * Resolve many directories to their worktree bindings in one pass (the panel's
 * bindings join): each path is classified as not-a-repo, inside the primary
 * worktree, or inside a dedicated worktree. `git worktree list` runs once per
 * distinct repository; paths are canonicalized and deduplicated.
 */
export async function resolveBindings(ctx, exec, args, caps) {
  const inputs = Array.isArray(args.paths) ? args.paths.slice(0, 500) : []
  const seen = new Set()
  const rootCache = new Map()
  const worktreeCache = new Map()
  const bindings = []
  for (const raw of inputs) {
    if (typeof raw !== 'string' || raw === '') continue
    const path = canonicalize(raw)
    if (seen.has(path)) continue
    seen.add(path)
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
  // the session).
  const sessionMain = await primaryRootOrNull(ctx, exec, base, caps)
  if (sessionMain !== null && isInsidePath(canonicalize(root), sessionMain)) {
    data.binding = await bindingForCwd(ctx, exec, base, sessionMain, caps)
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
 * at `<root>/<worktreesDir>/<name>`. A new branch is created with `newBranch`
 * (or, when only a name is given and neither branch/newBranch/detach/commitIsh
 * is present, git creates a branch named after the path's last component).
 *
 * `unique` dedupes name collisions (the worktree path or an auto-created
 * branch) by suffixing the candidate name (-2, -3, …). The panel's one-click
 * binding flow uses it; the agent tools leave it off so git's own error
 * surfaces. An explicitly named `newBranch` is never silently renamed — a
 * collision there stays git's strict failure.
 */
export async function worktreeAdd(ctx, exec, args, caps) {
  const base = canonicalize(sessionCwd(exec))
  const root = await repoRoot(ctx, exec, args, caps)
  const dir = caps.worktreesDir || DEFAULT_WORKTREES_DIR
  let path
  let candidateName = null
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
    path = nameWorktreePath(anchor, dir, candidateName)
  } else {
    throw new GitError('git_worktree_add requires a path or a name (worktree is placed under <root>/<worktreesDir>/<name>)', -1, '')
  }

  let attempt = 0
  for (;;) {
    const argv = ['worktree', 'add']
    if (args.force) argv.push('--force')
    if (args.detach) argv.push('--detach')
    if (args.newBranch) argv.push('-b', args.newBranch)
    argv.push(path)
    if (args.commitIsh !== undefined && args.commitIsh !== '') argv.push(args.commitIsh)
    else if (args.branch !== undefined && args.branch !== '') argv.push(args.branch)
    try {
      await runGit(ctx, exec, { args: argv, cwd: root, ...caps })
      break
    } catch (error) {
      const canRetry = args.unique === true
        && candidateName !== null
        && attempt < 20
        && (args.newBranch === undefined || args.newBranch === null || args.newBranch === '')
        && error instanceof GitError
        && /already exists|already used|already checked out/.test(error.message)
      if (!canRetry) throw error
      attempt += 1
      candidateName = `${args.name}-${attempt + 1}`
      path = nameWorktreePath(anchor, dir, candidateName)
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
