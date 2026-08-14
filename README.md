# dsh-git-worktree

面向 **DeepSeek Harness** 的 **对话 ↔ 工作树绑定** 插件：让多个会话在同一项目上并行工作，**每个会话绑定一个独立 git 工作树 + 分支**，一键创建、互不干扰。

Conversation↔worktree **binding** for **DeepSeek Harness**: run multiple conversations on one project in parallel, each bound to its own isolated git worktree + branch, created in one click.

- **绑定 / Binding** — 会话在创建时即绑定到专属工作树：工作树 + 工作区 + 会话一次成型（绑定关系可推导、可展示、可清理）。
- **Agent 工具 / Agent tools** — 9 个工具（`git_session_binding`、`git_repo_status`、`git_worktree_*`、`git_branch_*`），每个会话都可以调用。<br>9 tools (`git_session_binding`, `git_repo_status`, `git_worktree_*`, `git_branch_*`) every conversation can call.
- **浏览器面板 / Browser panel** — 侧边栏的 **Bindings** 入口：绑定管理器，列出工作树及其绑定的会话，一键创建绑定会话，删除时警告并可选归档绑定会话。<br>A sidebar **Bindings** entry: the binding manager — lists worktrees with their bound conversations, creates a bound conversation in one click, and warns about (optionally archiving) bound conversations on removal.

## 绑定是什么 / What a binding is

DSH 中，会话的工作目录（cwd）在创建时**冻结**，工作区归属要求"会话 cwd == 工作区路径"。因此绑定只能在创建会话的那一刻发生——**把会话建在专属工作树里**，绑定关系即成立：

A DSH session's cwd is **frozen at creation** and workspace membership requires the session's canonical cwd to equal the workspace path. So a binding happens at creation time: **the conversation is born inside its own worktree**:

```
~/projects/foo/                  ← 主工作树 / primary worktree (main)
├── .dsh-wt/
│   ├── feature-a/               ← 会话 A 绑定 / conversation A is bound here (branch feature-a)
│   └── bugfix-b/                ← 会话 B 绑定 / conversation B is bound here (branch bugfix-b)
└── (共享同一个 .git / one shared .git)
```

绑定关系**无需额外存储**，由 `sessions.list`（cwd）× `git worktree list`（路径→分支）× `workspaces.list` 推导而来——面板和 agent 工具看到的都是实时事实。

Bindings are **derived, not stored**: `sessions.list` (cwd) × `git worktree list` (path→branch) × `workspaces.list` — what the panel and the agent tools show is live fact.

## 一键创建绑定会话 / One-click bound conversation

在面板输入 repo 路径（默认取当前会话工作区）和功能名，点 **创建绑定会话**：

1. `git worktree add -b <name> <repo>/.dsh-wt/<name>`（重名自动加后缀 `-2`、`-3`…）
2. `workspaces.create({ path })`（幂等注册工作区）
3. `connectWorkspace` → 会话直接诞生在该工作树（绑定成立）
4. 自动打开该会话

