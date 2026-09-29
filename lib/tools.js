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

/**
 * The worktree object the binding operations report. Shared by
 * `git_session_binding.worktree` and `git_repo_status.binding.worktree` (the
 * two identical shapes) and widened to accept `null`: `bindingForCwd` returns
 * a real object for a directory inside a registered worktree, but the
 * operations return `null` both for a non-repo workspace
 * (`sessionBinding(notARepo)`) and for the no-match branch, and the renderers
 * already branch on `worktree === null`. The object branch stays strict
 * (`additionalProperties: false`) so a malformed object, an unknown key, or a
 * wrong scalar type is still rejected.
 */
const NULLABLE_WORKTREE = {
  oneOf: [
    { type: 'null' },
    {
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
  ],
}

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
    description: "Report this conversation's worktree binding: the repository, the worktree this session's workspace lives in, its checked-out branch, and every peer worktree. `bound` means the session has its own dedicated (non-primary) worktree — it is NOT exclusivity: another conversation can share the same worktree, and `bound` says nothing about who else is writing there. When the host exposes the native agents registry and another RUNNING agent (a child subagent included) resolves to this same worktree, the tool fails with a clear occupancy error instead of reporting a safe-looking binding; an idle peer is not reported as actively writing. Call this at the start of a conversation — before git_repo_status — to confirm which worktree and branch you are on. If `bound` is false (you share the primary worktree) and you are about to run work that must not collide with other conversations on the same project, propose creating a bound conversation instead of working directly in the shared worktree.",
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bound: { type: 'boolean', required: true },
          notARepo: { type: 'boolean', required: true },
          repo: NULLABLE_STRING,
          worktree: NULLABLE_WORKTREE,
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
          ? 'bound: this conversation has its own dedicated (non-primary) worktree — not exclusive; another conversation may still share it'
          : 'not bound: sharing the primary worktree with other conversations (bindings are not locks)')
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
    description: 'Overview of the git repository containing the given directory (default: the session workspace): current branch, ahead/behind counts, dirty entries, and — when the query targets this session\'s own repository — the session\'s worktree binding. `binding.bound` is the non-exclusive, non-primary meaning (another conversation may share the worktree); it is not a claim that this session is alone. When the host\'s agents registry reports another RUNNING agent (a child subagent included) in the same worktree, the tool fails with a clear occupancy error instead of a safe-looking binding. Use this at the start of a conversation to confirm which worktree and branch you are on, and that the working tree is clean before switching.',
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
              worktree: NULLABLE_WORKTREE,
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
            ? `  bound: dedicated (non-primary) worktree ${v.binding.worktree.path} (branch ${v.binding.worktree.branch ?? 'detached'}) — not exclusive`
            : '  not bound: sharing the primary worktree (bindings are not locks)')
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
    description: 'Create a git worktree for this repository — an isolated working directory sharing the same .git. This is the primary tool for running multiple conversations on one project: each conversation gets its own worktree + branch, so parallel work does not share a working tree (a binding is a dedicated-worktree marker, not an exclusive lock). Give a `name` to place the worktree at <repo>/<worktreesDir>/<name> (recommended, conventional), or an explicit `path`. A name-based request with no explicit branch/newBranch/detach/commitIsh creates and checks out a FRESH branch named after the name\'s last path component, so an existing unchecked-out branch is never silently reused; with `unique: true` a collision becomes a new suffixed worktree+branch (-2, -3, …), with `unique: false` git\'s strict error surfaces. Use `newBranch` to name the fresh branch explicitly; `branch` checks out an existing branch; `commitIsh` bases the worktree on a specific commit. A name-based worktree nested inside its own repository also gets a local `info/exclude` rule so `git add -A` in the main worktree does not stage it as a gitlink. After creating, tell the user the worktree path — a new conversation can be opened rooted at that directory.',
    parameters: {
      repo: REPO_PARAM,
      name: STRING_PARAM('Short feature/bugfix name; the worktree is created at <repo>/<worktreesDir>/<name> (default .dsh-wt). Mutually exclusive with `path`.'),
      path: STRING_PARAM('Explicit worktree directory. Mutually exclusive with `name`; a relative path resolves against the session workspace.'),
      branch: STRING_PARAM('Existing branch to check out in the new worktree.'),
      newBranch: STRING_PARAM('Create a new branch with this name and check it out in the new worktree (git worktree add -b).'),
      commitIsh: STRING_PARAM('Commit/branch/tag to base the worktree on (used with newBranch or detach).'),
      detach: BOOL_PARAM('Check out a detached HEAD at commitIsh (or HEAD).'),
      force: BOOL_PARAM('Pass --force to git worktree add (allows reusing an existing directory).'),
      unique: BOOL_PARAM('Auto-deduplicate name collisions by appending -2, -3, … when the worktree path or the name-based branch already exists. Ignored when an explicit `newBranch` is given.'),
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
    description: 'Remove a git worktree of the repository containing the given directory. Only paths registered as worktrees of this repo are accepted; the primary worktree (repo root) is refused; the branch is kept after removal. Refuses while a RUNNING native agent (the caller included) is working in that worktree — a same-host check, not a cross-process lock — even with `force`. Use --force via `force` when the worktree has uncommitted changes.',
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

/**
 * Register the agent-facing task tools (`git_task_*`). They wrap the local
 * record + native child-agent runtime in `lib/tasks.js`; the 9 original git
 * tools are untouched.
 * @param ctx - plugin context (subprocess, agents via the caller's ctx).
 * @param caps - resolved plugin config (timeout/byte caps, setupCommands).
 * @param tasks - runtime returned by `createTaskRuntime`.
 */
export function registerTaskTools(ctx, caps, tasks) {
  ctx.tools.register(defineTool({
    name: 'git_task_start',
    description: 'Start an independent task in its own fresh git worktree + branch and hand it to a new native child agent whose working directory is frozen to that worktree at creation. The child inherits THIS conversation\'s model and permission scope (never widened) and cannot start nested tasks (depth cap). Use this to fan out independent work from the main conversation: assign each task a name and a self-contained prompt, then poll git_task_status. `base` optionally pins the fresh branch to a commit/branch/tag. A failing or timed-out configured setup command stops before the child launches and reports bounded diagnostics, keeping the worktree for inspection. Returns promptly with the task id, worktree, branch, and status `preparing`.',
    parameters: {
      name: STRING_PARAM('Short task/feature name; the worktree lands at <repo>/<worktreesDir>/<name> with a fresh branch of the same name (auto-suffixed on collision).', { required: true }),
      prompt: STRING_PARAM('The complete, self-contained task for the child agent. The child does not see this conversation, so include everything it needs.', { required: true }),
      repo: REPO_PARAM,
      base: STRING_PARAM('Commit/branch/tag to create the fresh task branch from (default: the repository HEAD).'),
    },
    output: {
      schema: TASK_SUMMARY_SCHEMA,
      render: textRender((v) => `task ${v.taskId} ${v.status}: ${v.worktreePath} (branch ${v.branch ?? 'detached'})`),
    },
    timeoutMs: caps.timeoutMs,
    async execute(args, exec) {
      return tasks.start(ctx, exec, args)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'git_task_status',
    description: 'List this repository\'s local task records — state, task id, worktree, branch, child session id, final summary, commit, and error where applicable — or one task when `taskId` is given. Records live under the shared git common dir, so a linked worktree sees the same tasks. A task still active in another live DSH process is reported as-is (not overwritten); a record whose owner process is gone is marked `interrupted`. Use this to poll tasks started with git_task_start.',
    parameters: {
      repo: REPO_PARAM,
      taskId: STRING_PARAM('Show only this task id (from git_task_start).'),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tasks: { type: 'array', required: true, items: TASK_SUMMARY_SCHEMA },
        },
      },
      render: textRender((v) => {
        if (v.tasks.length === 0) return 'no tasks recorded for this repository'
        return v.tasks.map((task) => {
          const parts = [`${task.taskId} [${task.status}] ${task.worktreePath} (${task.branch ?? 'detached'})`]
          if (task.sessionId) parts.push(`  session ${task.sessionId}`)
          if (task.commit) parts.push(`  commit ${task.commit}`)
          if (task.summary) parts.push(`  summary: ${task.summary}`)
          if (task.error) parts.push(`  error: ${task.error}`)
          return parts.join('\n')
        }).join('\n')
      }),
    },
    timeoutMs: caps.timeoutMs,
    async execute(args, exec) {
      return tasks.status(ctx, exec, args)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'git_task_cancel',
    description: 'Stop a task started by git_task_start in THIS process: abort its setup or cancel and drain its child agent, then persist an honest `cancelled` state. The worktree and branch are preserved. Cancelling an already-finished task is a no-op. If the child cannot be disposed the task stays `failed` with its handle and worktree reservation retained for retry, and the call errors instead of reporting a clean cancel. A task owned by another live DSH process is reported as a limitation and never signalled.',
    parameters: {
      repo: REPO_PARAM,
      taskId: STRING_PARAM('The task id to cancel.', { required: true }),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          cancelled: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: textRender((v) => `task ${v.taskId}: ${v.status} — ${v.message}`),
    },
    timeoutMs: caps.timeoutMs,
    async execute(args, exec) {
      return tasks.cancel(ctx, exec, args)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'git_task_integrate',
    description: 'Merge a completed task\'s committed branch into the TARGET worktree (`repo`, default this session\'s worktree) using real git — never force/reset/clean and never push. Rejects active, dirty, or uncommitted-source tasks, a dirty target, running writers, and source==target. Conflicts are left in place with recovery instructions. After a successful merge it runs the explicit `verifyCommands` (argv arrays, no shell); a non-zero/timeout verification is NOT accepted and a retry reruns verification without merging again. With no verifyCommands the merge is reported as explicitly unverified. The source worktree/branch is kept.',
    parameters: {
      repo: REPO_PARAM,
      taskId: STRING_PARAM('The completed task id to integrate.', { required: true }),
      verifyCommands: {
        type: 'array',
        description: 'Verification commands to run in the target worktree after merging; each entry is a non-empty argv array (no shell).',
        items: { type: 'array', items: { type: 'string' } },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          merged: { type: 'boolean', required: true },
          verified: { type: 'boolean', required: true },
          conflicts: { type: 'array', required: true, items: { type: 'string' } },
          verification: { oneOf: [{ type: 'null' }, VERIFICATION_SCHEMA] },
          target: {
            type: 'object',
            additionalProperties: false,
            properties: {
              repo: { type: 'string', required: true },
              worktreePath: { type: 'string', required: true },
              branch: { type: 'string', required: true },
              headBefore: { type: 'string', required: true },
              headAfter: NULLABLE_STRING,
            },
          },
          message: { type: 'string', required: true },
        },
      },
      render: textRender((v) => {
        const verification = v.verification === null ? 'not verified (no commands)' : v.verification.verified ? 'verified' : 'verification failed'
        return `task ${v.taskId}: ${v.status} (merged: ${v.merged}, ${verification})\n${v.message}`
      }),
    },
    timeoutMs: caps.timeoutMs,
    async execute(args, exec) {
      return tasks.integrate(ctx, exec, args)
    },
  }))
}

/** Nullable integer for exit codes (a signaled/timeout command has no code). */
const NULLABLE_INT = { oneOf: [{ type: 'integer' }, { type: 'null' }] }

/**
 * Verification result shared by `git_task_integrate.verification` and the
 * `git_task_status` integration block.
 */
const VERIFICATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    commands: { type: 'array', required: true, items: { type: 'array', items: { type: 'string' } } },
    verified: { type: 'boolean', required: true },
    at: NULLABLE_STRING,
    results: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'array', required: true, items: { type: 'string' } },
          exitCode: NULLABLE_INT,
          timedOut: { type: 'boolean', required: true },
          ok: { type: 'boolean', required: true },
          output: { type: 'string', required: true },
        },
      },
    },
  },
}

