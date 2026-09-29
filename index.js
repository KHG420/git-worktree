/**
 * dsh-git-worktree — Git branch & worktree management for DeepSeek Harness.
 *
 * Host half: registers the agent-facing git tools (`git_repo_status`,
 * `git_worktree_*`, `git_branch_*`) plus the panel REST routes under
 * `/dsh-git-worktree` when a webServer is present. The browser half ships via
 * exports["./client"] (see client.js).
 *
 * Tools register on the HOST plane (this row lives in the profile
 * composition), so every agent sees them (agent -> preset -> global).
 *
 * @module dsh-git-worktree
 */
import z from '@deepseek-ai/schemastery'
import { registerGitTools, registerTaskTools } from './lib/tools.js'
import { createTaskRuntime } from './lib/tasks.js'
import { registerRoutes } from './lib/routes.js'

/** Cordis plugin name used by loader diagnostics. */
const name = 'git-worktree'

/** Services required by the tool suite; webServer is optional (read via ctx.get). */
const inject = [
  'tools',
  'subprocess',
  'systemPrompt',
]

const Config = z.object({
  /** Default parent directory for new worktrees, relative to the repo root. */
  worktreesDir: z.string().default('.dsh-wt'),
  /** Cooperative per-command timeout in milliseconds. */
  timeoutMs: z.number().default(30000),
  /** Cap on captured git stdout per command. */
  stdoutMaxBytes: z.number().default(1_000_000),
  /** Cap on the retained git stderr excerpt per command. */
  stderrMaxBytes: z.number().default(64 * 1024),
  /**
   * Optional argv setup commands (no shell) run sequentially in each new task
   * worktree before its child agent launches. Default: none — never copies
   * `.env` or installs anything implicitly. A non-empty array of non-empty
   * string arrays; an invalid shape fails plugin loading.
   */
  setupCommands: z.array(z.array(z.string().min(1)).min(1)).default([]),
})

/** Guard rails: positive integers, or timeout/retention arithmetic misbehaves. */
function assertPositiveInteger(label, value) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`git-worktree: ${label} must be a positive integer`)
}

/**
 * Register the git worktree/branch tools and the panel routes.
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration from schemastery.
 */
async function apply(ctx, config) {
  const resolved = config
  assertPositiveInteger('timeoutMs', resolved.timeoutMs)
  assertPositiveInteger('stdoutMaxBytes', resolved.stdoutMaxBytes)
  assertPositiveInteger('stderrMaxBytes', resolved.stderrMaxBytes)

  const caps = { ...resolved }

  // Worktrees owned by a live task in THIS plugin runtime (preparing setup
  // included, and retained through an unfinished disposal). Shared with the
  // removal operations so `git_worktree_remove` and its HTTP route refuse to
  // delete a directory a task is actively using, even with `force` and even
  // when no native agents service exists.
  caps.taskWorktreePaths = new Set()

  registerGitTools(ctx, caps)

  // Task runtime: local records + native child agents. `shutdown()` stops and
  // disposes every child this plugin owns, persisting an honest state, when the
  // plugin (or the parent that owns it) is disposed.
  const tasks = createTaskRuntime(caps)
  registerTaskTools(ctx, caps, tasks)
  // Return the shutdown promise so cordis disposal awaits the drain instead of
  // letting owned setup/child work outlive the plugin. When a child handle
  // still cannot be disposed, `shutdown()` rejects (the persistent `failed`
  // record and the retained handle remain the source of truth); surface that to
  // the host log rather than turning teardown into an unhandled rejection. A
  // later teardown retries the retained handle.
  ctx.effect(() => () => tasks.shutdown().catch((error) => {
    const text = `git-worktree: task teardown could not dispose every child: ${error.message}`
    if (ctx.logger !== undefined && typeof ctx.logger.error === 'function') ctx.logger.error(text)
    else console.error(text)
  }))

  // Panel routes: the webServer service initializes asynchronously (it listens
  // after this plugin's apply), so wait for it dynamically rather than reading
  // ctx.get at apply time — `ctx.inject` starts the callback once the service
  // is available. Deployments without a webserver (headless) keep the tools
  // and simply never mount the routes.
  ctx.inject(['webServer'], (scoped) => {
    registerRoutes(scoped, scoped.webServer, caps)
  })

  ctx.systemPrompt.section({
    name: 'tool:git-worktree',
    order: 120,
    text: 'When multiple conversations work on the same project, keep each conversation in its own git worktree ("binding"). Start a conversation by checking git_session_binding to confirm which worktree and branch you are on: `bound` means the session has its own dedicated (non-primary) worktree — bindings are NOT exclusive locks, so another conversation may still share that worktree. When the host exposes the native agents registry, querying the binding fails with a clear occupancy error if another RUNNING agent (a child subagent included) is working in the same worktree; git_worktree_remove likewise refuses running occupants (the caller included), even with `force`. That check is same-host only, not a cross-process lock (minimal profiles without the agents service keep working, without the signal). In the sidebar workspace tree, every worktree is registered as its own flat project row — the main worktree IS the project folder (marked 主工作树), and sessions opened inside a worktree appear on that worktree\'s row. If this conversation is NOT bound (it shares the primary worktree) and the user wants to start parallel work on the same repo, propose creating a bound conversation: either the user clicks the ＋ on the project folder in the sidebar (repo + feature name → 创建绑定会话), or you create the worktree with git_worktree_add (give it a `name` to place it at <repo>/.dsh-wt/<name> and create a fresh branch; pass `unique: true` to auto-dedupe collisions, or an explicit branch/newBranch/detach to override) and the user starts a session in it by clicking that worktree row\'s ＋. A name-based worktree inside the repo gets a local info/exclude rule so `git add -A` in the main worktree does not stage it as a gitlink. Never assume a shared worktree is safe: consult git_worktree_list and the binding occupancy signal before starting. Clean up finished worktrees with git_worktree_remove — the branch is kept; if archiving bound sessions or unregistering the folder fails after a successful removal, report it and retry only the unfinished cleanup. For independent parallel work, prefer the task workflow: git_task_start creates a fresh worktree+branch plus a native child agent whose cwd is frozen there (it inherits YOUR model and permission scope, never widened, and cannot start nested tasks). Poll git_task_status; git_task_cancel stops a task this process owns and keeps its worktree/branch; git_task_integrate merges a completed task\'s committed branch into a target worktree with real git (no force/reset/push), refuses active, dirty, uncommitted-source, running-writer, and source==target cases, leaves conflicts for manual resolution, and runs explicit verifyCommands — a merge with no commands is explicitly unverified, and a failed verification must be fixed before retrying (the merge itself is not repeated). A task child does not see this conversation, so give every task a self-contained prompt. Cross-process limits still apply: a task record owned by another live DSH process is reported, never signalled or overwritten.',
  })
}

export default { name, inject, Config, apply }
export { name, inject, Config, apply }