In the panel: repo path (defaults to the current session's workspace) + feature name → **创建绑定会话 (Create bound conversation)**:

1. `git worktree add -b <name> <repo>/.dsh-wt/<name>` (name collisions auto-suffix `-2`, `-3`, …)
2. `workspaces.create({ path })` (idempotent workspace registration)
3. `connectWorkspace` → the session is born inside that worktree (the binding)
4. the new conversation opens automatically

已存在的工作树每行都有 **打开绑定会话** 按钮（agent 先建好工作树、开发者一键确认的场景）。删除带绑定会话的工作树时，面板会列出绑定会话并**可选一并归档**（日志保留，侧边栏隐藏）。

Every non-primary worktree row also has **打开绑定会话 (Open bound conversation)** — the agent-prepares / developer-confirms flow. Removing a worktree with bound conversations warns, lists them, and offers to **archive them** (logs stay; the sidebar hides them).

## 安装 / Installation

```sh
# 在插件目录下执行 / from the plugin checkout
dsh plugin --profile web add /path/to/dsh-git-worktree
# 重启 dsh web — 工具与面板同时生效 / restart dsh web — tools and panel activate together
```

卸载 / Removal: `dsh plugin --profile web remove dsh-git-worktree`。

## 工具 / Tools

所有工具都接受 `repo` 参数（默认取会话工作区；相对路径会基于它解析）并返回 JSON。git 分支/工作树是共享可变状态，故都不声明并发安全。

All tools accept `repo` (default: the session workspace; a relative path resolves against it) and return JSON. None is concurrency-safe by design — branch/worktree state is shared mutable state.

| 工具 | 用途 |
|---|---|
| `git_session_binding` | **开场必查**：本会话的绑定——仓库、所在工作树、检出分支、peer 工作树。`bound` 仅在拥有专属（非主）工作树时为 true。 |
| `git_repo_status` | 分支、领先/落后、脏文件；查询本会话所在仓库时附带 `binding` 块。 |
| `git_worktree_list` | 列出所有工作树（含分支/HEAD），标记 `主工作树` 与 `当前会话`。 |
| `git_worktree_add` | 创建工作树。`name` → `<repo>/.dsh-wt/<name>`（**锚定主仓库根**，从工作树内创建也不会嵌套）；或显式 `path`。`unique` 自动去重（`-2`、`-3`…）；显式 `newBranch` 冲突则报 git 原错。 |
| `git_worktree_remove` | 删除工作树（分支保留）。只接受已注册的工作树；主工作树会被拒绝；`force` 可删除含未提交改动的工作树。 |
| `git_branch_list` | 列出分支：短 sha、检出标记（调用者所在工作树的 HEAD）、上游；`all` 包含远程分支。 |
| `git_branch_create` | 创建分支；`switch` 立即检出；`from` 指定基于哪个提交/分支。 |
| `git_branch_switch` | 切换当前工作树的分支；`create` 表示不存在时先创建。 |
| `git_branch_delete` | 删除分支；`force` = `-D`。git 会拒绝删除在任何工作树中已检出的分支——这是保护机制，直接呈现而非绕过。 |

| Tool | Purpose |
|---|---|
| `git_session_binding` | **Call first**: this conversation's binding — repo, the worktree its workspace lives in, the checked-out branch, peer worktrees. `bound` is true only with a dedicated (non-primary) worktree. |
| `git_repo_status` | Branch, ahead/behind, dirty entries; attaches the session's `binding` when querying its own repo. |
| `git_worktree_list` | Every worktree with branch/HEAD, marked `primary` and `this session`. |
| `git_worktree_add` | Create a worktree. `name` → `<repo>/.dsh-wt/<name>` (anchored to the **main repo root**, never nested inside the caller's worktree); or explicit `path`. `unique` auto-dedupes (`-2`, `-3`, …); explicit `newBranch` collisions surface git's error. |
| `git_worktree_remove` | Remove a worktree (branch kept). Only registered worktrees accepted; the primary worktree is refused; `force` removes uncommitted changes. |
| `git_branch_list` | Branches with short sha, checked-out marker (the caller worktree's HEAD), upstream; `all` includes remotes. |
| `git_branch_create` | Create a branch; `switch` checks it out; `from` picks the base. |
| `git_branch_switch` | Switch the current worktree's branch; `create` creates it first. |
| `git_branch_delete` | Delete a branch; `force` = `-D`. Git refuses branches checked out anywhere — that protection is surfaced, not bypassed. |

## 面板 / Panel

浏览器端注册到 `sidebar.footer.action`（侧边栏底部）：一个 **Bindings** 按钮，点击打开**绑定管理器**：

- 仓库路径输入框（默认取当前会话的工作区），
- 状态行：当前分支 + 干净/脏文件；本会话绑定状态（已绑定工作树 / 共享主工作树 / 不在仓库），
- 工作树列表：路径、分支 @ HEAD、`primary` / `当前会话` / `N 会话绑定` 标记、绑定的会话标题；每行 **打开绑定会话**（非主工作树）与 **删除**，
- 创建表单：功能名 → **创建绑定会话**（一键，见上）或 **仅创建工作树**，
- 删除确认：列出绑定的会话，勾选"一并归档这些会话"后删除。

The browser half registers into `sidebar.footer.action` (bottom of the sidebar): a **Bindings** button opening the **binding manager** with

- repo path input (defaults to the current session's workspace),
- status line: branch + clean/dirty; this session's binding state (dedicated worktree / shared primary / not a repo),
- worktree list: path, branch @ HEAD, `primary` / `this session` / `N bound` markers, bound session titles; per-row **打开绑定会话 (Open bound conversation)** (non-primary) and **删除 (Remove)**,
- create form: feature name → **创建绑定会话 (Create bound conversation)** (one click, above) or **仅创建工作树 (worktree only)**,
- remove confirmation: lists bound conversations, checkbox to **archive them** before removing.

面板通过 `ctx.webServer` 以同源方式调用 `/dsh-git-worktree` 前缀下的宿主路由（`list` / `status` / `branches` / `add` / `remove` / `bindings`）。读路由（`list` / `status`）对不在任何 git 仓库内的路径返回 `{ notARepo: true }`（200）；`bindings` 对每个输入路径逐条标记 `notARepo`/工作树归属；写操作与 agent 工具仍保持严格报错。按 dsh-host-webserver 的文档约定，这些路由**没有鉴权**——请保持默认的 loopback 绑定。

The panel talks to host routes under `/dsh-git-worktree` (`list` / `status` / `branches` / `add` / `remove` / `bindings`), served same-origin by `ctx.webServer`. The read routes (`status`, `list`) answer a path that is not inside a git repository with `{ notARepo: true }` (200); `bindings` flags each input path per-row; mutations and the agent tools keep failing strict. Per dsh-host-webserver's documented posture these routes have **no auth** — keep the bind host on the loopback default.

The panel refreshes only when the binding-relevant session list actually moves (the sessions selector compares content, so per-event store churn does not re-render it), and refreshes are **coalesced** — at most one `/list`+`/status`+`/bindings` request trio in flight, with later requests folded into a single trailing re-run. This keeps the panel live without flooding the browser connection pool (the original `net::ERR_INSUFFICIENT_RESOURCES` symptom).

## 配置 / Configuration

profile 行支持以下配置项（均可选） / The profile row accepts (all optional):

```yaml
- id: git-worktree
  name: dsh-git-worktree
  config:
    worktreesDir: .dsh-wt     # 新工作树的默认父目录 / default parent dir for new worktrees
    timeoutMs: 30000          # 每条 git 命令的超时时间 / per-command git timeout
    stdoutMaxBytes: 1000000   # 捕获 stdout 的上限 / captured stdout cap
    stderrMaxBytes: 65536     # 保留 stderr 摘要的上限 / retained stderr excerpt cap
```

## 架构 / Architecture

```
dsh-git-worktree/
├── index.js            # Cordis 插件 / Cordis plugin: name / inject / Config / apply
├── client.js           # 浏览器端 / browser half (hand-written __ModuleLoader__ bundle)
├── lib/
│   ├── git.js          # 基于 ctx.subprocess 的 git 执行（无 shell 层）、路径规范化 / git runner via ctx.subprocess (no shell layer), path canon
│   ├── parse.js        # worktree --porcelain / for-each-ref / status 的纯解析器 / pure parsers
│   ├── operations.js   # 工具与路由共用的核心操作（含绑定解析）/ shared ops incl. binding resolution
│   ├── tools.js        # defineTool 封装（面向 agent）/ defineTool wrappers (agent-facing)
│   └── routes.js       # /dsh-git-worktree REST 处理器（面向面板）/ REST handlers (panel-facing)
├── cordis.patch.yml    # bundle patch：插入插件行 / inserts the plugin row
└── test/               # 独立功能测试 + 客户端冒烟测试 / standalone functional + client smoke tests
```

开发过程中确认的关键事实 / Key facts discovered while building:

- 工具注册在 **host 平面**（该行位于 profile 组合中），因此所有 agent 都能看到（`agent → preset → global`）。<br>Tools register on the **host plane** (this row lives in the profile composition), so every agent sees them (`agent → preset → global`).
- 面板 bundle **无需前端重新构建**：宿主直接服务 `/plugins/dsh-git-worktree/client.js`，启动图加载它即可。<br>The panel bundle needs **no frontend rebuild**: the host serves `/plugins/dsh-git-worktree/client.js` and the boot graph loads it.
- 扩展客户端 RPC API（`UNARY_VALUE_SCHEMAS`）需要重新构建前端——这正是面板改用普通 webServer 路由的原因。<br>Extending the client RPC API (`UNARY_VALUE_SCHEMAS`) would require a frontend rebuild — that is why the panel uses plain webServer routes.
- `ctx.get('webServer')` 在 apply 时是 `undefined`（异步初始化）；应改用 `ctx.inject(['webServer'], cb)` 等待。无头（headless）profile 下工具仍可用，只是路由不会挂载。<br>`ctx.get('webServer')` is `undefined` at apply time (async init); wait with `ctx.inject(['webServer'], cb)` instead. In a headless profile the tools still work and the routes simply never mount.
- git 会用 realpath 规范化路径（例如 macOS 上 `/var` → `/private/var`）；所有相等性判断都基于规范化形式。<br>git realpath-canonicalizes paths (e.g. `/var` → `/private/var` on macOS); all equality checks run on canonical forms.
- 会话 cwd 在创建时冻结（`session.header.cwd` 只读），工作区归属要求 cwd == 工作区路径——**绑定只能发生在创建会话时**，无法迁移已存在的会话。<br>A session's cwd is frozen at creation (`session.header.cwd` readonly) and workspace membership requires cwd == workspace path — **bindings happen at session creation only**; existing conversations cannot be re-rooted.
- `git rev-parse --show-toplevel` 在 linked worktree 内返回**工作树根**而非主仓库根；主工作树判定必须基于 `--git-common-dir`（主工作树路径 = common dir 的父目录）。主工作树路径是仓库根，因此 `.dsh-wt/*` 下的目录同时匹配主工作树和自身——取**最长匹配**。<br>`git rev-parse --show-toplevel` returns the WORKTREE root inside a linked worktree; primary-worktree comparisons must use `--git-common-dir` (primary = the common dir's parent). Since the primary's path is the repo root, directories under `.dsh-wt/*` match both — the **longest matching path wins**.

## 测试 / Tests

```sh
node test/run-all.js     # 全部套件一次跑完（任一失败即非零退出）/ every suite, non-zero exit on failure
node test/unit-parse.js  # 纯解析器：worktree/branch/status 输出（含 unborn、detached、prunable、ahead/behind）
node test/unit-git.js    # git 运行器与路径助手：exit codes、abort、信号杀死、字节上限、cwd 分类
node test/test.js        # 原功能测试：9 工具 + 路由处理器（bindings、unique 去重、绑定解析）
node test/tools-edge.js  # 9 工具边界矩阵：遍历防护、detach/commitIsh/force、脏工作树、上游/远程
node test/routes-http.js # 真实 HTTP：方法校验、坏 JSON/超大 body、严格 vs 宽容 notARepo、超时 abort
node test/client-unit.js # 客户端纯函数：sanitizeName 边界、sessionsSame、api() 错误映射
node test/client-dom.js  # jsdom 面板交互：创建/打开绑定会话、删除+归档、点击外部关闭、刷新合并
node test/flows.js       # 真实用户操作流：一键绑定会话、agent 准备/开发者打开、全生命周期、跨仓库
```

`client-dom.js` 需要 jsdom（插件本身不依赖它）：从 DeepSeek Harness checkout 解析（`DSH_HARNESS` 指向其根目录，默认 `/Users/aq/deepseek-harness`），找不到时该套件自动跳过。`KEEP_SCRATCH=1` 可保留测试用临时仓库以便检查。
