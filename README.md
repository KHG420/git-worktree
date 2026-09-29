# dsh-git-worktree

面向 **DeepSeek Harness** 的 **对话 ↔ 工作树绑定** 插件：让多个会话在同一项目上并行工作，**每个会话绑定一个独立 git 工作树 + 分支**，一键创建、互不干扰（绑定是"专属工作树"标记，**不是独占锁**；真正的保护是同机占用检查，见下文）。

DeepSeek Harness plugin: bind every conversation to its own isolated git worktree + branch in one click, so parallel agents work on one repo without stepping on each other. A binding is a "dedicated worktree" marker, **not an exclusive lock**; the real protection is the same-host occupancy check described below.

- **绑定 / Binding** — 会话在创建时即绑定到专属工作树：工作树 + 工作区 + 会话一次成型（绑定关系可推导、可展示、可清理；**非独占**，可共享）。
- **Agent 工具 / Agent tools** — **13 个**工具：原有 **9 个 Git 工具**（`git_session_binding`、`git_repo_status`、`git_worktree_*`、`git_branch_*`），加上 **4 个任务工具**（`git_task_start`、`git_task_status`、`git_task_cancel`、`git_task_integrate`），每个会话都可以调用。<br>**13 tools**: the original **9 Git tools** (`git_session_binding`, `git_repo_status`, `git_worktree_*`, `git_branch_*`) plus **4 task tools** (`git_task_start`, `git_task_status`, `git_task_cancel`, `git_task_integrate`) every conversation can call.
- **左侧工作区树 / The sidebar workspace tree** — 唯一的管理界面：每个项目自动检测全部 git 工作树并注册为**平铺的工作区行**（主工作树 = 项目文件夹本身，标记 **主工作树**），工作树行上可新建会话（出生即绑定）或 **删除工作树**（含绑定会话提示/归档；运行中的会话会阻止删除）。<br>The single management surface: every project auto-detects all its git worktrees and registers each as a **flat workspace row** (the main worktree IS the project folder, marked **主工作树**); a worktree row can start a conversation (born bound) or **remove the worktree** (with bound-conversation warning/archive; a running conversation blocks deletion).

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

## 绑定不是独占锁 / A binding is not an exclusive lock

`bound` 只表示"本会话拥有一个专属（非主）工作树"，**不表示独占**：另一个会话完全可以共享同一个工作树，`bound` 也不会告诉你还有谁在写入。真正的并发保护是**同机检查（same-host check）**，不是跨进程锁，也不是 shell 沙箱：

`bound` means only "this conversation has its own dedicated (non-primary) worktree" — it is **not exclusivity**. Another conversation may share that same worktree, and `bound` says nothing about who else is writing. The real protection is a **same-host check**, not a cross-process lock and not a shell sandbox:

- **查询绑定时**：当宿主暴露原生 agents 注册表，且另一个 **RUNNING** 的原生 agent（**包括子 subagent**）按"最长匹配"规则解析到同一工作树时，`git_session_binding` 会以清晰的占用错误失败，而不是给出一个看起来安全的绑定；调用者自身被忽略，**idle 的同伴不会被当作正在写入**。
- **删除工作树时**：`git_worktree_remove` 只要目标工作树里有 RUNNING 的 agent（**包括调用者自己**），即使带 `force` 也拒绝；`force` 只豁免 git 的脏工作树检查。本插件运行中的 `git_task_*` 任务也占用其工作树（含 `preparing` setup 阶段和尚未完成的释放），此时同样拒绝删除，且**不依赖 agents 服务**。
- **UI 侧**同样列出工作树上的全部会话（含 subagent），只要有 `running` 会话就停用删除并说明原因。
- **最小 profile**：没有 agents 服务时检查自动跳过，工具照常可用——这是有意的能力降级，**不要**把它当作安全保障。

- **When querying the binding**: when the host exposes the native agents registry and another **RUNNING** native agent (a **child subagent included**) resolves to the same worktree under the same longest-match rule, `git_session_binding` fails with a clear occupancy error instead of a safe-looking binding. The caller itself is ignored; **idle peers are never reported as actively writing**.
- **When removing a worktree**: `git_worktree_remove` refuses while any RUNNING agent (**the caller included**) is in the target worktree, even with `force`; `force` only waives git's dirty-worktree check. A worktree owned by a live `git_task_*` task (including the `preparing` setup phase and an unfinished disposal) is likewise refused, and that guard does **not** depend on the agents service.
- **The UI** likewise lists every conversation on the worktree (subagents included) and disables deletion with an explanation while one is `running`.
- **Minimal profiles**: without the agents service the check is skipped and the tools keep working — a deliberate degradation, **not** a safety guarantee.

