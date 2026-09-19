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
 * 2. **Per-row affordances via DOM integration.** Current DSH's ui-workspace
 *    no longer declares the `sidebar.workspaces.create` chain (only the
 *    `sidebar.workspaces.directoryFlow` picker hole), so the controls are
 *    installed directly into the live workspace tree that the footer mount
 *    observes: a repo (primary worktree) folder row gains ＋ ("新增工作树",
 *    worktree + workspace + bound session in one click) while its stock
 *    new-session ＋ is hidden; a linked-worktree row keeps the stock ＋ and
 *    gains 删除工作树 whose anchored confirm lists the bound conversations,
 *    offers to archive them, removes the git worktree and unregisters its
 *    folder. Rows are matched to workspaces by label; duplicate labels open an
 *    explicit chooser (with each candidate's absolute path) instead of acting
 *    on a guessed repository. The integration restores every stock control on
 *    unmount.
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
      // Same-keyed workspace labels: the row control opens an explicit chooser
      // instead of guessing a repository.
      ".gwt-rowAmbiguous{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary, #888);cursor:pointer;padding:0}",
      ".gwt-rowAmbiguous:hover{background:var(--dsw-alias-fill-l3, #e9eaed);color:var(--dsw-alias-label-secondary, #555)}",
      ".gwt-chooseList{display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto}",
      ".gwt-chooseItem{display:flex;flex-direction:column;align-items:flex-start;gap:1px;text-align:left;width:100%}",
      ".gwt-choosePath{font-family:var(--dsw-font-mono, monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary, #888);word-break:break-all}",
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
     * Stop an event from leaving the popover container. The popover renders
     * from the footer mount, but its injected trigger button lives inside the
     * workspace-tree row and that row div carries `onClick={onToggle}` — so
     * without this guard a click on the popover's input, buttons, header or
     * path text could still be mistaken for a row interaction. Pointer-down
     * and mousedown are stopped too so a press inside the popover never feeds
     * the row's other pointer behaviors (e.g. the HTML5 row drag).
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
     * `WorktreeSync` republishes after every pass; the DOM row integration
     * reads the store to decide whether a row is a worktree (and thus gets the
     * 删除工作树 affordance) and to resolve each row's repository.
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

    // ── footer mount: worktree sync + DOM integration host ─────────────────
    /**
     * Mounted into `sidebar.footer.action` (rendered in both sidebar widths).
     * Keeps every project's worktrees registered as workspace folders (quiet
     * poll included) and hosts the per-row DOM integration + anchored
     * popovers. Receives `useWorkspaces`/`useSessions` from the slot root
     * hooks and `sync`/`openBoundSession`/`archiveSessions` from the
     * registration inject face. `debounceMs`/`intervalMs`/`doc` are props so
     * tests can shrink timings and inject their document.
     */
    const SYNC_DEBOUNCE_MS = 400;
    const SYNC_INTERVAL_MS = 20000;
    /** Neutral fallback for SSR/unit renders without the sessions root hook. */
    const emptySessions = (selector) => selector({ ids: [], byId: {}, current: undefined });

    function WorktreeSync({ useWorkspaces, useSessions, sync, openBoundSession, archiveSessions, debounceMs = SYNC_DEBOUNCE_MS, intervalMs = SYNC_INTERVAL_MS, doc }) {
      const items = useWorkspaces((state) => state.items);
      const phase = useWorkspaces((state) => state.phase);
      // Full conversation list (subagent children share their parent's cwd and
      // are not bindings of their own); `sessionsSame` keeps the selection
      // identity stable across session-store notifications.
      const readSessions = typeof useSessions === "function" ? useSessions : emptySessions;
      const allSessions = readSessions((snapshot) => snapshot.ids
        .map((id) => snapshot.byId[id])
        .filter((s) => s !== undefined && s.origin !== "subagent"),
      sessionsSame);
      const worktreeState = react.useSyncExternalStore(worktreeStore.subscribe, worktreeStore.getSnapshot, worktreeStore.getSnapshot);
      const [popover, setPopover] = react.useState(null);
      const targetDoc = doc ?? (typeof document !== "undefined" ? document : null);

      // Latest-value ref: the observer never has to re-subscribe when props or
      // workspace data change.
      const latest = react.useRef({ items, sync, openBoundSession, archiveSessions, allSessions, setPopover });
      react.useEffect(() => {
        latest.current.items = items;
        latest.current.sync = sync;
        latest.current.openBoundSession = openBoundSession;
        latest.current.archiveSessions = archiveSessions;
        latest.current.allSessions = allSessions;
        latest.current.setPopover = setPopover;
      });

      // Sync pass: keep every project's worktrees registered as workspace folders.
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

      // DOM integration: install once, rescan whenever the tree inputs move.
      const integration = react.useRef(null);
      react.useEffect(() => {
        if (targetDoc === null) return;
        const manager = createRowIntegration({
          doc: targetDoc,
          readItems: () => latest.current.items,
          readWorktreeState: () => worktreeStore.state,
          onAction: (action) => {
            if (action.kind === "ambiguous") {
              latest.current.setPopover({ kind: "choose", anchor: action.anchor, candidates: action.candidates });
              return;
            }
            const candidate = action.candidates[0];
            latest.current.setPopover({
              kind: action.kind,
              anchor: action.anchor,
              target: {
                workspaceId: candidate.workspace.workspaceId,
                cwd: candidate.workspace.path,
                label: candidate.workspace.title,
                info: candidate.info,
              },
            });
          },
        });
        integration.current = manager;
        manager.start();
        return () => {
          manager.stop();
          integration.current = null;
        };
      }, [targetDoc]);
      react.useEffect(() => {
        integration.current?.scan();
      }, [items, worktreeState, phase]);

      // Click-outside closes either popover.
      react.useEffect(() => {
        if (popover === null || targetDoc === null) return;
        const ElementCtor = targetDoc.defaultView?.Element ?? Element;
        const onPointerDown = (event) => {
          const elem = event.target;
          if (elem instanceof ElementCtor
            && (elem.closest(".gwt-createPop") !== null
              || elem.closest(".gwt-rowPlus") !== null
              || elem.closest(".gwt-rowRemove") !== null
              || elem.closest(".gwt-rowAmbiguous") !== null)) return;
          setPopover(null);
        };
        targetDoc.addEventListener("pointerdown", onPointerDown);
        return () => targetDoc.removeEventListener("pointerdown", onPointerDown);
      }, [popover, targetDoc]);

      if (popover === null) return null;
      if (popover.kind === "create") {
        return react_jsx_runtime.jsx(CreateWorktreePopover, {
          target: popover.target,
          anchor: popover.anchor,
          openBoundSession,
          onClose: () => setPopover(null),
        });
      }
      if (popover.kind === "remove") {
        // Retargeting the popover from one row to another must reset its
        // per-target state (bound sessions, archive choice, load status) so a
        // stale list can never be archived under the wrong path; the key
        // remounts the component when the target changes.
        return react_jsx_runtime.jsx(RemoveWorktreePopover, {
          target: popover.target,
          anchor: popover.anchor,
          allSessions,
          sync,
          archiveSessions,
          onClose: () => setPopover(null),
        }, popover.target.workspaceId ?? popover.target.cwd);
      }
      return react_jsx_runtime.jsx(WorkspaceChooser, {
        anchor: popover.anchor,
        candidates: popover.candidates,
        onPick: (candidate) => setPopover({
          kind: candidate.info.primary ? "create" : "remove",
          anchor: popover.anchor,
          target: {
            workspaceId: candidate.workspace.workspaceId,
            cwd: candidate.workspace.path,
            label: candidate.workspace.title,
            info: candidate.info,
          },
        }),
        onClose: () => setPopover(null),
      });
    }

    // ── workspace-tree row affordances (DOM integration) ────────────────────
    // Current DSH's ui-workspace browser no longer declares the
    // `sidebar.workspaces.create` chain, so the per-row controls are installed
    // straight into the live tree the footer mount (`sidebar.footer.action`,
    // still a list slot) observes. The plugin owns two affordances:
    //
    //   • a primary-worktree (repo) folder row gets ＋ ("新增工作树") and its
    //     stock new-session ＋ is hidden while the injection is live;
    //   • a linked-worktree row keeps the stock new-session ＋ and gains
    //     删除工作树.
    //
    // Rows are matched to workspaces by label. When several workspaces share a
    // label the control opens an explicit chooser (each candidate's absolute
    // path) instead of silently acting on a guessed repository. Every mutation
    // is recorded on the row so a rescan is a no-op once the row is consistent,
    // which keeps the MutationObserver from feeding back on itself.

    const ROW_SELECTOR = '[role="treeitem"][aria-expanded]';
    const TREE_SELECTOR = 'div[role="tree"]';
    const CONTROL_ATTR = 'data-gwt-control';
    const RESOLVED_ATTR = 'data-gwt-resolved';
    const HIDDEN_ATTR = 'data-gwt-stock-hidden';

    const PLUS_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>';
    const TRASH_SVG = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5h11"/><path d="M6 4.5V3.2A1.2 1.2 0 0 1 7.2 2h1.6A1.2 1.2 0 0 1 10 3.2v1.3"/><path d="M4 4.5l.6 8.2A1.2 1.2 0 0 0 5.8 14h4.4a1.2 1.2 0 0 0 1.2-1.3l.6-8.2"/><path d="M6.5 7.5v4M9.5 7.5v4"/></svg>';
    const CHOOSE_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5 3.5 6 6 8.5"/><path d="M3.5 6h6.2A2.8 2.8 0 0 1 12.5 8.8v0"/><path d="M10 12.5 12.5 10 10 7.5"/><path d="M12.5 10H6.3A2.8 2.8 0 0 1 3.5 7.2v0"/></svg>';

    /** The row's action cell: the direct span child that holds its buttons. */
    const rowActionsOf = (row) => {
      for (const child of row.children) {
        if (child.tagName === "SPAN" && child.querySelector("button") !== null) return child;
      }
      return null;
    };

    /** The row's label (`span.projectText > span.title`), or null when absent. */
    const rowTitleOf = (row) => {
      const title = row.querySelector("span > span");
      if (title === null) return null;
      const text = (title.textContent ?? "").trim();
      return text === "" ? null : text;
    };

    /** Trailing-separator-insensitive path key for workspace↔worktree joins. */
    const normalizePathKey = (path) => (typeof path === "string" ? path.replace(/[/\\]+$/, "") : path);

    /**
     * Resolve one project row to the workspaces it can address.
     * `candidates` keeps every workspace whose label equals the row's; `info`
     * is its git worktree fact (null when the path is not a detected worktree).
     * @returns `null` (leave the stock controls alone) or
     *   `{ kind: 'create'|'remove'|'ambiguous', candidates }`.
     */
    const resolveRow = (row, items, byPath) => {
      const title = rowTitleOf(row);
      if (title === null) return null;
      const matching = items.filter((workspace) => workspace.title === title);
      if (matching.length === 0) return null;
      const candidates = matching.map((workspace) => {
        const path = normalizePathKey(workspace.path);
        const info = byPath.get(path) ?? byPath.get(workspace.path) ?? null;
        return { workspace, info };
      });
      if (candidates.length > 1) {
        // Never guess between same-label workspaces. Only surface the chooser
        // when at least one candidate is a real worktree (otherwise the row has
        // no repo affordance at all).
        return candidates.every((candidate) => candidate.info === null)
          ? null
          : { kind: "ambiguous", candidates };
      }
      const only = candidates[0];
      if (only.info === null) return null;
      return { kind: only.info.primary ? "create" : "remove", candidates };
    };

    /** Remove every control the plugin owns on `row` and restore hidden stock buttons. */
    const cleanupRow = (row) => {
      for (const control of row.querySelectorAll("[" + CONTROL_ATTR + "]")) control.remove();
      for (const hidden of row.querySelectorAll("[" + HIDDEN_ATTR + "]")) {
        hidden.style.display = "";
        hidden.removeAttribute(HIDDEN_ATTR);
      }
      row.removeAttribute(RESOLVED_ATTR);
    };

    const rowSignature = (resolution) => resolution.kind + "|" + resolution.candidates
      .map((candidate) => candidate.workspace.workspaceId + ":" + (candidate.info === null ? "x" : candidate.info.primary ? "p" : "l"))
      .join(",");

    const makeControl = (doc, kind) => {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = kind === "remove" ? "gwt-rowRemove" : kind === "ambiguous" ? "gwt-rowAmbiguous" : "gwt-rowPlus";
      button.setAttribute(CONTROL_ATTR, kind);
      button.innerHTML = kind === "remove" ? TRASH_SVG : kind === "ambiguous" ? CHOOSE_SVG : PLUS_SVG;
      const label = kind === "remove" ? "删除工作树" : kind === "ambiguous" ? "选择工作区" : "新增工作树";
      button.setAttribute("aria-label", label);
      button.title = kind === "ambiguous" ? "存在同名工作区 — 点击选择" : label;
      return button;
    };

    /**
     * Install (or repair) the plugin's control(s) on one project row.
     * Idempotent: a consistent row performs no DOM write, so the observer that
     * watches these mutations settles instead of looping.
     * @returns true when the DOM changed.
     */
    const applyRow = (row, resolution, onAction) => {
      const actions = rowActionsOf(row);
      if (actions === null) { cleanupRow(row); return false; }
      // Count native descendant buttons, excluding any control this plugin
      // already appended to the same action cell: on a rescan after a previous
      // resolution the plugin's own button would otherwise be counted (and
      // later picked as "the last button"), so the stock new-session ＋ would
      // never be hidden. The core Menu primitive wraps its ellipsis anchor in
      // its own <span>, so a real workspace row's actions hold [span(menu
      // anchor), button(new session)] while the ungrouped pseudo-row holds only
      // the bare new-session button. The new-session ＋ is the LAST native
      // button in document order either way.
      const nativeButtons = actions.querySelectorAll("button:not([" + CONTROL_ATTR + "])");
      if (nativeButtons.length < 2) { cleanupRow(row); return false; }
      if (resolution === null) { cleanupRow(row); return false; }
      const signature = rowSignature(resolution);
      const controls = row.querySelectorAll("[" + CONTROL_ATTR + "]");
      if (row.getAttribute(RESOLVED_ATTR) === signature
        && controls.length === 1
        && controls[0].getAttribute(CONTROL_ATTR) === resolution.kind
        && (resolution.kind !== "create" || actions.querySelector("[" + HIDDEN_ATTR + "]") !== null)) {
        return false;
      }
      cleanupRow(row);
      const button = makeControl(row.ownerDocument, resolution.kind);
      const stop = (event) => event.stopPropagation();
      button.addEventListener("pointerdown", stop);
      button.addEventListener("mousedown", stop);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const rect = button.getBoundingClientRect();
        onAction({
          kind: resolution.kind,
          candidates: resolution.candidates,
          anchor: { left: rect.right + 8, top: rect.top },
        });
      });
      actions.appendChild(button);
      if (resolution.kind === "create") {
        const plus = nativeButtons[nativeButtons.length - 1];
        plus.style.display = "none";
        plus.setAttribute(HIDDEN_ATTR, "1");
      }
      row.setAttribute(RESOLVED_ATTR, signature);
      return true;
    };

    /**
     * Live DOM integration installed by the footer mount. Observes the
     * workspace tree, keeps the plugin's controls in sync with the workspace
     * list + git facts, and reports user actions through `onAction`.
     * `start()` performs the first scan; `stop()` disconnects the observer and
     * restores every stock control it hid.
     */
    const createRowIntegration = ({ doc, readItems, readWorktreeState, onAction }) => {
      let observer = null;
      let scheduled = false;
      let stopped = false;
      const scan = () => {
        if (stopped) return;
        const items = readItems() ?? [];
        const byPath = readWorktreeState()?.byPath ?? new Map();
        for (const tree of doc.querySelectorAll(TREE_SELECTOR)) {
          for (const row of tree.querySelectorAll(ROW_SELECTOR)) {
            applyRow(row, resolveRow(row, items, byPath), onAction);
          }
        }
      };
      const schedule = () => {
        if (stopped || scheduled) return;
        scheduled = true;
        Promise.resolve().then(() => {
          scheduled = false;
          scan();
        });
      };
      /**
       * Only workspace-tree mutations matter. Filtering here keeps unrelated
       * churn (conversation streaming, hover cards) from scheduling repeated
       * scans, while still catching a tree being (re)created.
       */
      const relevant = (mutation) => {
        const target = mutation.target;
        const element = target.nodeType === 1 ? target : target.parentElement;
        if (element !== null && element !== undefined
          && (element.matches(TREE_SELECTOR) || element.closest(TREE_SELECTOR) !== null)) return true;
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches(TREE_SELECTOR) || node.closest(TREE_SELECTOR) !== null
            || node.querySelector(TREE_SELECTOR) !== null) return true;
        }
        return false;
      };
      return {
        scan,
        start() {
          scan();
          if (doc.body === null) return;
          observer = new doc.defaultView.MutationObserver((mutations) => {
            for (const mutation of mutations) if (relevant(mutation)) { schedule(); return; }
          });
          observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
        },
        stop() {
          stopped = true;
          if (observer !== null) observer.disconnect();
          observer = null;
          for (const row of doc.querySelectorAll("[" + RESOLVED_ATTR + "]")) cleanupRow(row);
        },
      };
    };

    // ── anchored popovers ───────────────────────────────────────────────────
    /** Shared fixed-position popover chrome; row events never leak through it. */
    const popoverProps = (anchor) => ({
      className: "gwt-createPop",
      style: { left: anchor.left, top: anchor.top },
      onClick: stopPopoverEvent,
      onPointerDown: stopPopoverEvent,
      onMouseDown: stopPopoverEvent,
    });

    /**
     * "新增工作树": create the worktree (optionally opening the bound session
     * rooted at it) and close. Replaces the removed slot's create chain.
     */
    function CreateWorktreePopover({ target, anchor, openBoundSession, onClose }) {
      const [name, setName] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState(null);

      const doCreate = async (withSession) => {
        const base = sanitizeName(name);
        if (base === "" || busy) return;
        setBusy(true);
        setError(null);
        try {
          const result = await post("add", { repo: target.cwd, name: base, unique: true });
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
          onClose();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      };

      return react_jsx_runtime.jsxs("div", {
        ...popoverProps(anchor),
        children: [
          react_jsx_runtime.jsxs("div", {
            className: "gwt-head",
            children: [
              react_jsx_runtime.jsx("span", { children: "新增工作树：" + target.label }),
              react_jsx_runtime.jsx("span", { className: "gwt-popPath", children: target.cwd }),
            ],
          }),
          react_jsx_runtime.jsx("input", {
            className: "gwt-createInput",
            value: name,
            placeholder: "feature name → .dsh-wt/<name>（自动打开绑定会话）",
            onChange: (event) => setName(event.target.value),
            onKeyDown: (event) => {
              if (event.key === "Enter" && !busy && name.trim() !== "") void doCreate(true);
              if (event.key === "Escape") onClose();
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
      });
    }

    /**
     * "删除工作树？": lists the conversations bound to `target.cwd`, offers to
     * archive them, removes the git worktree and unregisters its workspace.
     */
    function RemoveWorktreePopover({ target, anchor, allSessions, sync, archiveSessions, onClose }) {
      const [removing, setRemoving] = react.useState({ sessions: [], archive: false });
      const [bindingReady, setBindingReady] = react.useState(false);
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState(null);

      react.useEffect(() => {
        let cancelled = false;
        // A retarget (or a session-store change) invalidates the previous
        // bound-session list: clear it and keep the confirm action disabled
        // until the binding information for THIS target loads successfully.
        setRemoving({ sessions: [], archive: false });
        setBindingReady(false);
        setError(null);
        const resolveBound = async () => {
          try {
            const cwds = [...new Set(allSessions.map((s) => s.cwd).filter(Boolean))];
            const data = await resolveBindings(cwds);
            const bound = [];
            for (const row of data.bindings) {
              if (row.worktree === null || row.worktree.path !== target.cwd) continue;
              const session = allSessions.find((s) => s.cwd === row.path);
              if (session === undefined) continue;
              bound.push({ id: session.id, title: session.displayTitle, blank: session.blank });
            }
            bound.sort((a, b) => (a.blank ? 1 : 0) - (b.blank ? 1 : 0) || a.title.localeCompare(b.title));
            if (!cancelled) {
              setRemoving({ sessions: bound, archive: bound.length > 0 });
              setBindingReady(true);
            }
          } catch (e) {
            if (!cancelled) setError(e instanceof Error ? e.message : String(e));
          }
        };
        void resolveBound();
        return () => { cancelled = true; };
      }, [target.cwd, allSessions]);

      const confirmRemove = async () => {
        if (busy || !bindingReady) return;
        if (target.info === null) {
          setError("该文件夹不是已检测到的工作树");
          return;
        }
        setBusy(true);
        setError(null);
        try {
          if (removing.archive && removing.sessions.length > 0) {
            await archiveSessions(removing.sessions.map((s) => s.id));
          }
          await post("remove", { repo: target.info.repoRoot, path: target.cwd });
          if (target.workspaceId !== undefined) {
            try {
              await sync.delete(target.workspaceId);
            } catch {
              /* registration already gone — fine */
            }
          }
          onClose();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      };

      return react_jsx_runtime.jsxs("div", {
        ...popoverProps(anchor),
        children: [
          react_jsx_runtime.jsxs("div", {
            className: "gwt-head",
            children: [
              react_jsx_runtime.jsx("span", { children: "删除工作树？" }),
              react_jsx_runtime.jsx("span", { className: "gwt-popPath", children: target.cwd }),
            ],
          }),
          target.info !== null && react_jsx_runtime.jsx("span", {
            className: "gwt-popBranch",
            children: (target.info.branch ?? "(detached)") + " @ " + (target.info.head ?? "?"),
          }),
          removing.sessions.length > 0 && react_jsx_runtime.jsx("span", {
            className: "gwt-boundList",
            children: "绑定会话（" + removing.sessions.length + "）：" + removing.sessions.map((s) => s.title).join("、"),
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
                disabled: !bindingReady || removing.sessions.length === 0,
                onChange: (event) => setRemoving({ ...removing, archive: event.target.checked }),
              }),
              "一并归档这些会话（日志保留，侧边栏隐藏）",
            ],
          }),
          error !== null && react_jsx_runtime.jsx("p", { className: "gwt-error", children: error }),
          react_jsx_runtime.jsxs("div", {
            className: "gwt-confirmRow",
            children: [
              react_jsx_runtime.jsx("button", {
                type: "button",
                className: "gwt-btn",
                disabled: busy,
                onClick: onClose,
                children: "取消",
              }),
              react_jsx_runtime.jsx("button", {
                type: "button",
                className: "gwt-btn gwt-btnDanger",
                disabled: busy || !bindingReady,
                onClick: () => void confirmRemove(),
                children: busy ? "…" : "确认删除",
              }),
            ],
          }),
        ],
      });
    }

    /** Explicit repository picker for same-label rows (never guess silently). */
    function WorkspaceChooser({ anchor, candidates, onPick, onClose }) {
      return react_jsx_runtime.jsxs("div", {
        ...popoverProps(anchor),
        children: [
          react_jsx_runtime.jsxs("div", {
            className: "gwt-head",
            children: [
              react_jsx_runtime.jsx("span", { children: "选择工作区" }),
              react_jsx_runtime.jsx("span", { className: "gwt-note", children: "存在同名工作区 — 请选择要操作的项目" }),
            ],
          }),
          react_jsx_runtime.jsx("div", {
            className: "gwt-chooseList",
            children: candidates.map((candidate, index) => react_jsx_runtime.jsxs("button", {
              type: "button",
              className: "gwt-btn gwt-chooseItem",
              disabled: candidate.info === null,
              onClick: () => { if (candidate.info !== null) onPick(candidate); },
              children: [
                react_jsx_runtime.jsx("span", {
                  children: candidate.info === null ? candidate.workspace.title + "（非工作树）" : candidate.workspace.title,
                }),
                react_jsx_runtime.jsx("span", { className: "gwt-choosePath", children: candidate.workspace.path }),
              ],
            }, candidate.workspace.workspaceId + ":" + index)),
          }),
          react_jsx_runtime.jsxs("div", {
            className: "gwt-confirmRow",
            children: [
              react_jsx_runtime.jsx("button", {
                type: "button",
                className: "gwt-btn",
                onClick: onClose,
                children: "取消",
              }),
            ],
          }),
        ],
      });
    }

    // ── client plugin body ──────────────────────────────────────────────────
    const inject = ["sessions", "workspaces", "uiWorkspace", "slots"];

    function apply(ctx) {
      const workspaces = ctx.get("workspaces");
      const uiWorkspace = ctx.get("uiWorkspace");
      /**
       * Register the worktree path as a workspace and open a new session
       * rooted there — the conversation is born bound to that worktree. The
       * UI workspace service owns the connect/open flow in current DSH
       * (`workspaces` only exposes the bare snapshot + commands).
       * @returns {{ ok: boolean, sessionId?: string, message?: string }}
       */
      const openBoundSession = async (path) => {
        try {
          const workspace = await workspaces.create({ path });
          const sessionId = await uiWorkspace.connectWorkspace(workspace.workspaceId);
          uiWorkspace.openSession(sessionId);
          return { ok: true, sessionId };
        } catch (e) {
          return { ok: false, message: e instanceof Error ? e.message : String(e) };
        }
      };
      /** Archive (hide) sessions; their logs stay intact. */
      const archiveSessions = async (ids) => {
        for (const id of ids) await uiWorkspace.archiveSession(id);
      };
      /** The sync face: git listing + workspace runtime actions. */
      const sync = {
        list: (path) => listWorktrees(path),
        create: (input) => workspaces.create(input),
        rename: (id, title) => workspaces.rename(id, title),
        delete: (id) => workspaces.delete(id),
      };

      // The footer mount keeps every project's worktrees registered as
      // workspace folders and hosts the DOM integration that installs the
      // per-row create/remove controls into the live tree. Current DSH's
      // ui-workspace declares no `sidebar.workspaces.create` chain, so there
      // is deliberately no chain registration here.
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
        name: "sidebar.footer.action",
        id: "git-worktree-sync",
        inject: () => ({ sync, openBoundSession, archiveSessions }),
      }, WorktreeSync));
    }

    exports.apply = apply;
    exports.inject = inject;
    // Test-only surface for the standalone client tests (test/client-unit.js,
    // test/client-dom.js, test/client-current.js): the pure helpers, the sync
    // engine, and the row-integration primitives. Not part of the public API.
    exports._test = {
      sanitizeName,
      sessionsSame,
      api,
      runSync,
      worktreeStore,
      loadAuto,
      saveAuto,
      rowActionsOf,
      rowTitleOf,
      resolveRow,
      createRowIntegration,
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