/** One task record as reported by `git_task_start` / `git_task_status`. */
const TASK_SETUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    failedCommand: { oneOf: [{ type: 'null' }, { type: 'array', items: { type: 'string' } }] },
    exitCode: NULLABLE_INT,
    output: { type: 'string', required: true },
  },
}

/** The integration block attached to a task summary. */
const TASK_INTEGRATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true },
    verified: { type: 'boolean', required: true },
    targetWorktreePath: NULLABLE_STRING,
    targetBranch: NULLABLE_STRING,
    mergedCommit: NULLABLE_STRING,
    targetHeadAtMerge: NULLABLE_STRING,
    conflicts: { type: 'array', required: true, items: { type: 'string' } },
    verification: { oneOf: [{ type: 'null' }, VERIFICATION_SCHEMA] },
  },
}

/** The stable task summary shape returned by start/status. */
const TASK_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    taskId: { type: 'string', required: true },
    name: { type: 'string', required: true },
    status: { type: 'string', required: true },
    branch: NULLABLE_STRING,
    worktreePath: { type: 'string', required: true },
    repo: { type: 'string', required: true },
    base: NULLABLE_STRING,
    sessionId: NULLABLE_STRING,
    summary: NULLABLE_STRING,
    commit: NULLABLE_STRING,
    error: NULLABLE_STRING,
    createdAt: NULLABLE_STRING,
    updatedAt: NULLABLE_STRING,
    setup: { oneOf: [{ type: 'null' }, TASK_SETUP_SCHEMA] },
    integration: { oneOf: [{ type: 'null' }, TASK_INTEGRATION_SCHEMA] },
  },
}