## 清理失败恢复 / Cleanup failure recovery

删除工作树是 **git 优先、分阶段**执行的：先真正删除 git 工作树，再（按选择）归档绑定会话，最后注销工作区文件夹。结论固定、重试安全：

Worktree removal is **git-first and staged**: remove the git worktree, then (if chosen) archive the bound sessions, then unregister the workspace folder. The outcome is fixed and retries are safe:

- **git 删除失败** → 不归档、不注销，确认框保留并报告原因，可直接重试。
- **git 删除成功之后的归档或注销失败** → 明确报错，重试**只执行未完成的步骤**（绝不会再删一次 git 路径）；待归档的会话 id 在删除后冻结，不因绑定重新解析（工作树已消失）而丢失。
- **不吞掉注销失败**（旧版本会静默忽略）。

- **git removal failed** → nothing archived/unregistered; the confirm stays open with the reason and can be retried.
- **archive/unregister failed AFTER a successful git removal** → visible error, and a retry runs **only the unfinished steps** (never a second git removal); the pending session ids are frozen across the retry and are not lost when the post-removal binding re-resolution finds the worktree gone.
- **Unregister failures are surfaced**, not swallowed.

确认框用中文说明两种失败：Git 拒绝删除时会提示"目录仍然存在，请先保存/提交/stash 后重试"（**不会**自动 `--force`）；Git 删除之后的清理失败会明确"目录已删除、清理未完成"。原始 git 报错保留在折叠的"技术详情"里。The confirm explains both failures in Chinese: a refused git removal says the directory is retained and to save/commit/stash first (**never** an automatic `--force`); a post-removal archive/unregister failure says the directory is gone but cleanup is pending. The raw git error stays available under a collapsed "技术详情 (technical details)".

## 本地忽略规则 / Local exclusion rule

`name` 形式的默认工作树位于 `<repo>/.dsh-wt/<name>`，嵌套在自己的仓库里；若不加处理，`git add -A` 会把它当作 **gitlink/嵌入式仓库**暂存。插件会在**共享的** `<common-git-dir>/info/exclude`（**不碰**被跟踪的 `.gitignore`）里为配置的 name-based 父目录写入一条**锚定**规则（如 `/.dsh-wt/`）：

A `name`-based worktree lives at `<repo>/.dsh-wt/<name>`, nested inside its own repository; without care, `git add -A` would stage it as a **gitlink/embedded repo**. The plugin writes one **anchored** rule (e.g. `/.dsh-wt/`) into the **shared** `<common-git-dir>/info/exclude` (**never** the tracked `.gitignore`) for the configured name-based parent:

- 保留已有字节、幂等（重复创建不重复写）、并发的同进程创建经写链串行化；含空格/元字符的目录名会正确转义。
- 只针对**仓库内**的 name-based 父目录；**显式 `path`**、仓库外的父目录、仓库根本身都不会被写入。
- 写入失败会**报错**（工作树已建，但明确告知未被保护），而不是静默返回"成功"。

- Existing bytes are preserved, the rule is idempotent, concurrent in-process creates are serialized through a write chain, and directory names with spaces/metacharacters are escaped.
- Only a name-based parent **inside** the repository is touched; an explicit `path`, an outside-repo parent, or the repository root never is.
- A write failure is **reported** (the worktree exists but is explicitly unprotected) rather than silently returning success.

## 分支语义 / Branch semantics

`name` 形式且未给出显式 `branch`/`newBranch`/`detach`/`commitIsh` 时，插件显式 `git worktree add -b <路径末段>` 创建**全新分支**——绝不会静默复用一个已存在但未检出的分支。`unique: true` 时冲突会新建带后缀的工作树+分支（`-2`、`-3`…）；`unique: false` 时直接报 git 的严格错误；`force` 也不绕过。显式 `branch`（复用已有分支）、`newBranch`（指定新分支名，冲突报错）、`detach`、`commitIsh` 语义保持不变；`path` 形式仍沿用 git 自身的推断。

A `name`-based request with no explicit `branch`/`newBranch`/`detach`/`commitIsh` runs `git worktree add -b <last path component>` to create a **fresh branch** — it never silently reuses an existing unchecked-out branch. With `unique: true` a collision becomes a new suffixed worktree+branch (`-2`, `-3`, …); with `unique: false` git's strict error surfaces; `force` does not bypass it. Explicit `branch` (reuse), `newBranch` (named, conflict fails), `detach`, and `commitIsh` keep their meanings; explicit `path` keeps git's own inference.

