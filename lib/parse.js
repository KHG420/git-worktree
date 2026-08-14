/**
 * Pure parsers for git machine-readable output. No I/O here — each function
 * maps one command's stdout into plain JSON, so the same parsers serve both
 * the agent tools and the panel REST routes.
 *
 * @module dsh-git-worktree/parse
 */

/**
 * Parse `git worktree list --porcelain` output:
 *
 *   worktree /abs/path
 *   HEAD abcdef1234
 *   branch refs/heads/feature-a
 *   (or `detached` / `bare`)
 *
 * @returns Array<{ path, head, branch, detached, bare }>
 */
export function parseWorktreeList(text) {
  const worktrees = []
  let current = null
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd()
    if (line === '') {
      current = null
      continue
    }
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), head: null, branch: null, detached: false, bare: false }
      worktrees.push(current)
    } else if (current !== null) {
      if (line.startsWith('HEAD ')) current.head = line.slice(5)
      else if (line.startsWith('branch refs/heads/')) current.branch = line.slice('branch refs/heads/'.length)
      else if (line === 'detached') current.detached = true
      else if (line === 'bare') current.bare = true
    }
  }
  return worktrees
}

/**
 * Parse `git for-each-ref --format=... refs/heads` output:
 *   <refname:short>\t<HEAD>\t<objectname:short>\t<upstream:short>
 * The HEAD marker is '*' for the ref the CALLER's repository HEAD points at —
 * the branch checked out in the caller's worktree (the primary worktree when
 * the command runs there, the linked worktree when it runs inside one).
 *
 * @returns Array<{ name, head, sha, upstream }>
 */
export function parseBranchList(text) {
  const branches = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const [name, head, sha, upstream] = line.split('\t')
    if (name === undefined || name === '') continue
    branches.push({
      name,
      head: head === '*',
      sha: sha ?? null,
      upstream: upstream && upstream !== '' ? upstream : null,
    })
  }
  return branches
}

/**
 * Parse `git status --short --branch` output:
 *   ## main...origin/main [ahead 1, behind 2]
 *   M  path
 *   ?? untracked
 *
 * @returns {{ branch, ahead, behind, entries: Array<{x, y, path}> }}
 */
export function parseStatus(text) {
  let branch = null
  let ahead = 0
  let behind = 0
  const entries = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    if (line.startsWith('## ')) {
      const head = line.slice(3)
      let name = head.split('...')[0]
      // Detached HEAD reports `## HEAD (no branch)` — treat any HEAD-led name
      // as detached (bare `## HEAD` appears on some git versions).
      if (name === 'HEAD' || name === 'HEAD (no branch)' || name === '') {
        name = '(detached)'
      } else {
        // Empty (unborn) repositories report `## No commits yet on main`
        // (older git: `## Initial commit on main`) — the branch name is what
        // follows the phrase, not the phrase itself.
        const unborn = name.match(/^(?:No commits yet on|Initial commit on) (.+)$/)
        if (unborn) name = unborn[1]
      }
      branch = name
      const aheadMatch = head.match(/ahead (\d+)/)
      const behindMatch = head.match(/behind (\d+)/)
      ahead = aheadMatch ? Number(aheadMatch[1]) : 0
      behind = behindMatch ? Number(behindMatch[1]) : 0
    } else if (line.length >= 4) {
      entries.push({ x: line[0], y: line[1], path: line.slice(3) })
    }
  }
  return { branch, ahead, behind, entries }
}
