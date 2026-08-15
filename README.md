# dsh-git-worktree

面向 **DeepSeek Harness** 的 **对话 ↔ 工作树绑定** 插件：让多个会话在同一项目上并行工作，**每个会话绑定一个独立 git 工作树 + 分支**，一键创建、互不干扰。

Conversation↔worktree **binding** for **DeepSeek Harness**: run multiple conversations on one project in parallel, each bound to its own isolated git worktree + branch, created in one click.

- **绑定 / Binding** — 会话在创建时即绑定到专属工作树：工作树 + 工作区 + 会话一次成型（绑定关系可推导、可展示、可清理）。
- **Agent 工具 / Agent tools** — 9 个工具（`git_session_binding`、`git_repo_status`、`git_worktree_*`、`git_branch_*`），每个会话都可以调用。<br>9 tools (`git_session_binding`, `git_repo_status`, `git_worktree_*`, `git_branch_*`) every conversation can call.
- **左侧工作区树 / The sidebar workspace tree** — 唯一的管理界面：每个项目自动检测全部 git 工作树并显示为嵌套子文件夹（主工作树 = 项目文件夹本身，标记 **主工作树**），工作树副文件夹上可新建会话（出生即绑定）或 **删除工作树**（含绑定会话提示/归档）。<br>The single management surface: every project auto-detects all its git worktrees as nested folders (the main worktree IS the project folder, marked **主工作树**); a worktree subfolder can start a conversation (born bound) or **remove the worktree** (with bound-conversation warning/archive).

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

绑定关系**无需额外存储**，由 `sessions.list`（cwd）× `git worktree list`（路径→分支）× `workspaces.list` 推导而来——左侧树与 agent 工具看到的都是实时事实。

Bindings are **derived, not stored**: `sessions.list` (cwd) × `git worktree list` (path→branch) × `workspaces.list` — what the sidebar tree and the agent tools show is live fact.

## 一键创建绑定会话 / One-click bound conversation

点击**项目文件夹（仓库）行的 ＋**，输入功能名，点 **创建绑定会话**：

1. `git worktree add -b <name> <repo>/.dsh-wt/<name>`（重名自动加后缀 `-2`、`-3`…）
2. `workspaces.create({ path })`（幂等注册工作区）
3. `connectWorkspace` → 会话直接诞生在该工作树（绑定成立）
4. 自动打开该会话

On the sidebar tree, click the **＋ on the project (repo) folder**, type a feature name, hit **创建绑定会话 (Create bound conversation)**:

1. `git worktree add -b <name> <repo>/.dsh-wt/<name>` (name collisions auto-suffix `-2`, `-3`, …)
2. `workspaces.create({ path })` (idempotent workspace registration)
3. `connectWorkspace` → the session is born inside that worktree (the binding)
4. the new conversation opens automatically

已存在的工作树副文件夹上的 ＋ 是「在该工作树新建会话」——会话出生即绑定（agent 先建好工作树、开发者一键确认的场景）。副文件夹行还有 **删除工作树** 按钮：确认框列出绑定的会话、可**一并归档**（日志保留，侧边栏隐藏）、删除 git 工作树并注销其文件夹。

A worktree subfolder's ＋ starts a new conversation in that worktree — born bound (the agent-prepares / developer-confirms flow). The subfolder row also has **删除工作树 (Remove worktree)**: the confirm lists bound conversations, can **archive them** (logs stay; the sidebar hides them), removes the git worktree and unregisters its folder.

## 安装 / Installation