## 任务协作 / Task collaboration

主会话可以用 4 个任务工具把明确的独立任务派发到各自的工作树，并在验证后合并（原有 9 个 Git 工具保持兼容）：

The main conversation can fan explicit, independent tasks into their own worktrees and integrate them after verification (the original 9 Git tools stay compatible):

1. `git_task_start({ name, prompt, repo?, base? })` — 创建**全新工作树 + 分支**（`<repo>/<worktreesDir>/<name>`，重名自动后缀），写入本地任务记录后**立即返回** `preparing`；随后在任务生命周期内顺序执行配置的 `setupCommands`，再以**调用者 agent 为父**创建一个原生子 agent，其 cwd 在创建时冻结为该工作树，继承调用者的模型与权限（**只收窄、不扩大**：approval 固定 `never`，sandbox 沿用父级 override）。子任务有深度上限（主 agent 深度 0 → 任务子 agent 深度 1），不能再次 `git_task_start`。多个 `git_task_start` 可并发。
2. `git_task_status({ repo?, taskId? })` — 列出本仓库（记录写在共享 git common dir 下，linked worktree 同样可见）的任务：状态、工作树/分支、子会话 id、最终摘要、commit、错误。另一个**仍存活**的 DSH 进程拥有的活动任务按原样报告；只有能证明属主进程已消失时才标记 `interrupted`（用 `kill(pid, 0)` 存活探测，**不发送任何信号**）。
3. `git_task_cancel({ taskId })` — 只停止**本进程拥有**的任务：中止 setup 或取消并排空子 agent，持久化 `cancelled`，**保留工作树与分支**。已结束任务幂等；属于其他存活进程的任务只报告限制，绝不向其发信号。插件/父级 teardown 会取消并释放自己启动的全部子 agent。
4. `git_task_integrate({ repo?, taskId, verifyCommands? })` — 把**已完成、已提交、干净**的任务分支合并进目标工作树（`repo`，默认调用者工作树），只用真实 git，**绝不 force/reset/clean、绝不 push/deploy**。拒绝：活动任务、脏源/脏目标、源未提交、源==目标、目标或源内有其他 RUNNING 写入者（允许调用者自己所在的 target）。合并基于**已记录并核对的 HEAD**；冲突**保留**（不自动 abort/reset）并给出恢复说明。合并成功后顺序执行 `verifyCommands`（argv 数组、无 shell），全部通过才 `verified`；失败标记未验收，重试**只重跑验证、不重复合并**（即使目标 HEAD 已前进也不复用旧验证）。未提供命令则明确 `verified=false`（未独立验证）。源工作树/分支保留，由用户自行清理。

原生 `spawn`/`fork` 行为不变；任务入口是"独立写入"的推荐入口。The native `spawn`/`fork` behavior is unchanged; the task entry is the recommended isolated-writing path.

### 环境准备示例 / Setup example

`setupCommands` 为可选配置（默认 `[]`），**不经过 shell**、不会自动复制 `.env` 或安装任何东西；每条命令在新任务工作树内按顺序执行，失败/超时/取消会得到有界诊断并**在启动子 agent 之前**停止（工作树保留供排查）。空数组以外、空 argv 数组、空字符串段或非数组形式都会在插件加载时报错。

`setupCommands` is optional (default `[]`), **never shell-interpolated**, and never copies `.env` or installs anything implicitly. Commands run sequentially inside the new task worktree; a failure/timeout/cancel returns bounded diagnostics and stops **before the child agent launches** (the worktree is kept for inspection). An empty outer array is allowed, but empty argv arrays, empty-string segments, or a non-array shape fail plugin loading.

```yaml
- id: git-worktree
  name: dsh-git-worktree
  config:
    setupCommands:
      - ["pnpm", "install", "--frozen-lockfile"]
      - ["node", "scripts/check-env.mjs"]
```

### 继承与限制 / Inheritance and limits

