/**
 * Agent-facing tool definitions for dsh-git-worktree. Thin `defineTool`
 * wrappers over the shared operations; every tool resolves the repo from its
 * `repo` argument (default: the session workspace) and returns plain JSON.
 *
 * All tools are exclusive by default (no `isConcurrencySafe`) — git branch and
 * worktree state is shared mutable state.
 *
 * @module dsh-git-worktree/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as ops from './operations.js'

/** Shared parameter spec: the repo directory, defaulting to the session workspace. */
const REPO_PARAM = {
  type: 'string',
  description: 'Directory of the git repository. Defaults to the session workspace; a relative path resolves against it.',
}

const STRING_PARAM = (description, extra = {}) => ({ type: 'string', description, ...extra })

const BOOL_PARAM = (description, extra = {}) => ({ type: 'boolean', description, ...extra })

/**
 * A field git legitimately reports as absent: `branch`/`head` on a detached
 * worktree, `sha`/`upstream` on a branch with none. The operations return
 * `null` for these, so the declared schema must accept it — the harness
 * rejects `null` against a plain `{ type: 'string' }` at dispatch.
 */
const NULLABLE_STRING = { oneOf: [{ type: 'string' }, { type: 'null' }] }

/** Text-only renderer for a tool whose value is already presentation-ready. */
const textRender = (text) => (_args, value) => [{ type: 'text', text: text(value) }]

/**
 * Register all git worktree/branch tools into `ctx.tools`.
 * @param ctx - plugin context with a `tools` service.
 * @param caps - resolved plugin config (worktreesDir, timeoutMs, byte caps).
 */