```sh
# 在插件目录下执行 / from the plugin checkout
dsh plugin --profile web add /path/to/dsh-git-worktree
# 重启 dsh web — 工具与树界面同时生效 / restart dsh web — tools and the tree surface activate together
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

## 左侧工作区树：自动检测全部工作树 / The sidebar tree: every worktree auto-detected

右下角的 **Bindings 面板已移除**：工作区树是唯一的管理界面。浏览器端注册两个 slot：

The sidebar footer **Bindings panel is gone**: the workspace tree is the single surface. The browser half registers two slots:

- **`sidebar.footer.action`（渲染为空 / renders nothing）** — 一个无 UI 的同步挂载点。监听工作区列表，对每个工作区调用 `/dsh-git-worktree/list`：确保仓库根（主工作树）工作区存在并标记 **`<项目名>（主工作树）`**，确保每个工作树路径都注册为工作区（树按路径自动嵌套成子文件夹）；**失效清扫**——auto 注册的、工作树已从 git 消失且无会话的文件夹会被自动注销（跟随 git）。20 秒静默轮询覆盖 agent 工具/CLI 在工作树层面的改动。A renderless sync mount. Watches the workspace list, queries `/dsh-git-worktree/list` per workspace: ensures the repo-root (main worktree) workspace exists and is marked **`<project>（主工作树）`**, ensures every worktree path is registered as a workspace (the tree nests them by path); **stale sweep** — auto-registered folders whose worktree disappeared from git and hold no sessions are unregistered again (the tree follows git). A 20s quiet poll covers worktree-level changes made by agent tools/CLI.
- **`sidebar.workspaces.create`（每行 ＋ 链 / per-row ＋ chain）** —
  - 主文件夹（仓库）＋ → 「新增工作树」小窗：功能名 → **创建绑定会话** 或 **仅创建工作树**；非 git 文件夹回落为默认「新建会话」。Repo folder ＋ → "add worktree" popover (create bound conversation / worktree only); non-git folders fall back to the default new-session ＋.
  - 工作树副文件夹 → 默认 ＋（在该工作树新建会话，出生即绑定）+ **删除工作树** 按钮（确认框：绑定会话列表、可一并归档、删除 git 工作树并注销文件夹）。Worktree subfolder → default ＋ (new conversation born bound) + **删除工作树 (Remove worktree)** button (confirm: bound conversations, optional archive, removes the worktree and unregisters the folder).
  - 其他嵌套文件夹 → 保持默认 ＋。Other nested folders keep the default ＋.

浏览器端通过 `ctx.webServer` 以同源方式调用 `/dsh-git-worktree` 前缀下的宿主路由（`list` / `status` / `branches` / `add` / `remove` / `bindings`）。读路由（`list` / `status`）对不在任何 git 仓库内的路径返回 `{ notARepo: true }`（200）；`bindings` 对每个输入路径逐条标记 `notARepo`/工作树归属；写操作与 agent 工具仍保持严格报错。按 dsh-host-webserver 的文档约定，这些路由**没有鉴权**——请保持默认的 loopback 绑定。

The browser talks to host routes under `/dsh-git-worktree` (`list` / `status` / `branches` / `add` / `remove` / `bindings`), served same-origin by `ctx.webServer`. The read routes (`status`, `list`) answer a path that is not inside a git repository with `{ notARepo: true }` (200); `bindings` flags each input path per-row; mutations and the agent tools keep failing strict. Per dsh-host-webserver's documented posture these routes have **no auth** — keep the bind host on the loopback default.

同步是**合并式**的：同一时刻至多一次扫描在途，扫描期间的变更折叠为一次收尾重扫；仅当检测到的工作树集合真正变化时才发布给行级 UI（避免无谓重渲染）。

Sync is **coalesced**: at most one scan in flight, later requests folded into a trailing re-run; the row-level UI is republished only when the detected worktree key sets actually move.

## 工作区树中的工作树 / Worktrees in the workspace tree

插件还注册到 `sidebar.workspaces.create`（工作区浏览器每行「+」的可替换链），并结合 `sidebar.footer.action` 的自动同步，让左侧工作区树成为**完整的绑定管理界面**：

- **树结构**：核心 `ui-workspace` 按目录包含关系把工作区嵌套渲染——`<repo>/.dsh-wt/<name>` 自动成为 `<repo>` 主文件夹下的副文件夹，其会话显示在副文件夹里。自动同步保证**每个工作树（包括从未打开过会话的）都注册成副文件夹**；主工作树的路径就是仓库根，因此项目文件夹即主工作树，标题标记为 **`<项目名>（主工作树）`**。
- **主文件夹 ＋（仓库）**：弹出「新增工作树」小窗，输入功能名 → **创建绑定会话**（创建 `.dsh-wt/<name>` 工作树并立即创建/打开绑定会话，一键）或 **仅创建工作树**；非 git 目录的文件夹自动回落为默认「新建会话」。
- **副文件夹 ＋（工作树）**：保持核心默认行为——在该工作树新建会话（会话出生即绑定）。
- **副文件夹 删除工作树**（仅已检测到的工作树）：确认框列出绑定的会话，勾选"一并归档这些会话"后删除 git 工作树并注销其文件夹；工作树从 git 消失（agent/CLI 删除）后，无会话的文件夹由同步自动清理。

The plugin also registers into `sidebar.workspaces.create` (the replaceable per-row 「+」 chain of the workspace browser) and pairs it with the `sidebar.footer.action` auto-sync, making the sidebar tree the **complete binding-management surface**:

- **Tree shape**: core `ui-workspace` nests workspaces by directory containment — `<repo>/.dsh-wt/<name>` renders as a subfolder under the `<repo>` main folder, with its conversations inside. The auto-sync guarantees **every worktree (even never-opened ones) is registered as a subfolder**; the main worktree's path IS the repo root, so the project folder is the main worktree, titled **`<project>（主工作树）`**.
- **Main folder ＋ (repo)**: opens a small "add worktree" popover — feature name → **创建绑定会话 (create bound conversation)** (creates `.dsh-wt/<name>` and immediately creates/opens the bound conversation, one click) or **仅创建工作树 (worktree only)**; non-git folders automatically fall back to the default new-session ＋.
- **Subfolder ＋ (worktree)**: keeps the core default — a new conversation born bound to that worktree.
- **Subfolder 删除工作树 (Remove worktree)** (detected worktrees only): the confirm lists bound conversations, checkbox to **archive them**, then removes the git worktree and unregisters the folder; worktrees removed on the git side (agent/CLI) are swept by the sync when their folder holds no sessions.

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
│   └── routes.js       # /dsh-git-worktree REST 处理器（面向浏览器端）/ REST handlers (browser-facing)
├── cordis.patch.yml    # bundle patch：插入插件行 / inserts the plugin row
└── test/               # 独立功能测试 + 客户端冒烟测试 / standalone functional + client smoke tests
```