- 任务子 agent 继承调用者的模型、权限与工具组合（通过 DSH 的 delegation 合成：`captureDelegatedPolicyOverrides` + `applyChildComposition` + `resolveChildAgentOptions`），但**看不到调用者会话内容**，必须在 `prompt` 中给出自包含的完整任务。Task children inherit the caller's model, permission scope, and tool composition via the DSH delegation helpers, but **cannot see the caller's conversation** — give every task a self-contained prompt.
- 它不是 OS 沙箱；工作树隔离只保证工作树层面互不干扰。It is not an OS sandbox; worktree isolation only separates the working trees.
- 同机占用检查（原生 agents 注册表）**不是跨进程锁**；另一 DSH 进程或手工 shell 的写入不在保护范围内。The same-host occupancy check (native agents registry) is **not a cross-process lock**; writes from another DSH process or a manual shell are outside its protection.
- `git_task_integrate` 的验证命令必须只做只读检查：若它修改了目标的已跟踪文件/索引或移动了 HEAD，结果为**未验收**，改动被保留（绝不 reset），需要人工清理后重试；重试只重跑验证、不重复合并。`git_task_integrate` verification commands must be read-only checks: if one modifies a tracked target file/index or moves HEAD, the result is **unverified**, the changes are preserved (never reset), and a cleanup + retry reruns verification without repeating the merge.

## 界面范围 / UI scope

本插件不替换原生 `spawn`/`fork`，也不新增独立面板；任务协作只以 agent 工具的形式提供，管理仍沿用既有左侧工作区树（见下文）。侧边栏不显示任务工作树以外的专用看板。

The plugin does not replace native `spawn`/`fork` and adds no separate dashboard; task collaboration is agent-tool-only and management stays on the existing sidebar workspace tree (below). No dedicated task board is added to the sidebar.

## 一键创建绑定会话 / One-click bound conversation

点击**项目文件夹（仓库）行的 ＋**，输入功能名，点 **创建绑定会话**：

1. `git worktree add -b <name> <repo>/.dsh-wt/<name>`（重名自动加后缀 `-2`、`-3`…）
2. `workspaces.create({ path })`（幂等注册工作区）
3. `connectWorkspace` → 会话直接诞生在该工作树（绑定成立）
4. 自动打开该会话

输入框有固定标签"工作树名称"和示例（如 `login-page`）；名称会被规范化（空格等转为 `-`），有变化时先预览将创建的路径与分支，非法名称（如 `///`、`...`、空白）会禁用创建并说明原因。**仅创建工作树**成功后不自动开会话，而是保留弹层显示真实路径/分支以及"打开绑定会话""完成"；若工作树已创建但会话打开失败，重试只重开会话，绝不重复创建工作树。

On the sidebar tree, click the **＋ on the project (repo) folder**, type a feature name, hit **创建绑定会话 (Create bound conversation)**:

1. `git worktree add -b <name> <repo>/.dsh-wt/<name>` (name collisions auto-suffix `-2`, `-3`, …)
2. `workspaces.create({ path })` (idempotent workspace registration)
3. `connectWorkspace` → the session is born inside that worktree (the binding)
4. the new conversation opens automatically

The input carries a persistent "工作树名称" label and an example (`login-page`); the name is sanitized (spaces become `-`) and a preview shows the target path/branch when it changes, while invalid names (`///`, `...`, blank) disable creation with a reason. A successful **worktree only** run keeps the popover open with the real path/branch plus "打开绑定会话 (open bound conversation)" / "完成 (done)" actions; if the worktree exists but opening the conversation fails, the retry only re-opens it — never a second worktree create.

已存在的工作树行上的 ＋ 是「在该工作树新建会话」——会话出生即绑定（agent 先建好工作树、开发者一键确认的场景）。工作树行还有 **删除工作树** 按钮：确认框列出**全部**绑定会话（含 subagent；只要有 `running` 会话就停用删除并说明原因）、可**一并归档**（日志保留，侧边栏隐藏）、以 git 优先的顺序删除工作树并注销其文件夹；删除后的归档/注销失败会明确报错且只重试未完成步骤（见"清理失败恢复"）。确认框在**没有绑定会话时不显示归档勾选框**并说明分支仍保留，分支行只显示短 SHA（完整值在悬停提示中）。

