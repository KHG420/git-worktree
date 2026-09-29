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
 *    workspace folders. Current DSH's `ui-workspace` renders each registered
 *    workspace as a FLAT project row (no path nesting), so the main worktree
 *    IS the project folder (its title gains a `（主工作树）` marker) and every
 *    linked worktree is its own row; sessions group by exact cwd on that row.
 *    The plugin marks uniquely resolved linked rows with their main repository
 *    and visually indents them in the flat list. This is not a nested tree:
 *    the host still owns row order and expansion.
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
 *    folder. Removal happens git-first: the worktree is removed before any
 *    archive, and a later archive/unregister failure keeps the popover open so
 *    only the unfinished cleanup can be retried (never a second git removal).
 *    Rows are matched to workspaces by label; duplicate labels open an
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
      ".gwt-createPop{position:fixed;z-index:1001;width:300px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2, #e5e7eb);background:var(--dsw-specific-menu, #fff);box-shadow:var(--dsw-shadow-lv3, 0 8px 24px rgba(0,0,0,.12));border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary, #111);max-height:calc(100vh - 16px);overflow-y:auto;overscroll-behavior:contain;outline:none}",
      ".gwt-createPop button:focus-visible{outline:2px solid var(--dsw-alias-border-accent, #4f8cff);outline-offset:1px}",
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
      ".gwt-field{display:flex;flex-direction:column;gap:4px}",
      ".gwt-fieldLabel{color:var(--dsw-alias-label-secondary, #555);font-size:12px;line-height:18px;font-weight:500}",
      ".gwt-fieldHint{color:var(--dsw-alias-label-tertiary, #888);font-size:11px;line-height:16px}",
      ".gwt-fieldError{color:var(--dsw-alias-danger-strong, #d92d20);font-size:12px;line-height:18px;margin:0}",
      ".gwt-preview{font-family:var(--dsw-font-mono, monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary, #555);word-break:break-all}",
      ".gwt-details{color:var(--dsw-alias-label-tertiary, #888);font-size:11px;line-height:16px}",
      ".gwt-details summary{cursor:pointer}",
      ".gwt-rawError{display:block;margin-top:4px;font-family:var(--dsw-font-mono, monospace);color:var(--dsw-alias-label-secondary, #555);word-break:break-all;white-space:pre-wrap}",
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
     * are legal git refs and are preserved. This is the raw draft BEFORE the
     * degenerate fallback, so the UI can tell an invalid input (no legal
     * content) from a legal one; may be empty.
     */
    const sanitizeDraft = (raw) => {
      const s = String(raw).trim()
        .replace(/[\u0000-\u001f\u007f ~^:?*[\]\\/@]+/g, "-")
        .replace(/\.\./g, "-")
        .replace(/-+/g, "-")
        .replace(/^[-.]+|[-.]+$/g, "")
        .replace(/\.lock$/i, "");
      // Slice by code points, not UTF-16 units: an 80-unit cut can split a
      // surrogate pair ('a' + 40 emoji is 81 units -> lone surrogate).
      const cut = Array.from(s).slice(0, 80).join("");
      // The slice can re-expose a trailing dot (a 79-char prefix ending in
      // '.'), which git forbids — strip it again.
      return cut.replace(/[-.]+$/g, "");
    };

    /**
     * The git-safe name the backend receives: `sanitizeDraft` with the
     * degenerate results (empty, '.', '..', the reserved 'HEAD') mapped to the
     * neutral 'wt'. The final result is guaranteed to pass
     * `git check-ref-format refs/heads/<name>`.
     */
    const sanitizeName = (raw) => {
      const out = sanitizeDraft(raw);
      return out === "" || out === "." || out === ".." || out === "HEAD" ? "wt" : out;
    };

    /**
     * UI verdict for the create input: `valid` gates the create actions and
     * `name` is the sanitized value to POST (empty when invalid). `changed`
     * is true when sanitizing actually altered the trimmed input, so the
     * popover can preview the transformation before the user commits.
     */
    const namePlan = (raw) => {
      const draft = sanitizeDraft(raw);
      const valid = draft !== "" && draft !== "." && draft !== ".." && draft !== "HEAD";
      const trimmed = String(raw).trim();
      return { valid, name: valid ? draft : "", preview: draft, changed: valid && draft !== trimmed, raw: trimmed };
    };

    /** First 8 chars of a commit id for display; short/null values pass through. */
    const shortSha = (sha) => (typeof sha === "string" && sha.length > 8 ? sha.slice(0, 8) : sha);

    /** Gap kept between a clamped popover and the viewport edge. */
    const POPOVER_MARGIN = 8;

    /**
     * Keep a fixed-position popover inside the desktop viewport. The anchor is
     * the row control's rect (right edge, top); a popover near the right or
     * bottom edge is pulled back so its actions stay reachable, and the
     * stylesheet bounds its height with scrolling for long content.
     */
    const clampPopover = (elem, anchor) => {
      if (elem === null || elem === undefined) return;
      const view = elem.ownerDocument?.defaultView;
      if (view === null || view === undefined) return;
      const vw = Number.isFinite(view.innerWidth) && view.innerWidth > 0 ? view.innerWidth : 0;
      const vh = Number.isFinite(view.innerHeight) && view.innerHeight > 0 ? view.innerHeight : 0;
      const rect = typeof elem.getBoundingClientRect === "function" ? elem.getBoundingClientRect() : { width: 0, height: 0 };
      const width = rect.width || 0;
      const height = rect.height || 0;
      const left = vw > 0 ? Math.min(Math.max(anchor.left, POPOVER_MARGIN), Math.max(POPOVER_MARGIN, vw - width - POPOVER_MARGIN)) : anchor.left;
      const top = vh > 0 ? Math.min(Math.max(anchor.top, POPOVER_MARGIN), Math.max(POPOVER_MARGIN, vh - height - POPOVER_MARGIN)) : anchor.top;
      elem.style.left = left + "px";
      elem.style.top = top + "px";
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

    /**
     * macOS canonical aliasing is resolved by the HOST, never guessed in the
     * browser: the panel sends every raw cwd (target included) through the
     * `bindings` route, which realpath-resolves each one and returns the
     * registered `worktree.path`. Two raw cwds alias exactly when those
     * host-resolved paths match, so the client compares them byte-for-byte and
     * never strips a path prefix itself (stripping `/private` would conflate
     * the distinct `/private/repo/...` and `/repo/...` paths).
     */

    /**
     * Does this binding row describe the worktree whose host-resolved root is
     * `canonicalTarget`? `canonicalTarget` must already be a host-resolved
     * `worktree.path` (see `boundSessions`); the comparison is exact.
     */
    const bindingMatchesTarget = (row, canonicalTarget) => {
      const wt = normalizePathKey(row?.worktree?.path);
      const target = normalizePathKey(canonicalTarget);
      if (typeof wt !== "string" || typeof target !== "string") return false;
      return wt === target;
    };

    /**
     * Every session bound to the worktree at `targetCwd`, given the route's
     * per-cwd binding rows. Unlike a `find` over the session list, this keeps
     * ALL sessions sharing a cwd, follows nested session cwds to their longest
     * registered worktree (the host resolves that), and matches canonical
     * aliases by the host's exact `worktree.path` rather than any browser-side
     * prefix heuristic. The target's canonical root comes from its own row
     * (identified by exact raw `path`), which is why the caller must include
     * `targetCwd` in the bindings request; without that row the target cannot
     * be resolved and no session is claimed. `running` is preserved so the
     * caller can refuse deletion while a native agent — a child subagent
     * included — is still writing.
     */
    const boundSessions = (targetCwd, allSessions, bindings) => {
      const target = normalizePathKey(targetCwd);
      const targetRow = bindings.find((row) => row !== null && row !== undefined
        && normalizePathKey(row.path) === target
        && row.worktree !== null && row.worktree !== undefined);
      const canonicalTarget = targetRow === undefined ? null : normalizePathKey(targetRow.worktree.path);
      if (canonicalTarget === null) return [];
      const byCwd = new Map();
      for (const session of allSessions) {
        if (session === null || session === undefined || typeof session.cwd !== "string" || session.cwd === "") continue;
        const list = byCwd.get(session.cwd);
        if (list === undefined) byCwd.set(session.cwd, [session]);
        else list.push(session);
      }
      const out = [];
      const seen = new Set();
      for (const row of bindings) {
        if (row === null || row === undefined || row.worktree === null || row.worktree === undefined) continue;
        if (!bindingMatchesTarget(row, canonicalTarget)) continue;
        for (const session of byCwd.get(row.path) ?? []) {
          if (seen.has(session.id)) continue;
          seen.add(session.id);
          out.push({
            id: session.id,
            title: session.displayTitle,
            blank: session.blank === true,
            running: session.running === true,
          });
        }
      }
      out.sort((a, b) => (a.blank ? 1 : 0) - (b.blank ? 1 : 0) || String(a.title ?? "").localeCompare(String(b.title ?? "")));
      return out;
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
     * ensure every worktree path has a workspace (each becomes its own flat
     * project row), unregister auto-created registrations whose
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
      // Full conversation list INCLUDING native subagent children: a running
      // child shares its parent's cwd and writes in the same worktree, so the
      // delete confirmation must see it and count it as an active occupant.
      // `sessionsSame` keeps the selection identity stable across session-store
      // notifications.
      const readSessions = typeof useSessions === "function" ? useSessions : emptySessions;
      const allSessions = readSessions((snapshot) => snapshot.ids
        .map((id) => snapshot.byId[id])
        .filter((s) => s !== undefined),
      sessionsSame);
      const worktreeState = react.useSyncExternalStore(worktreeStore.subscribe, worktreeStore.getSnapshot, worktreeStore.getSnapshot);
      const [popover, setPopover] = react.useState(null);
      const targetDoc = doc ?? (typeof document !== "undefined" ? document : null);
      // Set by a busy popover: while an async create/delete is in flight the
      // popover must not be dismissed (and lose its staged state) by an
      // outside click or replaced by another row action.
      const dismissGuard = react.useRef(false);

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
            if (dismissGuard.current) return;
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
          if (dismissGuard.current) return;
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
          guard: dismissGuard,
          onClose: () => setPopover(null),
        }, popover.target.workspaceId ?? popover.target.cwd);
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
          guard: dismissGuard,
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
          anchor: { left: rect.right + 8, top: rect.top, trigger: button },
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
            const resolution = resolveRow(row, items, byPath);
            applyRow(row, resolution, onAction);
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
    /**
     * Shared fixed-position popover chrome; row events never leak through it.
     * `label` names the dialog for assistive tech; `onDismiss` (when given)
     * handles Escape while idle — the caller decides whether busy blocks it.
     */
    const popoverProps = (anchor, label, onDismiss) => {
      const props = {
        className: "gwt-createPop",
        role: "dialog",
        "aria-label": label,
        tabIndex: -1,
        style: { left: anchor.left, top: anchor.top },
        onClick: stopPopoverEvent,
        onPointerDown: stopPopoverEvent,
        onMouseDown: stopPopoverEvent,
      };
      if (typeof onDismiss === "function") {
        props.onKeyDown = (event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onDismiss();
          }
        };
      }
      return props;
    };

    /**
     * Popover plumbing shared by all three surfaces: clamp the fixed position
     * into the viewport on mount/resize/content growth, move focus in on open,
     * and restore it to the row control on unmount.
     */
    const usePopoverRoot = (anchor) => {
      const ref = react.useRef(null);
      react.useLayoutEffect(() => {
        const elem = ref.current;
        if (elem === null) return;
        const reposition = () => clampPopover(elem, anchor);
        reposition();
        const view = elem.ownerDocument?.defaultView;
        if (view === null || view === undefined) return;
        view.addEventListener("resize", reposition);
        let observer = null;
        if (typeof view.ResizeObserver === "function") {
          observer = new view.ResizeObserver(() => reposition());
          observer.observe(elem);
        }
        return () => {
          view.removeEventListener("resize", reposition);
          observer?.disconnect();
        };
      }, [anchor.left, anchor.top]);
      react.useEffect(() => {
        const elem = ref.current;
        if (elem === null) return;
        const current = elem.ownerDocument?.activeElement;
        if (current === null || current === undefined || !elem.contains(current)) {
          try { elem.focus({ preventScroll: true }); } catch { /* jsdom/older engines */ }
        }
      }, []);
      react.useEffect(() => {
        const trigger = anchor.trigger;
        return () => {
          if (trigger !== null && trigger !== undefined && trigger.isConnected === true) {
            try { trigger.focus(); } catch { /* the row was replaced by reconciliation */ }
          }
        };
      }, [anchor]);
      return ref;
    };

    /**
     * "新增工作树": create the worktree and, when asked, open its bound session.
     * The git creation runs at most once per popover (a synchronous ref guards
     * double-clicks AND an open-session retry); a created-but-unopened result
     * stays visible with its real path/branch so it is usable before the
     * sidebar poll picks the workspace up.
     */
    function CreateWorktreePopover({ target, anchor, openBoundSession, onClose, guard }) {
      const [name, setName] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const [phase, setPhase] = react.useState(null); // 'creating' | 'opening'
      const [busyAction, setBusyAction] = react.useState(null); // 'worktree' | 'session'
      const [error, setError] = react.useState(null);
      const [created, setCreated] = react.useState(null);
      // Synchronous guards: React state is not updated between two clicks in
      // the same tick, so a ref must reject the duplicate create and remember
      // the git result a retry must not re-POST.
      const inFlight = react.useRef(false);
      const createdRef = react.useRef(null);
      // The host's click-outside handler consults this ref: a busy create must
      // not be dismissed mid-flight (which would lose the created result).
      react.useEffect(() => {
        guard.current = busy;
        return () => { guard.current = false; };
      }, [busy, guard]);
      const plan = namePlan(name);
      const invalid = name.trim() !== "" && !plan.valid;

      const runCreate = async (withSession) => {
        if (inFlight.current || !plan.valid) return;
        inFlight.current = true;
        setBusy(true);
        setError(null);
        setBusyAction(withSession ? "session" : "worktree");
        try {
          let result = createdRef.current;
          if (result === null) {
            setPhase("creating");
            const data = await post("add", { repo: target.cwd, name: plan.name, unique: true });
            const path = data.absolutePath ?? data.path ?? "";
            result = { path, branch: data.branch ?? plan.name };
            createdRef.current = result;
            setCreated(result);
          }
          if (!withSession) return; // keep the success panel open for 打开/完成
          setPhase("opening");
          const opened = await openBoundSession(result.path);
          if (opened !== null && opened !== undefined && opened.ok) {
            onClose();
            return;
          }
          setError(opened?.message ?? "工作树已创建，但打开绑定会话失败，可点击“打开绑定会话”重试。");
        } catch (e) {
          // A failure before the git result exists is a create error; after it,
          // the worktree is already there and only the session step failed.
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          inFlight.current = false;
          setBusy(false);
          setPhase(null);
          setBusyAction(null);
        }
      };

      const rootRef = usePopoverRoot(anchor);
      const dismiss = () => { if (!busy) onClose(); };
      const shared = { ref: rootRef, ...popoverProps(anchor, "新增工作树", dismiss) };
      const head = react_jsx_runtime.jsxs("div", {
        className: "gwt-head",
        children: [
          react_jsx_runtime.jsx("span", { children: "新增工作树：" + target.label }),
          react_jsx_runtime.jsx("span", { className: "gwt-popPath", children: target.cwd }),
        ],
      });

      if (created !== null) {
        return react_jsx_runtime.jsxs("div", {
          ...shared,
          children: [
            head,
            react_jsx_runtime.jsxs("div", {
              className: "gwt-created",
              children: [
                react_jsx_runtime.jsx("span", { className: "gwt-createdTitle", children: "工作树已创建" }),
                react_jsx_runtime.jsx("span", { className: "gwt-createdPath", children: created.path }),
                created.branch !== null && created.branch !== undefined && created.branch !== ""
                  && react_jsx_runtime.jsx("span", { className: "gwt-popBranch", children: "分支：" + created.branch }),
                error !== null && react_jsx_runtime.jsx("p", { className: "gwt-error", children: error }),
              ],
            }),
            react_jsx_runtime.jsxs("div", {
              className: "gwt-createRow",
              children: [
                react_jsx_runtime.jsx("button", {
                  type: "button",
                  className: "gwt-btn",
                  disabled: busy,
                  onClick: onClose,
                  children: "完成",
                }),
                react_jsx_runtime.jsx("button", {
                  type: "button",
                  className: "gwt-btn gwt-btnPrimary",
                  disabled: busy,
                  onClick: () => void runCreate(true),
                  children: busy && busyAction === "session" && phase === "opening" ? "正在打开会话…" : "打开绑定会话",
                }),
              ],
            }),
          ],
        });
      }

      const busyCopy = (action) => {
        if (!busy || busyAction !== action) return null;
        return phase === "creating" ? "创建中…" : "正在打开会话…";
      };

      return react_jsx_runtime.jsxs("div", {
        ...shared,
        children: [
          head,
          react_jsx_runtime.jsxs("label", {
            className: "gwt-field",
            children: [
              react_jsx_runtime.jsx("span", { className: "gwt-fieldLabel", children: "工作树名称" }),
              react_jsx_runtime.jsx("input", {
                className: "gwt-createInput",
                value: name,
                placeholder: "例如：login-page",
                disabled: busy,
                "aria-invalid": invalid ? true : undefined,
                "aria-describedby": "gwt-create-hint",
                onChange: (event) => setName(event.target.value),
                onKeyDown: (event) => {
                  if (event.key !== "Enter") return;
                  const composing = event.nativeEvent?.isComposing === true || event.isComposing === true;
                  if (!composing && !busy && plan.valid) void runCreate(true);
                },
                autoFocus: true,
              }),
            ],
          }),
          react_jsx_runtime.jsx("span", {
            className: "gwt-fieldHint",
            id: "gwt-create-hint",
            children: "例如：login-page；将创建 .dsh-wt/<名称> 与同名分支。",
          }),
          plan.valid && plan.changed && react_jsx_runtime.jsx("span", {
            className: "gwt-preview",
            children: "将创建 " + target.cwd + "/.dsh-wt/" + plan.name + "（分支 " + plan.name + "）",
          }),
          invalid && react_jsx_runtime.jsx("p", {
            className: "gwt-fieldError",
            children: "名称无效：不能只包含空格、-、.、/ 等符号；请使用字母、数字或中文。",
          }),
          error !== null && react_jsx_runtime.jsx("p", { className: "gwt-error", children: error }),
          react_jsx_runtime.jsxs("div", {
            className: "gwt-createRow",
            children: [
              react_jsx_runtime.jsx("button", {
                type: "button",
                className: "gwt-btn",
                disabled: busy,
                onClick: dismiss,
                children: "取消",
              }),
              react_jsx_runtime.jsx("button", {
                type: "button",
                className: "gwt-btn",
                disabled: busy || !plan.valid,
                onClick: () => void runCreate(false),
                children: busyCopy("worktree") ?? "仅创建工作树",
              }),
              react_jsx_runtime.jsx("button", {
                type: "button",
                className: "gwt-btn gwt-btnPrimary",
                disabled: busy || !plan.valid,
                onClick: () => void runCreate(true),
                children: busyCopy("session") ?? "创建绑定会话",
              }),
            ],
          }),
        ],
      });
    }

    /**
     * "删除工作树？": lists every conversation bound to `target.cwd` (native
     * subagent children included), offers to archive them, then removes the git
     * worktree and unregisters its workspace. Removal is git-first and staged:
     * a failure after the git step retries only the unfinished cleanup. While
     * any listed session is `running`, deletion is disabled with an explicit
     * explanation; idle peers are listed but never called active writers.
     */
    function RemoveWorktreePopover({ target, anchor, allSessions, sync, archiveSessions, onClose, guard }) {
      const [removing, setRemoving] = react.useState({ sessions: [], archive: false });
      const [bindingReady, setBindingReady] = react.useState(false);
      const [started, setStarted] = react.useState(false);
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState(null);               // binding resolution
      const [cleanupError, setCleanupError] = react.useState(null); // git-first cleanup { phase, message }
      const [reload, setReload] = react.useState(0);
      // Staged cleanup, stable across retries: which steps are DONE, the pending
      // session ids and the archive choice. `frozen` flips only AFTER git
      // confirms the worktree is gone: the ids must then survive the
      // post-removal binding re-resolution (the worktree no longer exists, so a
      // fresh resolve would otherwise erase the list a retry still needs). A
      // failed git removal leaves the plan unfrozen so the roster re-resolves.
      // `inFlight` is the synchronous re-entry guard (React `busy` state is not).
      const cleanup = react.useRef({ frozen: false, inFlight: false, gitRemoved: false, archived: false, unregistered: false, archive: false, sessions: [] });
      const rootRef = usePopoverRoot(anchor);
      const dismiss = () => { if (!busy) onClose(); };
      // The host's click-outside handler consults this ref: a busy delete must
      // not be dismissed (and lose its staged progress) by an outside click.
      react.useEffect(() => {
        guard.current = busy;
        return () => { guard.current = false; };
      }, [busy, guard]);

      react.useEffect(() => {
        // Once the git removal has actually succeeded the roster is frozen:
        // session-store churn and the disappearance of the worktree must not
        // revoke the confirmation or wipe the pending list a retry still needs.
        if (cleanup.current.frozen) return;
        let cancelled = false;
        // A retarget (or a session-store change) invalidates the previous
        // bound-session list: clear it and keep the confirm action disabled
        // until the binding information for THIS target loads successfully.
        setRemoving({ sessions: [], archive: false });
        setBindingReady(false);
        setError(null);
        const resolveBound = async () => {
          try {
            // The target's own cwd is requested FIRST (its row must survive the
            // route's input cap) alongside every session cwd, so the host
            // returns the canonical worktree root for the target too; matching
            // must never rely on a browser-side path heuristic.
            const requested = [target.cwd, ...allSessions.map((s) => s?.cwd)];
            const cwds = [...new Set(requested.filter((cwd) => typeof cwd === "string" && cwd !== ""))];
            const data = await resolveBindings(cwds);
            const bound = boundSessions(target.cwd, allSessions, data?.bindings ?? []);
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
      }, [target.cwd, target.info, allSessions, reload]);

      const runningSessions = removing.sessions.filter((s) => s.running);
      const blockedByRunning = runningSessions.length > 0;
      const canRemove = bindingReady && !busy && !blockedByRunning
        && target.info !== null && target.info !== undefined;

      const confirmRemove = async () => {
        if (!canRemove) return;
        const plan = cleanup.current;
        // Re-entry guard: a double-click (or a stale retry racing an in-flight
        // attempt) must not run the staged steps twice.
        if (plan.inFlight) return;
        // Capture the roster/choice while the plan is still unfrozen, i.e.
        // before the git removal has actually happened. A failed removal leaves
        // it unfrozen so the roster can be re-resolved and the choice changed.
        if (!plan.frozen) {
          plan.archive = removing.archive && removing.sessions.length > 0;
          plan.sessions = removing.sessions.map((s) => s.id);
        }
        plan.inFlight = true;
        setBusy(true);
        setCleanupError(null);
        try {
          // 1. git first: never archive before the worktree is really gone.
          //    Freeze the roster only after git confirms deletion, so a git
          //    failure never locks the confirmation against a re-resolved —
          //    possibly running — roster.
          if (!plan.gitRemoved) {
            await post("remove", { repo: target.info.repoRoot, path: target.cwd });
            plan.gitRemoved = true;
            plan.frozen = true;
            setStarted(true);
          }
          // 2. archive the frozen ids if chosen, one at a time: an id that
          //    already archived is never re-sent after a mid-list failure, and a
          //    retry resumes with only the unfinished ids.
          if (plan.archive && !plan.archived) {
            while (plan.sessions.length > 0) {
              await archiveSessions([plan.sessions[0]]);
              plan.sessions = plan.sessions.slice(1);
            }
            plan.archived = true;
          }
          // 3. unregister the folder; failures are surfaced, not swallowed.
          if (!plan.unregistered && target.workspaceId !== undefined) {
            await sync.delete(target.workspaceId);
            plan.unregistered = true;
          }
          onClose();
        } catch (e) {
          // `gitRemoved` distinguishes "Git refused to delete the worktree
          // (it still exists)" from "the directory is gone but archive/
          // unregister did not finish", so the UI can explain the right
          // recovery instead of showing a raw English git error.
          setCleanupError({
            phase: plan.gitRemoved ? "cleanup" : "git",
            message: e instanceof Error ? e.message : String(e),
          });
        } finally {
          plan.inFlight = false;
          setBusy(false);
        }
      };

      return react_jsx_runtime.jsxs("div", {
        ...popoverProps(anchor, "删除工作树", dismiss),
        ref: rootRef,
        children: [
          react_jsx_runtime.jsxs("div", {
            className: "gwt-head",
            children: [
              react_jsx_runtime.jsx("span", { children: "删除工作树？" }),
              react_jsx_runtime.jsx("span", { className: "gwt-popPath", children: target.cwd }),
            ],
          }),
          target.info !== null && target.info !== undefined && react_jsx_runtime.jsx("span", {
            className: "gwt-popBranch",
            title: target.info.head ?? undefined,
            children: (target.info.branch ?? "(detached)") + " @ " + (shortSha(target.info.head) ?? "?"),
          }),
          !bindingReady && error === null && react_jsx_runtime.jsx("span", {
            className: "gwt-note",
            children: "正在解析绑定会话…",
          }),
          removing.sessions.length > 0 && react_jsx_runtime.jsx("span", {
            className: "gwt-boundList",
            children: "绑定会话（" + removing.sessions.length + "）："
              + removing.sessions.map((s) => (s.running ? s.title + "（运行中）" : s.title)).join("、"),
          }),
          bindingReady && removing.sessions.length === 0 && react_jsx_runtime.jsx("span", {
            className: "gwt-note",
            children: "无绑定会话；删除后工作树目录移除、分支仍保留。",
          }),
          blockedByRunning && react_jsx_runtime.jsx("p", {
            className: "gwt-error",
            children: "有会话正在运行（" + runningSessions.map((s) => s.title).join("、")
              + "），已停用删除；请先停止这些会话再重试。",
          }),
          (!bindingReady || removing.sessions.length > 0) && react_jsx_runtime.jsxs("label", {
            className: "gwt-check",
            children: [
              react_jsx_runtime.jsx("input", {
                type: "checkbox",
                checked: removing.archive,
                disabled: !bindingReady || busy || started || removing.sessions.length === 0,
                onChange: (event) => setRemoving({ ...removing, archive: event.target.checked }),
              }),
              "一并归档这些会话（日志保留，侧边栏隐藏）",
            ],
          }),
          error !== null && react_jsx_runtime.jsx("p", { className: "gwt-error", children: "绑定信息加载失败：" + error }),
          cleanupError !== null && react_jsx_runtime.jsxs("div", {
            className: "gwt-cleanupError",
            children: [
              react_jsx_runtime.jsx("p", {
                className: "gwt-error",
                children: cleanupError.phase === "git"
                  ? "Git 未能删除该工作树，目录仍然存在。工作树内有未提交或未跟踪的改动时 Git 会拒绝删除；请先在工作树中保存、提交或 stash 这些改动，然后重试。插件不会自动强制删除。"
                  : "工作树目录已删除，但后续清理未完成（会话归档或工作区注销）。可点击“重试清理”继续未完成的步骤，不会再次删除 git 工作树。",
              }),
              react_jsx_runtime.jsxs("details", {
                className: "gwt-details",
                children: [
                  react_jsx_runtime.jsx("summary", { children: "技术详情" }),
                  react_jsx_runtime.jsx("span", { className: "gwt-rawError", children: cleanupError.message }),
                ],
              }),
            ],
          }),
          react_jsx_runtime.jsxs("div", {
            className: "gwt-confirmRow",
            children: [
              react_jsx_runtime.jsx("button", {
                type: "button",
                className: "gwt-btn",
                disabled: busy,
                onClick: dismiss,
                children: "取消",
              }),
              error !== null && !started && react_jsx_runtime.jsx("button", {
                type: "button",
                className: "gwt-btn",
                disabled: busy,
                onClick: () => setReload((value) => value + 1),
                children: "重试加载",
              }),
              react_jsx_runtime.jsx("button", {
                type: "button",
                className: "gwt-btn gwt-btnDanger",
                disabled: !canRemove,
                onClick: () => void confirmRemove(),
                children: busy ? (started ? "清理中…" : "删除中…") : cleanupError !== null ? "重试清理" : "确认删除",
              }),
            ],
          }),
        ],
      });
    }

    /** Explicit repository picker for same-label rows (never guess silently). */
    function WorkspaceChooser({ anchor, candidates, onPick, onClose }) {
      const rootRef = usePopoverRoot(anchor);
      return react_jsx_runtime.jsxs("div", {
        ...popoverProps(anchor, "选择工作区", onClose),
        ref: rootRef,
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
      sanitizeDraft,
      namePlan,
      shortSha,
      clampPopover,
      sessionsSame,
      boundSessions,
      bindingMatchesTarget,
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