export function registerGitTools(ctx, caps) {
  ctx.tools.register(defineTool({
    name: 'git_session_binding',
    description: "Report this conversation's worktree binding: the repository, the worktree this session's workspace lives in, its checked-out branch, and every peer worktree. `bound` is true only when the session has its own dedicated (non-primary) worktree. Call this at the start of a conversation — before git_repo_status — to confirm which worktree and branch you are on. If `bound` is false (you share the primary worktree) and you are about to run work that must not collide with other conversations on the same project, propose creating a bound conversation instead of working directly in the shared worktree.",
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bound: { type: 'boolean', required: true },
          notARepo: { type: 'boolean', required: true },
          repo: { type: 'string' },
          worktree: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string' },
              absolutePath: { type: 'string' },
              branch: NULLABLE_STRING,
              head: NULLABLE_STRING,
              detached: { type: 'boolean' },
              primary: { type: 'boolean' },
              current: { type: 'boolean' },
            },
          },
          peers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string' },
                absolutePath: { type: 'string' },
                branch: NULLABLE_STRING,
                head: NULLABLE_STRING,
                detached: { type: 'boolean' },
                primary: { type: 'boolean' },
              },
            },
          },
        },
      },
      render: textRender((v) => {
        if (v.notARepo) return 'this conversation is not inside a git repository — nothing is bound'
        if (v.worktree === null) return `repo ${v.repo}: inside the repository but in no registered worktree`
        const tags = []
        if (v.worktree.primary) tags.push('primary')
        if (v.worktree.current) tags.push('this session')
        if (v.worktree.detached) tags.push('detached')
        const lines = [
          `repo ${v.repo}`,
          `worktree ${v.worktree.path} — ${v.worktree.branch ?? '(detached)'} @ ${v.worktree.head ?? '?'}${tags.length ? ` [${tags.join(', ')}]` : ''}`,
        ]
        lines.push(v.bound
          ? 'bound: this conversation has its own dedicated worktree'
          : 'not bound: sharing the primary worktree with other conversations')
        const peers = v.peers.filter((p) => p.absolutePath !== v.worktree.absolutePath)
        if (peers.length > 0) lines.push(`peers: ${peers.map((p) => `${p.path} (${p.branch ?? 'detached'})`).join(', ')}`)
        return lines.join('\n')
      }),
    },
    timeoutMs: caps.timeoutMs,
    async execute(args, exec) {
      return ops.sessionBinding(ctx, exec, args, caps)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'git_repo_status',
    description: 'Overview of the git repository containing the given directory (default: the session workspace): current branch, ahead/behind counts, dirty entries, and — when the query targets this session\'s own repository — the session\'s worktree binding. Use this at the start of a conversation to confirm which worktree and branch you are on, and that the working tree is clean before switching.',
    parameters: { repo: REPO_PARAM },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          branch: NULLABLE_STRING,
          ahead: { type: 'integer' },
          behind: { type: 'integer' },
          clean: { type: 'boolean', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                x: { type: 'string' },
                y: { type: 'string' },
                path: { type: 'string' },
              },
            },
          },
          binding: {
            type: 'object',
            additionalProperties: false,
            properties: {
              bound: { type: 'boolean', required: true },
              notARepo: { type: 'boolean', required: true },
              repo: { type: 'string' },
              worktree: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string' },
                  absolutePath: { type: 'string' },
                  branch: NULLABLE_STRING,
                  head: NULLABLE_STRING,
                  detached: { type: 'boolean' },
                  primary: { type: 'boolean' },
                  current: { type: 'boolean' },
                },
              },
              peers: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    path: { type: 'string' },
                    absolutePath: { type: 'string' },
                    branch: NULLABLE_STRING,
                    head: NULLABLE_STRING,
                    detached: { type: 'boolean' },
                    primary: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
      render: textRender((v) => {
        const head = v.branch ?? '(detached)'
        const sync = v.ahead || v.behind ? ` (ahead ${v.ahead}, behind ${v.behind})` : ''
        const dirty = v.clean ? 'clean' : `${v.entries.length} dirty entr${v.entries.length === 1 ? 'y' : 'ies'}`
        const lines = [`repo ${v.root}: branch ${head}${sync}, ${dirty}`]
        if (v.binding !== undefined && v.binding.worktree !== null) {
          lines.push(v.binding.bound
            ? `  bound: dedicated worktree ${v.binding.worktree.path} (branch ${v.binding.worktree.branch ?? 'detached'})`
            : '  not bound: sharing the primary worktree')
        }
        for (const e of v.entries) lines.push(`  ${e.x}${e.y} ${e.path}`)
        return lines.join('\n')
      }),
    },
    timeoutMs: caps.timeoutMs,
    async execute(args, exec) {
      return ops.repoStatus(ctx, exec, args, caps)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'git_worktree_list',
    description: 'List every git worktree of the repository containing the given directory (default: the session workspace), with its checked-out branch, HEAD, and whether it is the primary worktree or the current session\'s worktree. Use this before creating or removing worktrees, and when multiple conversations share one project, to see the overall layout.',
    parameters: { repo: REPO_PARAM },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          worktrees: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                absolutePath: { type: 'string' },
                branch: NULLABLE_STRING,
                head: NULLABLE_STRING,
                detached: { type: 'boolean' },
                bare: { type: 'boolean' },
                primary: { type: 'boolean' },
                current: { type: 'boolean' },
              },
            },
          },
        },
      },
      render: textRender((v) => {
        const lines = [`repo ${v.root}: ${v.worktrees.length} worktree(s)`]
        for (const wt of v.worktrees) {
          const tags = []
          if (wt.primary) tags.push('primary')
          if (wt.current) tags.push('this session')
          if (wt.detached) tags.push('detached')
          lines.push(`  ${wt.path} — ${wt.branch ?? '(detached)'} @ ${wt.head ?? '?'}${tags.length ? ` [${tags.join(', ')}]` : ''}`)
        }
        return lines.join('\n')
      }),
    },
    timeoutMs: caps.timeoutMs,
    async execute(args, exec) {
      return ops.worktreeList(ctx, exec, args, caps)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'git_worktree_add',
    description: 'Create a git worktree for this repository — an isolated working directory sharing the same .git. This is the primary tool for running multiple conversations on one project: each conversation gets its own worktree + branch, so concurrent agents never step on each other. Give a `name` to place the worktree at <repo>/<worktreesDir>/<name> (recommended, conventional), or an explicit `path`. Use `newBranch` to create and check out a fresh branch; `branch` checks out an existing branch; `commitIsh` bases a new branch on a specific commit. After creating, tell the user the worktree path — a new conversation can be opened rooted at that directory.',
    parameters: {
      repo: REPO_PARAM,
      name: STRING_PARAM('Short feature/bugfix name; the worktree is created at <repo>/<worktreesDir>/<name> (default .dsh-wt). Mutually exclusive with `path`.'),
      path: STRING_PARAM('Explicit worktree directory. Mutually exclusive with `name`; a relative path resolves against the session workspace.'),
      branch: STRING_PARAM('Existing branch to check out in the new worktree.'),
      newBranch: STRING_PARAM('Create a new branch with this name and check it out in the new worktree (git worktree add -b).'),
      commitIsh: STRING_PARAM('Commit/branch/tag to base the worktree on (used with newBranch or detach).'),
      detach: BOOL_PARAM('Check out a detached HEAD at commitIsh (or HEAD).'),
      force: BOOL_PARAM('Pass --force to git worktree add (allows reusing an existing directory).'),
      unique: BOOL_PARAM('Auto-deduplicate name collisions by appending -2, -3, … when the worktree path or auto-created branch already exists. Ignored when an explicit `newBranch` is given.'),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          absolutePath: { type: 'string' },
          branch: NULLABLE_STRING,
          detached: { type: 'boolean' },
        },
      },
      render: textRender((v) => `worktree created at ${v.path}${v.branch ? ` on branch ${v.branch}` : ''}${v.detached ? ' (detached)' : ''}`),
    },
    timeoutMs: caps.timeoutMs,
    async execute(args, exec) {
      return ops.worktreeAdd(ctx, exec, args, caps)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'git_worktree_remove',
    description: 'Remove a git worktree of the repository containing the given directory. Only paths registered as worktrees of this repo are accepted; the primary worktree (repo root) is refused; the branch is kept after removal. Use --force via `force` when the worktree has uncommitted changes.',
    parameters: {
      repo: REPO_PARAM,
      path: STRING_PARAM('The worktree directory to remove (as listed by git_worktree_list).', { required: true }),
      force: BOOL_PARAM('Pass --force to git worktree remove (removes uncommitted changes in that worktree).'),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'string', required: true },
        },
      },
      render: textRender((v) => `worktree removed: ${v.removed}`),
    },
    timeoutMs: caps.timeoutMs,
    async execute(args, exec) {
      return ops.worktreeRemove(ctx, exec, args, caps)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'git_branch_list',
    description: 'List branches of the repository containing the given directory: name, short sha, whether it is the currently checked-out branch of the primary worktree, and its upstream. Set `all` to also include remote-tracking branches.',
    parameters: {
      repo: REPO_PARAM,
      all: BOOL_PARAM('Also list remote-tracking branches (git for-each-ref refs/remotes).'),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          branches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                head: { type: 'boolean' },
                sha: NULLABLE_STRING,
                upstream: NULLABLE_STRING,
                remote: { type: 'boolean' },
              },
            },
          },
        },
      },
      render: textRender((v) => {
        const lines = [`repo ${v.root}: ${v.branches.length} branch(es)`]
        for (const b of v.branches) {
          lines.push(`  ${b.head ? '*' : ' '} ${b.name} @ ${b.sha ?? '?'}${b.upstream ? ` -> ${b.upstream}` : ''}${b.remote ? ' (remote)' : ''}`)
        }
        return lines.join('\n')
      }),
    },
    timeoutMs: caps.timeoutMs,
    async execute(args, exec) {
      return ops.branchList(ctx, exec, args, caps)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'git_branch_create',
    description: 'Create a branch in the repository containing the given directory. `from` optionally names the commit/branch/tag to branch off (default: current HEAD). Set `switch` to check the new branch out in the current worktree after creating.',
    parameters: {
      repo: REPO_PARAM,
      name: STRING_PARAM('New branch name.', { required: true }),
      from: STRING_PARAM('Commit/branch/tag to branch from (default: current HEAD).'),
      switch: BOOL_PARAM('Check out the new branch in the current worktree after creating.'),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          switched: { type: 'boolean' },
        },
      },
      render: textRender((v) => `branch ${v.name} created${v.switched ? ' and checked out' : ''}`),
    },
    timeoutMs: caps.timeoutMs,
    async execute(args, exec) {
      return ops.branchCreate(ctx, exec, args, caps)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'git_branch_switch',
    description: 'Switch the current worktree to another branch (git switch). Fails with git\'s own error when the working tree has changes that would be overwritten. Set `create` to create the branch if it does not exist.',
    parameters: {
      repo: REPO_PARAM,
      name: STRING_PARAM('Branch to switch to.', { required: true }),
      create: BOOL_PARAM('Create the branch if it does not exist (git switch -c).'),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          created: { type: 'boolean' },
        },
      },
      render: textRender((v) => `switched to ${v.name}${v.created ? ' (created)' : ''}`),
    },
    timeoutMs: caps.timeoutMs,
    async execute(args, exec) {
      return ops.branchSwitch(ctx, exec, args, caps)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'git_branch_delete',
    description: 'Delete a branch of the repository containing the given directory. Git refuses to delete a branch that is checked out in any worktree (including other conversations\' worktrees) — that is a feature: surface the error instead of forcing. Set `force` to use -D (discards unmerged commits).',
    parameters: {
      repo: REPO_PARAM,
      name: STRING_PARAM('Branch to delete.', { required: true }),
      force: BOOL_PARAM('Force delete (-D), discarding unmerged commits.'),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          deleted: { type: 'boolean' },
        },
      },
      render: textRender((v) => `branch ${v.name} deleted`),
    },
    timeoutMs: caps.timeoutMs,
    async execute(args, exec) {
      return ops.branchDelete(ctx, exec, args, caps)
    },
  }))
}