A worktree row's ＋ starts a new conversation in that worktree — born bound (the agent-prepares / developer-confirms flow). The row also has **删除工作树 (Remove worktree)**: the confirm lists **every** bound conversation (subagents included; any `running` one disables deletion with an explanation), can **archive them** (logs stay; the sidebar hides them), removes the git worktree git-first and unregisters its folder; a post-removal archive/unregister failure is reported and only the unfinished steps retry (see "Cleanup failure recovery"). With **no bound conversations the archive checkbox is omitted** and the panel notes the branch is retained; the branch line shows a short SHA (full value on hover).

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
| `git_session_binding` | **开场必查**：本会话的绑定——仓库、所在工作树、检出分支、peer 工作树。`bound` 仅在拥有专属（非主）工作树时为 true，**不代表独占**；有 RUNNING 原生 agent（含子 subagent）解析到同一工作树时以占用错误失败（调用者自身忽略，idle 同伴不算写入）。无 agents 服务时跳过检查。 |
| `git_repo_status` | 分支、领先/落后、脏文件；查询本会话所在仓库时附带 `binding` 块（`bound` 同为非独占语义）。 |
| `git_worktree_list` | 列出所有工作树（含分支/HEAD），标记 `主工作树` 与 `当前会话`。 |
| `git_worktree_add` | 创建工作树。`name` → `<repo>/.dsh-wt/<name>`（**锚定主仓库根**，从工作树内创建也不会嵌套）；或显式 `path`。name 且无显式 branch/newBranch/detach/commitIsh 时 `-b` 创建**全新分支**（不复用已有分支）；`unique` 冲突时新建 `-2`、`-3`… 工作树+分支；显式 `newBranch` 冲突报 git 原错。仓库内 name-based 父目录会写入本地 `info/exclude`，`git add -A` 不会把工作树当 gitlink 暂存。 |
| `git_worktree_remove` | 删除工作树（分支保留）。只接受已注册的工作树；主工作树会被拒绝；目标内有 RUNNING 原生 agent（含调用者）时即使 `force` 也拒绝；`force` 仍可删除含未提交改动的工作树。 |
| `git_branch_list` | 列出分支：短 sha、检出标记（调用者所在工作树的 HEAD）、上游；`all` 包含远程分支。 |
| `git_branch_create` | 创建分支；`switch` 立即检出；`from` 指定基于哪个提交/分支。 |
| `git_branch_switch` | 切换当前工作树的分支；`create` 表示不存在时先创建。 |
| `git_branch_delete` | 删除分支；`force` = `-D`。git 会拒绝删除在任何工作树中已检出的分支——这是保护机制，直接呈现而非绕过。 |
| `git_task_start` | 在全新工作树+分支中启动一个独立任务，并创建一个 cwd 冻结在该工作树的原生子 agent（继承调用者模型/权限，不扩大；有深度上限）。可配 `setupCommands`，失败则不启动 agent。立即返回 `preparing`。 |
| `git_task_status` | 列出/查询本仓库的任务记录（状态、工作树、分支、子会话 id、摘要、commit、错误）；记录在共享 git common dir，linked worktree 可见；死属主活动记录标记 `interrupted`，存活外部属主不覆盖。 |
| `git_task_cancel` | 停止本进程拥有的任务（中止 setup 或排空子 agent），保留工作树与分支，持久化 `cancelled`；已结束幂等；外部存活任务只报告限制。 |
| `git_task_integrate` | 把已完成任务分支合并进目标工作树并运行 `verifyCommands`；拒绝活动/脏/未提交/source==target/运行中写入者；冲突保留待手动解决；验证失败不算验收，重试不重复合并；不 push/deploy。 |

