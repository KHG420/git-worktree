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
import { registerGitTools } from './lib/tools.js'
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

  registerGitTools(ctx, caps)

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
    text: 'When multiple conversations work on the same project, keep each conversation in its own git worktree ("binding"). Start a conversation by checking git_session_binding to confirm which worktree and branch you are on: a conversation is `bound` when it has its own dedicated (non-primary) worktree. If this conversation is NOT bound (it shares the primary worktree) and the user wants to start parallel work on the same repo, propose creating a bound conversation: either the user creates one with one click in the plugin panel (repo + feature name → 创建绑定会话), or you create the worktree with git_worktree_add (give it a `name` to place it at <repo>/.dsh-wt/<name> and a `newBranch`, or pass `unique: true` to auto-dedupe) and the user opens a conversation there via the panel\'s 打开绑定会话 button. Never run concurrent work in the same worktree from two conversations: consult git_worktree_list before starting and do not modify files inside another worktree. Clean up finished worktrees with git_worktree_remove — the branch is kept.',
  })
}

export default { name, inject, Config, apply }
export { name, inject, Config, apply }
