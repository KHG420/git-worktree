/**
 * dsh-git-worktree — browser half (client plugin bundle).
 *
 * Hand-written in the DSH client-bundle format: the classic script registers a
 * factory with the vendored loader (`window.__ModuleLoader__.load`), the
 * factory materializes on demand and exports the Cordis client plugin body
 * (`apply` + `inject`). The host serves this file under /plugins and the boot
 * graph loads it — no frontend rebuild is needed.
 *
 * The sidebar footer Bindings panel is gone: the **left workspace tree is the
 * single surface**. The plugin does two things there:
 *
 * 1. **Auto-detect every project's worktrees.** A renderless component
 *    (`WorktreeSync`, mounted via the `sidebar.footer.action` slot) watches
 *    the workspace list, queries `/dsh-git-worktree/list` for every
 *    workspace, and ensures each git repo's worktrees are registered as
 *    nested workspace folders — so the core tree renders them as subfolders
 *    under the project folder with sessions grouped by exact cwd. The main
 *    worktree IS the project folder; its title gains a `（主工作树）` marker.
 *    Worktrees created or removed on the git side (agent tools, CLI) are
 *    picked up by a quiet poll; registrations for worktrees that disappeared
 *    (and carry no sessions) are unregistered again.
 * 2. **Per-row affordances** through the `sidebar.workspaces.create` chain:
 *    a repo folder's ＋ opens the "新增工作树" popover (worktree + workspace +
 *    bound session in one click, unchanged); a worktree subfolder row keeps
 *    the default new-session ＋ (the session is born inside that worktree,
 *    i.e. bound) and gains a 删除工作树 button whose anchored confirm lists
 *    the bound conversations, offers to archive them, removes the git
 *    worktree and unregisters its folder.
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
      // Per-row worktree-create affordance inside the workspace tree: a bare
      // ＋ matching the core's hover-revealed row action, plus the anchored
      // popover that collects the feature name.
      ".gwt-rowPlus{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary, #888);cursor:pointer;padding:0}",
      ".gwt-rowPlus:hover{background:var(--dsw-alias-fill-l3, #e9eaed);color:var(--dsw-alias-label-secondary, #555)}",
      // Per-row remove-worktree affordance (nested worktree folder rows).
      ".gwt-rowRemove{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary, #888);cursor:pointer;padding:0}",
      ".gwt-rowRemove:hover{background:var(--dsw-alias-danger-soft, rgba(217,45,32,.1));color:var(--dsw-alias-danger-strong, #d92d20)}",
      // Anchored popover base (create + delete share it).
      ".gwt-createPop{position:fixed;z-index:1001;width:300px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2, #e5e7eb);background:var(--dsw-specific-menu, #fff);box-shadow:var(--dsw-shadow-lv3, 0 8px 24px rgba(0,0,0,.12));border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary, #111)}",
      ".gwt-createPop .gwt-head{display:flex;flex-direction:column;gap:2px}",
      ".gwt-createPop .gwt-popPath{font-family:var(--dsw-font-mono, monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary, #888);word-break:break-all}",
      ".gwt-createPop .gwt-popBranch{font-family:var(--dsw-font-mono, monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary, #888)}",
      ".gwt-createInput{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2, #e5e7eb);background:var(--dsw-alias-fill-l2, #f3f4f6);color:var(--dsw-alias-label-primary, #111);border-radius:8px;padding:5px 8px;font-size:12px;line-height:18px}",
      ".gwt-createInput:focus{outline:none;border-color:var(--dsw-alias-border-accent, #4f8cff)}",
      ".gwt-btn{border:1px solid var(--dsw-alias-border-l2, #e5e7eb);background:var(--dsw-alias-fill-l2, #f3f4f6);color:var(--dsw-alias-label-primary, #111);border-radius:8px;padding:4px 10px;font-size:12px;line-height:18px;cursor:pointer}",
      ".gwt-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l3, #d1d5db)}",
      ".gwt-btn:disabled{opacity:.5;cursor:default}",
      ".gwt-btnPrimary{border:0;background:var(--dsw-accent-strong, #2b6de8);color:#fff}",
      ".gwt-btnDanger{border:0;background:var(--dsw-alias-danger-strong, #d92d20);color:#fff}",
      ".gwt-error{color:var(--dsw-alias-danger-strong, #d92d20);font-size:12px;line-height:18px;word-break:break-word;margin:0}",
      ".gwt-note{color:var(--dsw-alias-label-tertiary, #888);font-size:12px;line-height:18px}",
      ".gwt-created{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-ok, #12b76a);background:var(--dsw-alias-fill-ok-soft, rgba(18,183,106,.08));border-radius:10px;padding:8px 10px;font-size:12px;line-height:18px}",
      ".gwt-createdPath{font-family:var(--dsw-font-mono, monospace);word-break:break-all}",
      ".gwt-check{display:flex;gap:6px;align-items:center;font-size:12px;line-height:18px;cursor:pointer}",
      ".gwt-createRow{display:flex;gap:8px;justify-content:flex-end}",
      ".gwt-confirmRow{display:flex;gap:8px;justify-content:flex-end}",
      ".gwt-boundList{color:var(--dsw-alias-label-secondary, #555);font-size:12px;line-height:18px;word-break:break-word}",
    ].join("\n");
    const tagId = "dsh-git-worktree/tree.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-git-worktree";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    // ── helpers ─────────────────────────────────────────────────────────────
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
    const post = (action, payload) => api(`/dsh-git-worktree/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const resolveBindings = (paths) => post("bindings", { paths });

    /** Last path segment of an absolute directory path (both separators). */
    const basename = (path) => {
      const base = path.replace(/[/\\]+$/, "").split(/[/\\]/).pop();
      return base !== undefined && base !== "" ? base : path;
    };

    /** Whether `childPath` is a strict subdirectory of `parentPath`. */
    const pathInside = (parentPath, childPath) => {
      if (parentPath === childPath) return false;
      const parent = parentPath.replace(/[/\\]+$/, "");
      const child = childPath.replace(/[/\\]+$/, "");
      if (parent === "" || child === "") return false;
      return child.startsWith(parent + "/") || child.startsWith(parent + "\\");
    };

    /**
     * Stop an event from leaving the popover container. The popover is a DOM
     * child of the workspace-tree row (the `sidebar.workspaces.create` chain
     * renders inside the row's action cell), and that row div carries
     * `onClick={onToggle}` — so without this guard, a click on the popover's
     * input, buttons, header or path text bubbles up to the row and toggles
     * the group's expand/collapse. Pointer-down and mousedown are stopped too
     * so a press inside the popover never feeds the row's other pointer
     * behaviors (e.g. the HTML5 row drag that the core wires to the row).
     */
    const stopPopoverEvent = (event) => event.stopPropagation();

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
     * into a fresh array on every call makes the consuming component re-render
     * on EVERY store notification. The sessions manager bumps `updatedAt` on
     * every session event, so comparing the fields the UI actually reads keeps
     * the selection reference stable while the list has not really moved.
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

    // ── worktree knowledge store (module-level, shared by sync + rows) ──────
    /**
     * Live git-side facts the row affordances read: absolute worktree path →
     * { branch, head, primary, repoRoot }, plus repoRoot → worktree paths.
     * `WorktreeSync` republishes after every pass; `WorktreeCreateButton`
     * subscribes via useSyncExternalStore to decide whether a nested row is a
     * worktree (and thus gets the 删除工作树 affordance).
     */
    const worktreeStore = {
      /** Immutable-per-publish snapshot: { byPath: Map, roots: Map } — replaced, never mutated. */
      state: { byPath: new Map(), roots: new Map() },
      version: 0,
      listeners: new Set(),
    };
    // Arrow-function members (not method shorthand): the store is handed to
    // useSyncExternalStore as bare references, so `this` must not be used.
    worktreeStore.subscribe = (listener) => {
      worktreeStore.listeners.add(listener);
      return () => { worktreeStore.listeners.delete(listener); };
    };
    worktreeStore.getSnapshot = () => worktreeStore.state;
    worktreeStore.publish = (byPath, roots) => {
      worktreeStore.state = { byPath, roots };
      worktreeStore.version += 1;
      for (const listener of [...worktreeStore.listeners]) listener();
    };

    // The workspace ids the sync auto-registered for worktrees. Persisted so a
    // reload can still tell "our registration" from a user-created workspace
    // when sweeping stale entries after a worktree disappears.
    const AUTO_KEY = "dsh-git-worktree/auto-workspaces";
    const loadAuto = () => {
      try {
        const raw = localStorage.getItem(AUTO_KEY);
        const arr = raw === null ? [] : JSON.parse(raw);
        return new Set(Array.isArray(arr) ? arr : []);
      } catch {
        return new Set();
      }
    };
    const saveAuto = (set) => {
      try {
        localStorage.setItem(AUTO_KEY, JSON.stringify([...set]));
      } catch {
        /* storage unavailable (SSR, private mode) — in-memory set still works */
      }
    };

    /** Same-key-set comparison for the publish no-op check. */
    const sameKeySet = (a, b) => {
      if (a.size !== b.size) return false;
      for (const key of a.keys()) if (!b.has(key)) return false;
      return true;
    };

    /**
     * One synchronization pass. For every workspace that is inside a git repo:
     * ensure the repo-root workspace exists with the `（主工作树）` marker,
     * ensure every worktree path has a workspace (so the core tree nests them
     * under the project folder), unregister auto-created registrations whose
     * worktree is gone (only when they hold no sessions), and republish the
     * worktree store.
     *
     * @param workspaces - current `WorkspaceView[]` from the workspace list.
     * @param face - `{ list, create, rename, delete }`; `list(path)` resolves
     *   `/dsh-git-worktree/list` data, the rest the workspace runtime actions.
     * @returns `{ repos: number }` — repos scanned this pass.
     */
    let syncRunning = false;
    let syncPending = null; // { workspaces, face }
    async function doRunSync(workspaces, face) {
      const byPath = new Map(workspaces.map((w) => [w.path, w]));
      const idToWs = new Map(workspaces.map((w) => [w.workspaceId, w]));
      const auto = loadAuto();
      const createdNow = new Set();
      const roots = new Map(); // repoRoot -> { worktrees: Map<absPath, info> }

      // 1. Discover repos + worktrees from git for every registered workspace.
      for (const w of workspaces) {
        let data = null;
        try {
          data = await face.list(w.path);
        } catch (error) {
          console.warn("git-worktree: list failed for", w.path, error);
          continue;
        }
        if (data === null || data.notARepo) continue;
        const list = data.worktrees ?? [];
        if (list.length === 0) continue;
        const main = list.find((wt) => wt.primary) ?? list[0];
        const root = main.absolutePath ?? main.path;
        let entry = roots.get(root);
        if (entry === undefined) {
          entry = { worktrees: new Map() };
          roots.set(root, entry);
        }
        for (const wt of list) {
          const abs = wt.absolutePath ?? wt.path;
          entry.worktrees.set(abs, {
            branch: wt.branch ?? null,
            head: wt.head ?? null,
            primary: Boolean(wt.primary),
            repoRoot: root,
          });
        }
      }

      // 2. Ensure registrations: project folder (= main worktree, marked
      //    主工作树) and one folder per linked worktree.
      for (const [root, entry] of roots) {
        const base = basename(root);
        const marked = `${base}（主工作树）`;
        const existing = byPath.get(root);
        if (existing === undefined) {
          try {
            const created = await face.create({ path: root });
            createdNow.add(created.workspaceId);
            auto.add(created.workspaceId);
            byPath.set(root, created);
            if (created.title !== marked) {
              try {
                await face.rename(created.workspaceId, marked);
              } catch (error) {
                console.warn("git-worktree: main-worktree rename failed", root, error);
              }
            }
          } catch (error) {
            console.warn("git-worktree: register main worktree failed", root, error);
          }
        } else if (existing.title === base) {
          // Default title → mark it as the main worktree once (a custom
          // title the user set is never overwritten).
          try {
            await face.rename(existing.workspaceId, marked);
          } catch (error) {
            console.warn("git-worktree: main-worktree rename failed", root, error);
          }
        }
        for (const [abs, info] of entry.worktrees) {
          if (info.primary) continue;
          if (byPath.has(abs)) continue;
          try {
            const created = await face.create({ path: abs });
            createdNow.add(created.workspaceId);
            auto.add(created.workspaceId);
            byPath.set(abs, created);
          } catch (error) {
            console.warn("git-worktree: register worktree failed", abs, error);
          }
        }
      }

      // 3. Stale sweep: auto-created registrations whose worktree is gone and
      //    which hold no sessions are unregistered again (the tree follows
      //    git). Registrations with sessions stay — the conversations are
      //    still grouped there even if the directory is gone.
      for (const id of [...auto]) {
        if (createdNow.has(id)) continue; // fresh this pass — cannot be stale
        const w = idToWs.get(id);
        if (w === undefined) {
          auto.delete(id);
          continue;
        }
        let underRoot = false;
        let stillWorktree = false;
        for (const [root, entry] of roots) {
          if (!pathInside(root, w.path)) continue;
          underRoot = true;
          if (entry.worktrees.has(w.path)) {
            stillWorktree = true;
            break;
          }
        }
        if (underRoot && !stillWorktree && w.sessionIds.length === 0) {
          try {
            await face.delete(id);
            auto.delete(id);
          } catch (error) {
            console.warn("git-worktree: unregister stale workspace failed", w.path, error);
          }
        }
      }
      saveAuto(auto);

      // 4. Republish the worktree knowledge for the row affordances (only
      //    when the key sets actually moved, to keep re-renders quiet).
      const byPathOut = new Map();
      const rootsOut = new Map();
      for (const [root, entry] of roots) {
        const paths = [];
        for (const [abs, info] of entry.worktrees) {
          byPathOut.set(abs, info);
          paths.push(abs);
        }
        rootsOut.set(root, paths);
      }
      if (!sameKeySet(worktreeStore.state.byPath, byPathOut)
        || !sameKeySet(worktreeStore.state.roots, rootsOut)) {
        worktreeStore.publish(byPathOut, rootsOut);
      }

      return { repos: roots.size };
    }

    /**
     * Coalesced entry: at most one pass in flight; a request arriving
     * mid-pass marks a pending re-run with the latest inputs.
     */
    function runSync(workspaces, face) {
      if (syncRunning) {
        syncPending = { workspaces, face };
        return Promise.resolve({ repos: 0, coalesced: true });
      }
      syncRunning = true;
      return doRunSync(workspaces, face).finally(() => {
        syncRunning = false;
        if (syncPending !== null) {
          const next = syncPending;
          syncPending = null;
          runSync(next.workspaces, next.face);
        }
      });
    }

    // ── renderless sync mount ───────────────────────────────────────────────
    /**
     * Mounted into `sidebar.footer.action` (rendered in both sidebar widths);
     * renders nothing. Watches the workspace list and keeps every project's
     * worktrees registered as nested folders. A quiet poll covers git-side
     * changes (agent tools, CLI) that never touch the workspace list.
     *
     * `debounceMs`/`intervalMs` are props so tests can shrink them.
     */
    const SYNC_DEBOUNCE_MS = 400;
    const SYNC_INTERVAL_MS = 20000;
    function WorktreeSync({ useWorkspaces, sync, debounceMs = SYNC_DEBOUNCE_MS, intervalMs = SYNC_INTERVAL_MS }) {
      const items = useWorkspaces((state) => state.items);
      const phase = useWorkspaces((state) => state.phase);

      react.useEffect(() => {
        if (phase !== "ready") return;
        const timer = window.setTimeout(() => {
          void runSync(items, sync).catch((error) => {
            console.warn("git-worktree: sync failed", error);
          });
        }, debounceMs);
        const interval = window.setInterval(() => {
          void runSync(items, sync).catch((error) => {
            console.warn("git-worktree: sync failed", error);
          });
        }, intervalMs);
        return () => {
          window.clearTimeout(timer);
          window.clearInterval(interval);
        };
      }, [items, phase, sync, debounceMs, intervalMs]);

      return null;
    }

    // ── workspace-tree row affordances ──────────────────────────────────────
    /** Repo-ness probe for top-level rows, cached per path (as before). */
    const repoKindCache = new Map(); // cwd -> 'repo' | 'not-repo'
    const repoKind = (cwd) => {
      if (repoKindCache.has(cwd)) return Promise.resolve(repoKindCache.get(cwd));
      return listWorktrees(cwd)
        .then((data) => {
          const kind = data.notARepo ? "not-repo" : "repo";
          repoKindCache.set(cwd, kind);
          return kind;
        })
        .catch(() => {
          repoKindCache.set(cwd, "not-repo");
          return "not-repo";
        });
    };

    const PlusGlyph = () => react_jsx_runtime.jsx("svg", {
      width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
      stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round",
      "aria-hidden": true,
      children: react_jsx_runtime.jsx("path", { d: "M8 3v10M3 8h10" }),
    });

    const TrashGlyph = () => react_jsx_runtime.jsx("svg", {
      width: 15, height: 15, viewBox: "0 0 16 16", fill: "none",
      stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round",
      "aria-hidden": true,
      children: [
        react_jsx_runtime.jsx("path", { d: "M2.5 4.5h11" }),
        react_jsx_runtime.jsx("path", { d: "M6 4.5V3.2A1.2 1.2 0 0 1 7.2 2h1.6A1.2 1.2 0 0 1 10 3.2v1.3" }),
        react_jsx_runtime.jsx("path", { d: "M4 4.5l.6 8.2A1.2 1.2 0 0 0 5.8 14h4.4a1.2 1.2 0 0 0 1.2-1.3l.6-8.2" }),
        react_jsx_runtime.jsx("path", { d: "M6.5 7.5v4M9.5 7.5v4" }),
      ],
    });

    /**
     * Chain component for `sidebar.workspaces.create`. Receives the owner
     * share ({ group, defaultCreate }), the selector's `matched`, and the
     * inject face.
     *
     * - Top-level repo folder: ＋ opens the "新增工作树" popover (create
     *   worktree + bound conversation). Top-level non-repo: the default
     *   new-session ＋.
     * - Nested worktree folder: the default new-session ＋ (session born in
     *   that worktree = bound) plus a 删除工作树 button whose confirm lists
     *   bound conversations, optionally archives them, removes the git
     *   worktree and unregisters its folder.
     * - Nested non-worktree folder: only the default new-session ＋.
     */
    function WorktreeCreateButton({ group, defaultCreate, matched, useSessions, openBoundSession, archiveSessions, sync }) {
      const cwd = matched.cwd;
      const topLevel = matched.topLevel;
      const [kind, setKind] = react.useState("unknown");
      const [open, setOpen] = react.useState(false); // create popover
      const [deleteOpen, setDeleteOpen] = react.useState(false); // delete confirm popover
      const [anchor, setAnchor] = react.useState(null); // { left, top }
      const [name, setName] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState(null);
      const [removing, setRemoving] = react.useState(null); // { sessions, archive }
      const [removeError, setRemoveError] = react.useState(null);

      // Full conversation list (subagent children share their parent's cwd and
      // are not bindings of their own); `sessionsSame` keeps the selection
      // identity stable across session-store notifications.
      const allSessions = useSessions((snapshot) => snapshot.ids
        .map((id) => snapshot.byId[id])
        .filter((s) => s !== undefined && s.origin !== "subagent"),
      sessionsSame);
      const worktreeState = react.useSyncExternalStore(worktreeStore.subscribe, worktreeStore.getSnapshot, worktreeStore.getSnapshot);
      const worktreeInfo = worktreeState.byPath.get(cwd) ?? null;

      react.useEffect(() => {
        if (!topLevel) return;
        let cancelled = false;
        repoKind(cwd).then((k) => {
          if (cancelled) return;
          setKind(k);
        });
        return () => { cancelled = true; };
      }, [cwd, topLevel]);

      // Click-outside closes either popover (same pattern as the old panel).
      react.useEffect(() => {
        if (!open && !deleteOpen) return;
        const onPointerDown = (event) => {
          const target = event.target;
          if (target instanceof Element
            && (target.closest(".gwt-createPop") !== null
              || target.closest(".gwt-rowPlus") !== null
              || target.closest(".gwt-rowRemove") !== null)) return;
          setOpen(false);
          setDeleteOpen(false);
        };
        document.addEventListener("pointerdown", onPointerDown);
        return () => document.removeEventListener("pointerdown", onPointerDown);
      }, [open, deleteOpen]);

      /** One-click from a repo folder: create the worktree, register the workspace, open a bound session. */
      const doCreate = async (withSession) => {
        const base = sanitizeName(name);
        if (base === "" || busy) return;
        setBusy(true);
        setError(null);
        try {
          const result = await post("add", { repo: cwd, name: base, unique: true });
          let opened = null;
          if (withSession && result.absolutePath !== undefined && result.absolutePath !== null && result.absolutePath !== "") {
            opened = await openBoundSession(result.absolutePath);
          }
          if (withSession && opened !== null && !opened.ok) {
            // Keep the popover open so the failure reason is visible; the
            // worktree folder's ＋ can start a session later.
            setError(opened.message ?? "工作树已创建；会话打开失败 — 可点击该工作树文件夹的 ＋ 新建会话");
            return;
          }
          setName("");
          setOpen(false);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      };

      // Bound sessions for the delete confirm, resolved from the live feed.
      const beginRemove = async (event) => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        setAnchor({ left: rect.right + 8, top: rect.top });
        setDeleteOpen(true);
        setRemoveError(null);
        setRemoving({ sessions: [], archive: false });
        try {
          const cwds = [...new Set(allSessions.map((s) => s.cwd).filter(Boolean))];
          const bd = await resolveBindings(cwds);
          const bound = [];
          for (const row of bd.bindings) {
            if (row.worktree === null || row.worktree.path !== cwd) continue;
            const session = allSessions.find((s) => s.cwd === row.path);
            if (session === undefined) continue;
            bound.push({ id: session.id, title: session.displayTitle, blank: session.blank });
          }
          bound.sort((a, b) => (a.blank ? 1 : 0) - (b.blank ? 1 : 0) || a.title.localeCompare(b.title));
          setRemoving({ sessions: bound, archive: bound.length > 0 });
        } catch (e) {
          setRemoveError(e instanceof Error ? e.message : String(e));
        }
      };

      const confirmRemove = async () => {
        if (removing === null || busy) return;
        if (worktreeInfo === null) {
          setRemoveError("该文件夹不是已检测到的工作树");
          return;
        }
        setBusy(true);
        setRemoveError(null);
        try {
          if (removing.archive && removing.sessions.length > 0) {
            await archiveSessions(removing.sessions.map((s) => s.id));
          }
          await post("remove", { repo: worktreeInfo.repoRoot, path: cwd });
          if (matched.workspaceId !== undefined) {
            try {
              await sync.delete(matched.workspaceId);
            } catch {
              /* registration already gone — fine */
            }
          }
          setDeleteOpen(false);
          setRemoving(null);
        } catch (e) {
          setRemoveError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      };

      // Nested rows: default new-session ＋ (+ 删除工作树 for detected
      // non-primary worktrees).
      if (!topLevel) {
        return react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
          children: [
            react_jsx_runtime.jsx("button", {
              type: "button",
              className: "gwt-rowPlus",
              "aria-label": "新建会话",
              title: "在该工作区新建会话",
              onClick: (event) => {
                event.stopPropagation();
                defaultCreate();
              },
              children: react_jsx_runtime.jsx(PlusGlyph, {}),
            }),
            worktreeInfo !== null && !worktreeInfo.primary && react_jsx_runtime.jsx("button", {
              type: "button",
              className: "gwt-rowRemove",
              "aria-label": "删除工作树",
              title: "删除工作树",
              onClick: (event) => void beginRemove(event),
              children: react_jsx_runtime.jsx(TrashGlyph, {}),
            }),
            deleteOpen && anchor !== null && removing !== null && react_jsx_runtime.jsxs("div", {
              className: "gwt-createPop",
              style: { left: anchor.left, top: anchor.top },
              onClick: stopPopoverEvent,
              onPointerDown: stopPopoverEvent,
              onMouseDown: stopPopoverEvent,
              children: [
                react_jsx_runtime.jsxs("div", {
                  className: "gwt-head",
                  children: [
                    react_jsx_runtime.jsx("span", { children: "删除工作树？" }),
                    react_jsx_runtime.jsx("span", { className: "gwt-popPath", children: cwd }),
                  ],
                }),
                worktreeInfo !== null && react_jsx_runtime.jsx("span", {
                  className: "gwt-popBranch",
                  children: `${worktreeInfo.branch ?? "(detached)"} @ ${worktreeInfo.head ?? "?"}`,
                }),
                removing.sessions.length > 0 && react_jsx_runtime.jsx("span", {
                  className: "gwt-boundList",
                  children: `绑定会话（${removing.sessions.length}）：${removing.sessions.map((s) => s.title).join("、")}`,
                }),
                removing.sessions.length === 0 && react_jsx_runtime.jsx("span", {
                  className: "gwt-note",
                  children: "无绑定会话；删除后文件夹从树中移除。",
                }),
                react_jsx_runtime.jsxs("label", {
                  className: "gwt-check",
                  children: [
                    react_jsx_runtime.jsx("input", {
                      type: "checkbox",
                      checked: removing.archive,
                      disabled: removing.sessions.length === 0,
                      onChange: (event) => setRemoving({ ...removing, archive: event.target.checked }),
                    }),
                    "一并归档这些会话（日志保留，侧边栏隐藏）",
                  ],
                }),
                removeError !== null && react_jsx_runtime.jsx("p", { className: "gwt-error", children: removeError }),
                react_jsx_runtime.jsxs("div", {
                  className: "gwt-confirmRow",
                  children: [
                    react_jsx_runtime.jsx("button", {
                      type: "button",
                      className: "gwt-btn",
                      disabled: busy,
                      onClick: () => setDeleteOpen(false),
                      children: "取消",
                    }),
                    react_jsx_runtime.jsx("button", {
                      type: "button",
                      className: "gwt-btn gwt-btnDanger",
                      disabled: busy,
                      onClick: () => void confirmRemove(),
                      children: busy ? "…" : "确认删除",
                    }),
                  ],
                }),
              ],
            }),
          ],
        });
      }

      // Top-level rows: repo folder ＋ opens the worktree create popover;
      // non-repo folders keep the default new-session behavior.
      const onTriggerClick = (event) => {
        event.stopPropagation();
        if (kind === "not-repo") {
          defaultCreate();
          return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        setAnchor({ left: rect.right + 8, top: rect.top });
        setOpen((value) => !value);
      };

      const title = kind === "not-repo" ? `在“${matched.label}”中新建会话` : "新增工作树";
      return react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
        children: [
          react_jsx_runtime.jsx("button", {
            type: "button",
            className: "gwt-rowPlus",
            "aria-label": title,
            title,
            onClick: onTriggerClick,
            children: react_jsx_runtime.jsx(PlusGlyph, {}),
          }),
          open && anchor !== null && react_jsx_runtime.jsxs("div", {
            className: "gwt-createPop",
            style: { left: anchor.left, top: anchor.top },
            onClick: stopPopoverEvent,
            onPointerDown: stopPopoverEvent,
            onMouseDown: stopPopoverEvent,
            children: [
              react_jsx_runtime.jsxs("div", {
                className: "gwt-head",
                children: [
                  react_jsx_runtime.jsx("span", { children: `新增工作树：${matched.label}` }),
                  react_jsx_runtime.jsx("span", { className: "gwt-popPath", children: cwd }),
                ],
              }),
              react_jsx_runtime.jsx("input", {
                className: "gwt-createInput",
                value: name,
                placeholder: "feature name → .dsh-wt/<name>（自动打开绑定会话）",
                onChange: (event) => setName(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === "Enter" && !busy && name.trim() !== "") void doCreate(true);
                  if (event.key === "Escape") setOpen(false);
                },
                autoFocus: true,
              }),
              error !== null && react_jsx_runtime.jsx("p", { className: "gwt-error", children: error }),
              react_jsx_runtime.jsxs("div", {
                className: "gwt-createRow",
                children: [
                  react_jsx_runtime.jsx("button", {
                    type: "button",
                    className: "gwt-btn",
                    disabled: busy || name.trim() === "",
                    onClick: () => void doCreate(false),
                    children: "仅创建工作树",
                  }),
                  react_jsx_runtime.jsx("button", {
                    type: "button",
                    className: "gwt-btn gwt-btnPrimary",
                    disabled: busy || name.trim() === "",
                    onClick: () => void doCreate(true),
                    children: busy ? "…" : "创建绑定会话",
                  }),
                ],
              }),
            ],
          }),
        ],
      });
    }

    // ── client plugin body ──────────────────────────────────────────────────
    const inject = ["sessions", "workspaces", "slots"];

    function apply(ctx) {
      const workspaces = ctx.get("workspaces");
      const sessions = ctx.get("sessions");
      /**
       * Register the worktree path as a workspace and open a new session
       * rooted there — the conversation is born bound to that worktree.
       * @returns {{ ok: boolean, sessionId?: string, message?: string }}
       */
      const openBoundSession = async (path) => {
        try {
          const workspace = await workspaces.create({ path });
          const sessionId = await workspaces.connectWorkspace(workspace.workspaceId);
          sessions.open(sessionId);
          return { ok: true, sessionId };
        } catch (e) {
          return { ok: false, message: e instanceof Error ? e.message : String(e) };
        }
      };
      /** Archive (hide) sessions; their logs stay intact. */
      const archiveSessions = async (ids) => {
        for (const id of ids) await workspaces.archiveSession(id);
      };
      /** The sync face: git listing + workspace runtime actions. */
      const sync = {
        list: (path) => listWorktrees(path),
        create: (input) => workspaces.create(input),
        rename: (id, title) => workspaces.rename(id, title),
        delete: (id) => workspaces.delete(id),
      };

      // Renderless auto-detect mount: keeps every project's worktrees
      // registered as nested workspace folders (the left tree's single
      // surface). Renders nothing in the footer.
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
        name: "sidebar.footer.action",
        id: "git-worktree-sync",
        inject: () => ({ sync }),
      }, WorktreeSync));

      // The workspace-tree create chain: a repo folder's ＋ becomes
      // "新增工作树" (create worktree + bound conversation in one click);
      // worktree subfolder rows keep the new-session ＋ and gain
      // 删除工作树; non-worktree rows keep the default ＋.
      ctx.slots.inject("sidebar.workspaces.create", () => ctx.slots.register({
        name: "sidebar.workspaces.create",
        registrant: "git-worktree",
        inject: () => ({ openBoundSession, archiveSessions, sync }),
        select: (owner) => {
          const g = owner.group;
          if (g.workspaceId === undefined) return null;
          return {
            workspaceId: g.workspaceId,
            cwd: g.cwd ?? "",
            label: g.label,
            topLevel: g.parentWorkspaceId === undefined,
          };
        },
      }, WorktreeCreateButton));
    }

    exports.apply = apply;
    exports.inject = inject;
    // Test-only surface for the standalone client tests (test/client-unit.js,
    // test/client-dom.js): the pure helpers + the sync engine. Not part of the
    // public API.
    exports._test = {
      sanitizeName,
      sessionsSame,
      api,
      runSync,
      worktreeStore,
      loadAuto,
      saveAuto,
      _reset() {
        worktreeStore.state = { byPath: new Map(), roots: new Map() };
        worktreeStore.version = 0;
        try {
          localStorage.removeItem(AUTO_KEY);
        } catch {
          /* ignore */
        }
      },
    };
    return module.exports;
  },
});