| Tool | Purpose |
|---|---|
| `git_session_binding` | **Call first**: this conversation's binding — repo, the worktree its workspace lives in, the checked-out branch, peer worktrees. `bound` is true only with a dedicated (non-primary) worktree — **not exclusivity**; another RUNNING native agent (a child subagent included) resolving to the same worktree yields a clear occupancy error (the caller itself is ignored; idle peers do not count as writers). Skipped without an agents service. |
| `git_repo_status` | Branch, ahead/behind, dirty entries; attaches the session's `binding` when querying its own repo (`bound` has the same non-exclusive meaning). |
| `git_worktree_list` | Every worktree with branch/HEAD, marked `primary` and `this session`. |
| `git_worktree_add` | Create a worktree. `name` → `<repo>/.dsh-wt/<name>` (anchored to the **main repo root**, never nested inside the caller's worktree); or explicit `path`. A name with no explicit branch/newBranch/detach/commitIsh creates a **fresh branch** with `-b` (never a silent reuse); `unique` collisions become a new `-2`, `-3`, … worktree+branch; explicit `newBranch` collisions surface git's error. A name-based parent inside the repo gets a local `info/exclude` rule so `git add -A` does not stage it as a gitlink. |
| `git_worktree_remove` | Remove a worktree (branch kept). Only registered worktrees accepted; the primary worktree is refused; a RUNNING native agent (the caller included) in the target refuses removal even with `force`; `force` still removes uncommitted changes. |
| `git_branch_list` | Branches with short sha, checked-out marker (the caller worktree's HEAD), upstream; `all` includes remotes. |
| `git_branch_create` | Create a branch; `switch` checks it out; `from` picks the base. |
| `git_branch_switch` | Switch the current worktree's branch; `create` creates it first. |
| `git_branch_delete` | Delete a branch; `force` = `-D`. Git refuses branches checked out anywhere — that protection is surfaced, not bypassed. |
| `git_task_start` | Start an independent task in a fresh worktree+branch and a native child agent whose cwd is frozen there (inherits the caller's model/permissions, never widened; depth-capped). Optional `setupCommands` run first; a failure never launches the agent. Returns `preparing` promptly. |
| `git_task_status` | List/query this repository's task records (state, worktree, branch, child session id, summary, commit, error); records live in the shared git common dir and are visible from linked worktrees. A dead owner's active record is marked `interrupted`; a live foreign owner is not overwritten. |
| `git_task_cancel` | Stop a task this process owns (abort setup or drain the child), preserve the worktree/branch, persist `cancelled`; idempotent on finished tasks; a foreign live task is only reported. |
| `git_task_integrate` | Merge a completed task branch into a target worktree and run `verifyCommands`; rejects active/dirty/uncommitted/source==target/running-writer cases; conflicts are preserved for manual resolution; failed verification is not acceptance and a retry never re-merges; no push/deploy. |

## 左侧工作区树：自动检测全部工作树 / The sidebar tree: every worktree auto-detected

当前 DSH（0.1.7-rc.2）的 `ui-workspace` 只声明 `sidebar.workspaces.directoryFlow`，**不再有 `sidebar.workspaces.create` 链**。因此浏览器端只注册一个 slot（`sidebar.footer.action`），并从该挂载点直接观察工作区树的 DOM，注入每行控件：

Current DSH (0.1.7-rc.2) ui-workspace declares only `sidebar.workspaces.directoryFlow`, **not the `sidebar.workspaces.create` chain**. The browser half therefore registers a single slot (`sidebar.footer.action`) and installs the per-row controls directly into the observed tree DOM:

- **`sidebar.footer.action`（渲染为空 / renders nothing，弹层打开时才渲染）** — 一个无 UI 的同步挂载点。监听工作区列表，对每个工作区调用 `/dsh-git-worktree/list`：确保仓库根（主工作树）工作区存在并标记 **`<项目名>（主工作树）`**，确保每个工作树路径都注册为工作区；**失效清扫**——auto 注册的、工作树已从 git 消失且无会话的文件夹会被自动注销（跟随 git）。20 秒静默轮询覆盖 agent 工具/CLI 在工作树层面的改动。同时它观察侧边栏工作区树，按标签把行匹配到工作区并注入控件。A renderless sync mount (popovers render from it). Watches the workspace list, queries `/dsh-git-worktree/list` per workspace: ensures the repo-root (main worktree) workspace exists and is marked **`<project>（主工作树）`**, ensures every worktree path is registered as a workspace; **stale sweep** — auto-registered folders whose worktree disappeared from git and hold no sessions are unregistered again (the tree follows git). A 20s quiet poll covers worktree-level changes made by agent tools/CLI. The same mount observes the sidebar tree, matches rows to workspaces by label, and injects the controls.
- **行级控件（DOM 注入 / injected per row）** —
  - 主文件夹（仓库主工作树）＋ → 「新增工作树」小窗：功能名 → **创建绑定会话** 或 **仅创建工作树**；注入期间其原生「新建会话」＋ 被隐藏，卸载时恢复。Primary-worktree (repo) folder ＋ → "add worktree" popover (create bound conversation / worktree only); the stock new-session ＋ is hidden while injected and restored on unmount.
  - 工作树文件夹 → 保留原生 ＋（在该工作树新建会话，出生即绑定）+ **删除工作树** 按钮（确认框：绑定会话列表、可一并归档、删除 git 工作树并注销文件夹）。Worktree folder → keeps the stock ＋ (new conversation born bound) + **删除工作树 (Remove worktree)** button (confirm: bound conversations, optional archive, removes the worktree and unregisters the folder).
  - 非仓库 / 仓库内的无关子目录 → 不注入任何控件，保持原生行为。Non-repo and unrelated nested folders → no control injected, stock behavior preserved.
  - **同名工作区** → 行上出现「选择工作区」按钮，列出每个候选的绝对路径，由用户显式选择，**绝不猜测**。**Duplicate labels** → a "选择工作区" control lists each candidate's absolute path for an explicit choice — the plugin never silently targets a guessed repository.

浏览器端通过 `ctx.webServer` 以同源方式调用 `/dsh-git-worktree` 前缀下的宿主路由（`list` / `status` / `branches` / `add` / `remove` / `bindings`）。读路由（`list` / `status`）对不在任何 git 仓库内的路径返回 `{ notARepo: true }`（200）；`bindings` 对每个输入路径逐条标记 `notARepo`/工作树归属；写操作与 agent 工具仍保持严格报错。按 dsh-host-webserver 的文档约定，这些路由**没有鉴权**——请保持默认的 loopback 绑定。

The browser talks to host routes under `/dsh-git-worktree` (`list` / `status` / `branches` / `add` / `remove` / `bindings`), served same-origin by `ctx.webServer`. The read routes (`status`, `list`) answer a path that is not inside a git repository with `{ notARepo: true }` (200); `bindings` flags each input path per-row; mutations and the agent tools keep failing strict. Per dsh-host-webserver's documented posture these routes have **no auth** — keep the bind host on the loopback default.

同步是**合并式**的：同一时刻至多一次扫描在途，扫描期间的变更折叠为一次收尾重扫；仅当检测到的工作树集合真正变化时才发布给行级 UI（避免无谓重渲染）。

Sync is **coalesced**: at most one scan in flight, later requests folded into a trailing re-run; the row-level UI is republished only when the detected worktree key sets actually move.

## 工作区树中的工作树 / Worktrees in the workspace tree

插件只注册到 `sidebar.footer.action`（自动同步 + DOM 行集成），让左侧工作区树成为**完整的绑定管理界面**。当前 `ui-workspace` 把每个工作区渲染为**平铺**的项目行（不再按路径嵌套），因此每条工作树是独立的一行，插件在该行上注入对应控件：

The plugin registers only into `sidebar.footer.action` (auto-sync + DOM row integration), making the sidebar tree the **complete binding-management surface**. Current `ui-workspace` renders each workspace as a **flat** project row (no path nesting), so every worktree is its own row and the plugin injects the matching controls on it:

- **树结构**：自动同步保证**每个工作树（包括从未打开过会话的）都注册为一个工作区行**；主工作树的路径就是仓库根，因此项目文件夹即主工作树，标题标记为 **`<项目名>（主工作树）`**。**Tree shape**: the auto-sync guarantees **every worktree (even never-opened ones) is registered as a workspace row**; the main worktree's path IS the repo root, so the project folder is the main worktree, titled **`<project>（主工作树）`**.
- **工树目录位置**：无论工作树目录在仓库内（`<repo>/.dsh-wt/<name>`）还是仓库外（显式 `path`），当前核心都将其渲染为独立的项目行；插件的能力（会话绑定、分支显示、删除工作树）不受位置影响。**Placement**: whether the worktree lives inside the repo (`<repo>/.dsh-wt/<name>`) or outside it (explicit `path`), current core renders it as its own project row; every plugin capability (binding, branch display, remove-worktree) is unaffected by placement.
- **行匹配与同名工作区**：行按标签匹配到工作区；标签重复时行上出现「选择工作区」，列出每个候选的绝对路径供显式选择，**绝不静默作用于猜测的仓库**。**Row matching**: rows match workspaces by label; on duplicate labels a "选择工作区" control lists each candidate's absolute path for an explicit choice — never a silent guess.
- **主文件夹 ＋（仓库）**：弹出「新增工作树」小窗，输入功能名 → **创建绑定会话**（创建 `.dsh-wt/<name>` 工作树并立即创建/打开绑定会话，一键）或 **仅创建工作树**；非 git 目录不注入控件，保持默认「新建会话」。小窗是具名对话框（`role="dialog"`），输入框有固定标签与示例、非法名称即时禁用并报错、规范化有变化时预览目标路径/分支；忙碌中输入与按钮禁用且不可被 Esc/点击外部关闭，空闲时 Esc/取消/点击外部关闭并把焦点还给行控件；弹层会按视口钳制位置并在长内容时滚动。**Main folder ＋ (repo)**: opens a small "add worktree" popover — feature name → **创建绑定会话 (create bound conversation)** (creates `.dsh-wt/<name>` and immediately creates/opens the bound conversation, one click) or **仅创建工作树 (worktree only)**; non-git folders keep the default new-session ＋. The popover is a named dialog with a persistent labeled input + example, live invalid-name errors, a preview of the sanitized target when it changes, busy-state locking (Esc/outside/cancel are ignored while an async step runs, otherwise they close and restore focus to the row control), and viewport-clamped positioning with scrolling for long content.
- **工作树行 ＋ / 删除工作树**：保留核心默认 ＋（在该工作树新建会话，会话出生即绑定），并新增 **删除工作树**（仅已检测到的工作树）：确认框列出绑定的会话，勾选"一并归档这些会话"后删除 git 工作树并注销其文件夹；工作树从 git 消失（agent/CLI 删除）后，无会话的文件夹由同步自动清理。**Worktree row ＋ / Remove worktree**: keeps the core default ＋ (new conversation born bound) and adds **删除工作树 (Remove worktree)** (detected worktrees only): the confirm lists bound conversations, checkbox to **archive them**, then removes the git worktree and unregisters the folder; worktrees removed on the git side (agent/CLI) are swept by the sync when their folder holds no sessions.

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
    setupCommands: []         # 可选：每个新任务工作树内顺序执行的 argv 命令（无 shell）/ optional per-task argv setup commands
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
│   ├── tasks.js        # 任务记录（原子 JSON）+ 原生子 agent 编排 + 集成/验证 / task records + child orchestration + integration
│   ├── tools.js        # defineTool 封装（9 Git + 4 任务）/ defineTool wrappers (9 git + 4 task)
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
node test/test.js        # 原功能测试：13 工具注册 + 路由处理器（bindings、unique 去重、绑定解析）
node test/tools-edge.js  # 9 工具边界矩阵：遍历防护、detach/commitIsh/force、脏工作树、上游/远程、unborn 仓库、
                         # 外部路径工作树绑定、嵌套仓库、并发 unique 竞态、already-registered 去重、脏状态矩阵、
                         # name-based 全新分支语义、info/exclude 本地忽略（空格/元字符/并发/既有字节）、同机占用守卫
node test/tasks.js       # 4 任务工具：并行隔离启动/模型与策略继承、setup 成功/失败/超时/取消、权威完成判定、
                         # cancel/teardown 释放、原子记录/重启调和/越权与损坏 id、顺序集成/冲突保留/验证重试
node test/routes-http.js # 真实 HTTP：方法校验（含 HEAD/OPTIONS）、坏 JSON/超大 body、空 repo 参数、+ 号编码、
                         # 严格 vs 宽容 notARepo、超时 abort；cwd 分支按实际值断言（独立 worktree 可移植）
node test/client-unit.js # 客户端纯函数：sanitizeName 边界（切片尾点、HEAD、代理对、check-ref-format 性质测试）、
                         # sessionsSame、boundSessions 删除名单（同 cwd 全部会话/嵌套 cwd/别名/排除兄弟）、api() 错误映射
node test/client-smoke.js # 客户端 bundle 加载 + 当前服务接线（uiWorkspace.connectWorkspace/openSession）
node test/client-current.js # 当前 DSH 兼容回归：只请求存在的 slot、服务接线、行 DOM 集成生命周期、同名选择
node test/client-dom.js  # jsdom 交互：自动同步（注册工作树/主工作树标记/失效清扫）、行级 DOM 注入
                         # （repo ＋ 新建工作树、工作树行 ＋/删除、非工作树回落、同名选择、卸载恢复）、
                         # git 优先清理/失败重试/运行中会话停用；jsdom 全局先于 react-dom，意外 window/jsdom
                         # 错误由 test/jsdom-guard.js 记录并使套件非零退出（含隔离子进程自测）
node test/flows.js       # 真实用户操作流：一键绑定会话、agent 准备/开发者打开、全生命周期、跨仓库、
                         # unborn 仓库首绑、双工作树同名竞态
node test/schema-conformance.js # 工具输出 vs 声明 schema（harness 的 validateJsonSchemaValue 原样复放）：
                         # 13 工具全部输出必须通过 additionalProperties:false 校验——防止
                         # 遗漏 absolutePath / 可空 branch / 可空 worktree / 可空任务字段之类 schema 漂移在真实会话里炸掉
```

`client-dom.js` 与 `client-current.js` 需要 jsdom（插件本身不依赖它）：从 DeepSeek Harness checkout 解析（`DSH_HARNESS` 指向其根目录，默认 `/Users/aq/deepseek-harness`），找不到时该套件自动跳过。`KEEP_SCRATCH=1` 可保留测试用临时仓库以便检查。