开发过程中确认的关键事实 / Key facts discovered while building:

- 工具注册在 **host 平面**（该行位于 profile 组合中），因此所有 agent 都能看到（`agent → preset → global`）。<br>Tools register on the **host plane** (this row lives in the profile composition), so every agent sees them (`agent → preset → global`).
- 浏览器端 bundle **无需前端重新构建**：宿主直接服务 `/plugins/dsh-git-worktree/client.js`，启动图加载它即可。<br>The browser bundle needs **no frontend rebuild**: the host serves `/plugins/dsh-git-worktree/client.js` and the boot graph loads it.
- 扩展客户端 RPC API（`UNARY_VALUE_SCHEMAS`）需要重新构建前端——这正是浏览器端改用普通 webServer 路由的原因。<br>Extending the client RPC API (`UNARY_VALUE_SCHEMAS`) would require a frontend rebuild — that is why the browser half uses plain webServer routes.
- `ctx.get('webServer')` 在 apply 时是 `undefined`（异步初始化）；应改用 `ctx.inject(['webServer'], cb)` 等待。无头（headless）profile 下工具仍可用，只是路由不会挂载。<br>`ctx.get('webServer')` is `undefined` at apply time (async init); wait with `ctx.inject(['webServer'], cb)` instead. In a headless profile the tools still work and the routes simply never mount.
- git 会用 realpath 规范化路径（例如 macOS 上 `/var` → `/private/var`）；所有相等性判断都基于规范化形式。<br>git realpath-canonicalizes paths (e.g. `/var` → `/private/var` on macOS); all equality checks run on canonical forms.
- 会话 cwd 在创建时冻结（`session.header.cwd` 只读），工作区归属要求 cwd == 工作区路径——**绑定只能发生在创建会话时**，无法迁移已存在的会话。<br>A session's cwd is frozen at creation (`session.header.cwd` readonly) and workspace membership requires cwd == workspace path — **bindings happen at session creation only**; existing conversations cannot be re-rooted.
- `git rev-parse --show-toplevel` 在 linked worktree 内返回**工作树根**而非主仓库根；主工作树判定必须基于 `--git-common-dir`（主工作树路径 = common dir 的父目录）。主工作树路径是仓库根，因此 `.dsh-wt/*` 下的目录同时匹配主工作树和自身——取**最长匹配**。<br>`git rev-parse --show-toplevel` returns the WORKTREE root inside a linked worktree; primary-worktree comparisons must use `--git-common-dir` (primary = the common dir's parent). Since the primary's path is the repo root, directories under `.dsh-wt/*` match both — the **longest matching path wins**.

## 测试 / Tests

```sh
node test/run-all.js     # 全部套件一次跑完（任一失败即非零退出）/ every suite, non-zero exit on failure
node test/unit-parse.js  # 纯解析器：worktree/branch/status 输出（含 unborn、detached、prunable、ahead/behind、[gone]）
node test/unit-git.js    # git 运行器与路径助手：exit codes、abort、信号杀死、字节上限、cwd 分类
node test/test.js        # 原功能测试：9 工具 + 路由处理器（bindings、unique 去重、绑定解析）
node test/tools-edge.js  # 9 工具边界矩阵：遍历防护、detach/commitIsh/force、脏工作树、上游/远程、unborn 仓库、
                         # 外部路径工作树绑定、嵌套仓库、并发 unique 竞态、already-registered 去重、脏状态矩阵
node test/routes-http.js # 真实 HTTP：方法校验（含 HEAD/OPTIONS）、坏 JSON/超大 body、空 repo 参数、+ 号编码、
                         # 严格 vs 宽容 notARepo、超时 abort
node test/client-unit.js # 客户端纯函数：sanitizeName 边界（切片尾点、HEAD、代理对、check-ref-format 性质测试）、
                         # sessionsSame、api() 错误映射
node test/client-dom.js  # jsdom 交互：自动同步（注册工作树/主工作树标记/失效清扫）、树链组件
                         # （repo ＋ 新建工作树、工作树副文件夹 ＋/删除、非工作树回落、点击外部关闭）
node test/flows.js       # 真实用户操作流：一键绑定会话、agent 准备/开发者打开、全生命周期、跨仓库、
                         # unborn 仓库首绑、双工作树同名竞态
node test/schema-conformance.js # 工具输出 vs 声明 schema（harness 的 validateJsonSchemaValue 原样复放）：
                         # 9 工具全部输出必须通过 additionalProperties:false 校验——防止
                         # 遗漏 absolutePath / 可空 branch 之类的 schema 漂移在真实会话里炸掉
```

`client-dom.js` 需要 jsdom（插件本身不依赖它）：从 DeepSeek Harness checkout 解析（`DSH_HARNESS` 指向其根目录，默认 `/Users/aq/deepseek-harness`），找不到时该套件自动跳过。`KEEP_SCRATCH=1` 可保留测试用临时仓库以便检查。
