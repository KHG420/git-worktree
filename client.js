/**
 * dsh-git-worktree — browser half (client plugin bundle).
 *
 * Hand-written in the DSH client-bundle format: the classic script registers a
 * factory with the vendored loader (`window.__ModuleLoader__.load`), the
 * factory materializes on demand and exports the Cordis client plugin body
 * (`apply` + `inject`). The host serves this file under /plugins and the boot
 * graph loads it — no frontend rebuild is needed.
 *
 * The panel registers into the `sidebar.footer.action` slot: a footer button
 * that toggles the **binding manager** — repo overview, worktrees with their
 * bound conversations, one-click "create bound conversation" (worktree +
 * workspace + session in a single action), and lifecycle removal that warns
 * about — and can archive — the conversations bound to a worktree. It talks to
 * the host's /dsh-git-worktree REST routes and joins session cwds with
 * `bindings` to derive the session ↔ worktree ↔ branch mapping.
 *
 * Plain DOM + injected CSS, no extra dependencies beyond react.
 */
window.__ModuleLoader__.load({
  id: "dsh-git-worktree",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react_jsx_runtime = require("react/jsx-runtime");
    let react = require("react");

    // ── styles (injected once, same pattern as first-party bundles) ────────
    const css = [
      ".gwt-panel{position:fixed;left:72px;bottom:64px;width:400px;max-height:min(72vh,600px);overflow:auto;z-index:1000;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2, #e5e7eb);background:var(--dsw-specific-menu, #fff);box-shadow:var(--dsw-shadow-lv3, 0 8px 24px rgba(0,0,0,.12));border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary, #111)}",
      ".gwt-badge{display:inline-flex;align-items:center;gap:4px;min-height:32px;padding:4px 8px;background:transparent;border:0;border-radius:8px;color:var(--dsw-alias-label-tertiary, #888);cursor:pointer;font-size:12px;line-height:18px}",
      ".gwt-badge:hover,.gwt-badge:focus-visible{color:var(--dsw-alias-label-secondary, #555);background:var(--dsw-alias-fill-l2, #f3f4f6)}",
      ".gwt-badgeCount{margin-left:2px;padding:0 6px;border-radius:99px;background:var(--dsw-alias-fill-l2, #f3f4f6);font-size:11px;line-height:18px;font-variant-numeric:tabular-nums}",
      ".gwt-head{display:flex;gap:8px;align-items:center}",
      ".gwt-repo{flex:1;min-width:0;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2, #e5e7eb);background:var(--dsw-alias-fill-l2, #f3f4f6);color:var(--dsw-alias-label-primary, #111);border-radius:8px;padding:5px 8px;font-size:12px;line-height:18px;font-family:var(--dsw-font-mono, monospace)}",
      ".gwt-repo:focus{outline:none;border-color:var(--dsw-alias-border-accent, #4f8cff)}",
      ".gwt-btn{border:1px solid var(--dsw-alias-border-l2, #e5e7eb);background:var(--dsw-alias-fill-l2, #f3f4f6);color:var(--dsw-alias-label-primary, #111);border-radius:8px;padding:4px 10px;font-size:12px;line-height:18px;cursor:pointer}",
      ".gwt-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l3, #d1d5db)}",
      ".gwt-btn:disabled{opacity:.5;cursor:default}",
      ".gwt-btnPrimary{border:0;background:var(--dsw-accent-strong, #2b6de8);color:#fff}",
      ".gwt-btnDanger{border:0;background:var(--dsw-alias-danger-strong, #d92d20);color:#fff}",
      ".gwt-error{color:var(--dsw-alias-danger-strong, #d92d20);font-size:12px;line-height:18px;word-break:break-word}",
      ".gwt-status{color:var(--dsw-alias-label-tertiary, #888);font-size:12px;line-height:18px}",
      ".gwt-rows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}",
      ".gwt-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-fill-l2, #f3f4f6)}",
      ".gwt-rowMeta{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}",
      ".gwt-rowPath{font-family:var(--dsw-font-mono, monospace);font-size:12px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary, #111)}",
      ".gwt-rowBranch{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary, #888);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".gwt-rowSessions{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary, #555);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".gwt-tag{padding:0 6px;border-radius:5px;background:var(--dsw-alias-fill-l3, #e9eaed);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary, #555);flex:none}",
      ".gwt-rowRemove{flex:none;border:0;background:transparent;color:var(--dsw-alias-danger-strong, #d92d20);cursor:pointer;font-size:12px;line-height:18px;padding:2px 4px;border-radius:6px}",
      ".gwt-rowRemove:hover{background:var(--dsw-alias-danger-soft, rgba(217,45,32,.1))}",
      ".gwt-create{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-border-l2, #e5e7eb);padding-top:10px}",
      ".gwt-createRow{display:flex;gap:8px}",
      ".gwt-createInput{flex:1;min-width:0;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2, #e5e7eb);background:var(--dsw-alias-fill-l2, #f3f4f6);color:var(--dsw-alias-label-primary, #111);border-radius:8px;padding:5px 8px;font-size:12px;line-height:18px}",
      ".gwt-createInput:focus{outline:none;border-color:var(--dsw-alias-border-accent, #4f8cff)}",
      ".gwt-created{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-ok, #12b76a);background:var(--dsw-alias-fill-ok-soft, rgba(18,183,106,.08));border-radius:10px;padding:8px 10px;font-size:12px;line-height:18px}",
      ".gwt-createdPath{font-family:var(--dsw-font-mono, monospace);word-break:break-all}",
      ".gwt-confirm{border:1px solid var(--dsw-alias-border-warn, #d97706);background:rgba(217,119,6,.07);border-radius:10px;padding:8px 10px;font-size:12px;line-height:18px;display:flex;flex-direction:column;gap:8px}",
      ".gwt-check{display:flex;gap:6px;align-items:center;font-size:12px;line-height:18px;cursor:pointer}",
      ".gwt-confirmRow{display:flex;gap:8px;justify-content:flex-end}",
      ".gwt-note{color:var(--dsw-alias-label-tertiary, #888);font-size:12px;line-height:18px}",
    ].join("\n");
    const tagId = "dsh-git-worktree/panel.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-git-worktree";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    // ── helpers ─────────────────────────────────────────────────────────────
    const cx = (...names) => names.filter(Boolean).join(" ");

    /** Same-origin call to the host route; throws with the git error message. */
    const api = async (path, init) => {
      const res = await fetch(path, init);
      let body = null;
      try {
        body = await res.json();
      } catch {
        /* non-JSON error body */
      }
      if (!res.ok || body === null || body.ok !== true) {
        const message = body?.error?.message ?? `HTTP ${res.status}`;
        const error = new Error(message);
        error.status = res.status;
        throw error;
      }
      return body.data;
    };

    const listWorktrees = (repo) => api(`/dsh-git-worktree/list?repo=${encodeURIComponent(repo)}`);
    const repoStatus = (repo) => api(`/dsh-git-worktree/status?repo=${encodeURIComponent(repo)}`);
    const post = (action, payload) => api(`/dsh-git-worktree/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const resolveBindings = (paths) => post("bindings", { paths });

    /**
     * Sanitize a user-entered feature name into a git-ref-safe worktree/branch
     * name: conservatively drop what `git check-ref-format` forbids (control
     * chars, space, ~ ^ : ? * [ \ .. //, a trailing .lock) plus path
     * separators and the '@' of a forbidden '@{' sequence, collapse runs of
     * '-' and trim leading/trailing separators. Non-ASCII names (e.g. Chinese)
     * are legal git refs and are preserved. The final result is guaranteed to
     * pass `git check-ref-format refs/heads/<name>`.
     */
    const sanitizeName = (raw) => {
      const s = raw.trim()
        .replace(/[\u0000-\u001f\u007f ~^:?*[\]\\/@]+/g, "-")
        .replace(/\.\./g, "-")
        .replace(/-+/g, "-")
        .replace(/^[-.]+|[-.]+$/g, "")
        .replace(/\.lock$/i, "");
      // Slice by code points, not UTF-16 units: an 80-unit cut can split a
      // surrogate pair ('a' + 40 emoji is 81 units -> lone surrogate).
      const cut = Array.from(s).slice(0, 80).join("");
      // The slice can re-expose a trailing dot (a 79-char prefix ending in
      // '.'), which git forbids — strip it again, then guard the reserved
      // 'HEAD' branch name and the degenerate results.
      const out = cut.replace(/[-.]+$/g, "");
      return out === "" || out === "." || out === ".." || out === "HEAD" ? "wt" : out;
    };

    /**
     * Content equality for the sessions feed. `useSessions` is
     * useSyncExternalStoreWithSelector with Object.is semantics: it re-runs the
     * selector whenever the store snapshot reference changes and, without an
     * isEqual, treats the result as changed — so a selector that maps/filters
     * into a fresh array on every call makes the panel re-render (and re-fire
     * the refresh effect below) on EVERY store notification. The sessions
     * manager bumps `updatedAt` on every session event, so that would be an
     * unbounded loop of /list + /status + /bindings requests until the browser
     * runs out of connection resources (net::ERR_INSUFFICIENT_RESOURCES).
     * Comparing the fields the panel actually renders keeps the selection
     * reference stable while the binding-relevant list has not really moved.
     */
    const sessionsSame = (a, b) => {
      if (a === b) return true;
      if (a === null || b === null || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        const x = a[i];
        const y = b[i];
        if (x === y) continue;
        if (x === undefined || y === undefined) return false;
        if (x.id !== y.id || x.cwd !== y.cwd || x.origin !== y.origin
          || x.displayTitle !== y.displayTitle || x.blank !== y.blank
          || x.running !== y.running) return false;
      }
      return true;
    };

    // ── panel component ─────────────────────────────────────────────────────
    /**
     * The binding manager. `useSessions` is the standard slot feed (current
     * session + full list); `openBoundSession` / `archiveSessions` come from
     * the plugin's inject face.
     */
    function GitWorktreePanel({ wide, useSessions, openBoundSession, archiveSessions, pickDirectory }) {
      const sessionRepo = useSessions((snapshot) => {
        // SessionListState is { ids, byId, current, ... } — the current row is byId[current].
        const current = snapshot.current === undefined ? undefined : snapshot.byId[snapshot.current];
        return current?.cwd ?? "";
      });
      // Full conversation list (subagent children share their parent's cwd and
      // are not bindings of their own). `sessionsSame` stabilizes the selection
      // identity: the sessions store notifies on every session event, and
      // without an isEqual the fresh array from map/filter would re-render the
      // panel and re-fire the refresh effect on each one — an unbounded HTTP
      // loop. With content equality the reference only changes when a session
      // is added/removed or a binding-relevant field (cwd, title, running,
      // blank, origin) actually moves.
      const allSessions = useSessions((snapshot) => snapshot.ids
        .map((id) => snapshot.byId[id])
        .filter((s) => s !== undefined && s.origin !== "subagent"),
        sessionsSame);
      const [open, setOpen] = react.useState(false);
      const [repo, setRepo] = react.useState("");
      const [status, setStatus] = react.useState(null);
      const [notRepo, setNotRepo] = react.useState(false);
      const [worktrees, setWorktrees] = react.useState([]);
      // absolutePath -> bound sessions [{ id, title, blank, running }]
      const [bindingByPath, setBindingByPath] = react.useState({});
      // Binding row for the current session: { path, notARepo, root, worktree }
      const [currentBinding, setCurrentBinding] = react.useState(null);
      const [error, setError] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [name, setName] = react.useState("");
      const [created, setCreated] = react.useState(null);
      const [opening, setOpening] = react.useState(false);
      const [removing, setRemoving] = react.useState(null); // { wt, sessions, archive }

      // Coalescing guard: at most one refresh request set in flight. A change
      // arriving mid-flight only marks a pending re-run, so rapid session
      // churn collapses into one /list+/status+/bindings trio instead of a
      // pile-up of overlapping fetches (the original ERR_INSUFFICIENT_RESOURCES
      // storm came from unbounded, non-coalesced refreshes).
      const refreshInFlight = react.useRef(false);
      const refreshPending = react.useRef(null); // latest requested target

      const refresh = react.useCallback(async (target) => {
        const resolved = (target ?? repo ?? sessionRepo).trim();
        if (!resolved) return;
        if (refreshInFlight.current) {
          refreshPending.current = resolved;
          return;
        }
        refreshInFlight.current = true;
        setError(null);
        setBusy(true);
        try {
          let current = resolved;
          do {
            refreshPending.current = null;
            const cwds = [...new Set(allSessions.map((s) => s.cwd).filter(Boolean))];
            const [wt, st, bd] = await Promise.all([
              listWorktrees(current),
              repoStatus(current),
              resolveBindings(cwds),
            ]);
            setWorktrees(wt.worktrees);
            setStatus(st);
            setNotRepo(Boolean(wt.notARepo || st.notARepo));
            const byPath = {};
            const rowsByPath = {};
            for (const row of bd.bindings) {
              rowsByPath[row.path] = row;
              if (row.worktree === null) continue;
              const session = allSessions.find((s) => s.cwd === row.path);
              if (session === undefined) continue;
              const key = row.worktree.path;
              (byPath[key] ??= []).push({
                id: session.id,
                title: session.displayTitle,
                blank: session.blank,
                running: session.running,
              });
            }
            for (const key of Object.keys(byPath)) {
              byPath[key].sort((a, b) => (a.blank ? 1 : 0) - (b.blank ? 1 : 0) || a.title.localeCompare(b.title));
            }
            setBindingByPath(byPath);
            setCurrentBinding(sessionRepo === "" ? null : (rowsByPath[sessionRepo] ?? null));
            // Re-run once if another refresh was requested while this one flew,
            // honoring the latest target (e.g. the user switched repo mid-flight).
            current = refreshPending.current ?? current;
          } while (refreshPending.current !== null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          setWorktrees([]);
          setStatus(null);
          setNotRepo(false);
          setBindingByPath({});
          setCurrentBinding(null);
        } finally {
          refreshInFlight.current = false;
          setBusy(false);
        }
      }, [repo, sessionRepo, allSessions]);

      react.useEffect(() => {
        if (!open) return;
        if (repo === "" && sessionRepo !== "") setRepo(sessionRepo);
        refresh(repo === "" ? sessionRepo : repo);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [open, sessionRepo, allSessions]);

      // Click-outside closes the panel: while open, any pointerdown landing
      // neither on the panel nor on the toggle badge dismisses it. The badge's
      // own onClick keeps its toggle behavior (so clicking Bindings again still
      // closes), and pointerdowns inside the panel keep working — including
      // text selection in the repo input — because they never reach here.
      react.useEffect(() => {
        if (!open) return;
        const onPointerDown = (event) => {
          const target = event.target;
          if (target instanceof Element
            && (target.closest(".gwt-panel") !== null || target.closest(".gwt-badge") !== null)) return;
          setOpen(false);
        };
        document.addEventListener("pointerdown", onPointerDown);
        return () => document.removeEventListener("pointerdown", onPointerDown);
      }, [open]);

      /** One-click: create the worktree, register the workspace, open a bound session. */
      const doCreate = async () => {
        const target = (repo || sessionRepo).trim();
        const base = sanitizeName(name);
        if (!target || base === "") return;
        setBusy(true);
        setError(null);
        setCreated(null);
        try {
          const result = await post("add", { repo: target, name: base, unique: true });
          let opened = null;
          if (result.absolutePath !== undefined && result.absolutePath !== null && result.absolutePath !== "") {
            opened = await openBoundSession(result.absolutePath);
          }
          setCreated({
            ...result,
            opened: opened === null ? null : opened.ok ? true : false,
          });
          await refresh(target);
          // refresh() clears the error line at its start, so surface the
          // open-failure reason AFTER it — otherwise the reason is lost
          if (opened !== null && !opened.ok) setError(opened.message ?? "session could not be opened");
          setName("");
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      };

      /** Worktree only — for agent-prepared flows; the row button opens a session later. */
      const doCreateOnly = async () => {
        const target = (repo || sessionRepo).trim();
        const base = sanitizeName(name);
        if (!target || base === "") return;
        setBusy(true);
        setError(null);
        setCreated(null);
        try {
          const result = await post("add", { repo: target, name: base, unique: true });
          setCreated(result);
          await refresh(target);
          setName("");
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      };

      const doOpenSession = async (wt) => {
        setOpening(true);
        setError(null);
        try {
          const result = await openBoundSession(wt.absolutePath ?? wt.path);
          await refresh();
          // refresh() clears the error line at its start — set the reason after
          if (!result.ok) setError(result.message ?? "could not open a bound conversation");
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setOpening(false);
        }
      };

      const beginRemove = (wt) => {
        const bound = bindingByPath[wt.absolutePath ?? wt.path] ?? [];
        if (bound.length === 0) {
          void doRemove(wt, [], false);
          return;
        }
        setRemoving({ wt, sessions: bound, archive: true });
      };

      const doRemove = async (wt, sessions, archive) => {
        const target = (repo || sessionRepo).trim();
        if (!target) return;
        setBusy(true);
        setError(null);
        try {
          if (archive && sessions.length > 0) await archiveSessions(sessions.map((s) => s.id));
          await post("remove", { repo: target, path: wt.absolutePath ?? wt.path });
          setRemoving(null);
          if (created !== null && (wt.absolutePath ?? wt.path) === created.absolutePath) setCreated(null);
          await refresh(target);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      };

      /**
       * Badge click: open the host's native OS folder chooser first, so the
       * operator can pick the working directory (the repo path the panel
       * operates on) instead of typing it. A picked path becomes `repo` —
       * opening the panel on it (closed) or refreshing in place (open).
       * Cancelling — or a host without the `native` picker capability —
       * falls back to the plain open/close toggle, so peeking at the panel
       * still works.
       */
      const onBadgeClick = async () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        let picked = null;
        let failed = null;
        try {
          picked = await pickDirectory();
        } catch (e) {
          failed = e instanceof Error ? e.message : String(e);
        } finally {
          setBusy(false);
        }
        if (picked !== null && picked !== "") {
          setRepo(picked);
          if (open) {
            await refresh(picked);
          } else {
            setOpen(true); // the refresh effect fires on open and targets the new repo
          }
        } else {
          setOpen((value) => !value);
          // refresh() clears the error line at its start, so on the open
          // path this message is transient — it stays visible when the
          // panel is already open (no re-refresh happens there).
          if (failed !== null) setError(failed);
        }
      };

      const trigger = react_jsx_runtime.jsxs("button", {
        type: "button",
        className: cx("gwt-badge"),
        "aria-label": "Git worktrees",
        "aria-expanded": open,
        title: "Git worktrees — 选择工作目录 / pick working directory",
        onClick: () => void onBadgeClick(),
        children: [
          react_jsx_runtime.jsx("span", { children: "⑂" }),
          wide && react_jsx_runtime.jsx("span", { children: "Bindings" }),
          worktrees.length > 0 && react_jsx_runtime.jsx("span", { className: "gwt-badgeCount", children: String(worktrees.length) }),
        ],
      });

      if (!open) return trigger;

      const boundFor = (wt) => bindingByPath[wt.absolutePath ?? wt.path] ?? [];

      const panel = react_jsx_runtime.jsxs("div", {
        className: "gwt-panel",
        children: [
          react_jsx_runtime.jsxs("div", {
            className: "gwt-head",
            children: [
              react_jsx_runtime.jsx("input", {
                className: "gwt-repo",
                value: repo,
                placeholder: sessionRepo || "repo path",
                onChange: (event) => setRepo(event.target.value),
              }),
              react_jsx_runtime.jsx("button", {
                type: "button",
                className: "gwt-btn",
                disabled: busy,
                onClick: () => refresh(),
                children: busy ? "…" : "刷新",
              }),
            ],
          }),
          error !== null && react_jsx_runtime.jsx("p", { className: "gwt-error", children: error }),
          notRepo && react_jsx_runtime.jsx("p", {
            className: "gwt-note",
            children: `"${(repo || sessionRepo).trim()}" 不是 git repo — 请输入 repo 路径后点击刷新`,
          }),
          !notRepo && status !== null && react_jsx_runtime.jsx("p", {
            className: "gwt-status",
            children: `branch ${status.branch ?? "(detached)"} · ${status.clean ? "clean" : `${status.entries.length} dirty`}`,
          }),
          currentBinding !== null && react_jsx_runtime.jsx("p", {
            className: "gwt-status",
            children: currentBinding.notARepo
              ? "本会话：不在 git 仓库中"
              : currentBinding.worktree === null
                ? `本会话：仓库内但不在任何已注册工作树（${currentBinding.repo}）`
                : currentBinding.worktree.primary
                  ? `本会话：未绑定 — 共享主工作树（${currentBinding.repo}）`
                  : `本会话：已绑定 ${currentBinding.worktree.path}（branch ${currentBinding.worktree.branch ?? "detached"}）`,
          }),
          react_jsx_runtime.jsx("ul", {
            className: "gwt-rows",
            children: worktrees.length === 0
              ? react_jsx_runtime.jsx("li", { className: "gwt-note", children: "暂无 worktree — 点击刷新或选择 repo" })
              : worktrees.map((wt) => {
                const bound = boundFor(wt);
                return react_jsx_runtime.jsxs("li", {
                  className: "gwt-row",
                  children: [
                    react_jsx_runtime.jsxs("div", {
                      className: "gwt-rowMeta",
                      children: [
                        react_jsx_runtime.jsx("span", { className: "gwt-rowPath", children: wt.path }),
                        react_jsx_runtime.jsx("span", {
                          className: "gwt-rowBranch",
                          children: `${wt.branch ?? "(detached)"} @ ${wt.head ?? "?"}`,
                        }),
                        bound.length > 0 && react_jsx_runtime.jsx("span", {
                          className: "gwt-rowSessions",
                          children: bound.map((s) => s.title).join("、"),
                        }),
                      ],
                    }),
                    wt.primary && react_jsx_runtime.jsx("span", { className: "gwt-tag", children: "primary" }),
                    wt.current && react_jsx_runtime.jsx("span", { className: "gwt-tag", children: "当前会话" }),
                    bound.length > 0 && react_jsx_runtime.jsx("span", { className: "gwt-tag", children: `${bound.length} 会话绑定` }),
                    !wt.primary && react_jsx_runtime.jsx("button", {
                      type: "button",
                      className: "gwt-btn",
                      disabled: busy || opening,
                      onClick: () => doOpenSession(wt),
                      children: "打开绑定会话",
                    }),
                    !wt.primary && react_jsx_runtime.jsx("button", {
                      type: "button",
                      className: "gwt-rowRemove",
                      disabled: busy,
                      onClick: () => beginRemove(wt),
                      children: "删除",
                    }),
                  ],
                }, wt.absolutePath ?? wt.path);
              }),
          }),
          removing !== null && react_jsx_runtime.jsxs("div", {
            className: "gwt-confirm",
            children: [
              react_jsx_runtime.jsxs("span", {
                children: [
                  "删除工作树 ",
                  react_jsx_runtime.jsx("span", { className: "gwt-createdPath", children: removing.wt.path }),
                  "？",
                ],
              }),
              react_jsx_runtime.jsxs("span", {
                children: [
                  `绑定于此的会话（${removing.sessions.length}）：`,
                  removing.sessions.map((s) => s.title).join("、"),
                ],
              }),
              react_jsx_runtime.jsxs("label", {
                className: "gwt-check",
                children: [
                  react_jsx_runtime.jsx("input", {
                    type: "checkbox",
                    checked: removing.archive,
                    onChange: (event) => setRemoving({ ...removing, archive: event.target.checked }),
                  }),
                  "一并归档这些会话（日志保留，侧边栏隐藏）",
                ],
              }),
              react_jsx_runtime.jsxs("div", {
                className: "gwt-confirmRow",
                children: [
                  react_jsx_runtime.jsx("button", {
                    type: "button",
                    className: "gwt-btn",
                    disabled: busy,
                    onClick: () => setRemoving(null),
                    children: "取消",
                  }),
                  react_jsx_runtime.jsx("button", {
                    type: "button",
                    className: "gwt-btn gwt-btnDanger",
                    disabled: busy,
                    onClick: () => doRemove(removing.wt, removing.sessions, removing.archive),
                    children: busy ? "…" : "确认删除",
                  }),
                ],
              }),
            ],
          }),
          react_jsx_runtime.jsxs("div", {
            className: "gwt-create",
            children: [
              react_jsx_runtime.jsx("input", {
                className: "gwt-createInput",
                value: name,
                placeholder: "feature name → .dsh-wt/<name>（自动绑定新会话）",
                onChange: (event) => setName(event.target.value),
              }),
              react_jsx_runtime.jsx("button", {
                type: "button",
                className: "gwt-btn gwt-btnPrimary",
                disabled: busy || name.trim() === "" || (repo || sessionRepo).trim() === "",
                onClick: doCreate,
                children: "创建绑定会话",
              }),
              react_jsx_runtime.jsx("button", {
                type: "button",
                className: "gwt-btn",
                disabled: busy || name.trim() === "" || (repo || sessionRepo).trim() === "",
                onClick: doCreateOnly,
                children: "仅创建工作树",
              }),
            ],
          }),
          created !== null && react_jsx_runtime.jsxs("div", {
            className: "gwt-created",
            children: [
              react_jsx_runtime.jsxs("span", {
                children: [
                  "已创建 ",
                  react_jsx_runtime.jsx("span", { className: "gwt-createdPath", children: created.path }),
                  created.branch ? `（branch ${created.branch}）` : "",
                ],
              }),
              created.opened === true && react_jsx_runtime.jsx("span", { children: "已打开绑定会话" }),
              created.opened === false && react_jsx_runtime.jsx("span", {
                children: "工作树已创建；会话打开失败，可在该行点击“打开绑定会话”重试",
              }),
            ],
          }),
        ],
      });

      return react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
        children: [trigger, panel],
      });
    }

    // ── client plugin body ──────────────────────────────────────────────────
    const inject = ["sessions", "workspaces", "slots"];

    function apply(ctx) {
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
        name: "sidebar.footer.action",
        id: "git-worktree-panel",
        inject: () => {
          const workspaces = ctx.get("workspaces");
          const sessions = ctx.get("sessions");
          return {
            /**
             * Register the worktree path as a workspace and open a new session
             * rooted there — the conversation is born bound to that worktree.
             * @returns {{ ok: boolean, sessionId?: string, message?: string }}
             */
            openBoundSession: async (path) => {
              try {
                const workspace = await workspaces.create({ path });
                const sessionId = await workspaces.connectWorkspace(workspace.workspaceId);
                sessions.open(sessionId);
                return { ok: true, sessionId };
              } catch (e) {
                return { ok: false, message: e instanceof Error ? e.message : String(e) };
              }
            },
            /** Archive (hide) sessions; their logs stay intact. */
            archiveSessions: async (ids) => {
              for (const id of ids) await workspaces.archiveSession(id);
            },
            /**
             * Open the host's native OS folder chooser (the `native`
             * directory-picker capability). Resolves the chosen absolute
             * path, or null when the operator cancels; rejects when the host
             * composes a non-native (browse) picker — the panel surfaces the
             * reason and keeps the manual path input as the fallback.
             */
            pickDirectory: () => workspaces.pickDirectory(),
          };
        },
      }, GitWorktreePanel));
    }

    exports.apply = apply;
    exports.inject = inject;
    // Test-only surface for the standalone client tests (test/client-unit.js,
    // test/client-dom.js): the pure helpers the panel uses internally. Not
    // part of the public API.
    exports._test = { sanitizeName, sessionsSame, api };
    return module.exports;
  },
});
