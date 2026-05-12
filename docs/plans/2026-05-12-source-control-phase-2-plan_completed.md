# Source Control Panel — Phase 2

**Status:** proposed — awaiting sign-off before any work starts
**Created:** 2026-05-12
**Revised:** 2026-05-12
  - Review pass 1: fixed factual errors, added missing context, tightened estimates.
  - Review pass 2: added worktree-aware gitdir watching (item 4), correct
    discard semantics for staged changes (item 8), stale-response protection
    on the store (item 3), and editor IPC context for item 6.
  - Review pass 3: specified long-running write tokens, eager-load trigger
    wiring, repo lifecycle detection, inline-diff abstraction, commit-message
    persistence, telemetry, component tests, and remaining API details.
  - Review pass 4: fixed editor IPC target, added explicit VCS watcher
    start/stop/event contracts, gated eager loading behind the badge decision,
    required absolute gitdir/common-dir resolution, and called out nested repo
    discovery changes.
  - Review pass 5: tightened VCS watcher path validation and repo-set event
    semantics, made `.git` creation visibility explicit, and specified
    cross-platform absolute path resolution for open-in-editor.
**Builds on:** `docs/plans/2026-05-11-source-control-panel-plan_completed.md` (Phase 1)

## Context

Phase 1 shipped a working but **undiscoverable** Source Control panel: the
data, IPC, component, and diff modal all exist, but the only way in was the
"more" control-plane chip. A discoverability + correctness fix landed on
2026-05-12 — a git-branch icon now sits next to the file-explorer icon in
the instance header, and the panel architecture was tightened in response
to a cross-model review (see next section).

Phase 2 is everything that makes the panel *useful in real workflows* once
you can actually find it.

## Cross-model review fixes (landed 2026-05-12 — not future work)

A cross-model review of the initial header-icon fix flagged that visibility
state was duplicated between the dashboard signal and the component's own
`isCollapsed`. The duplicate created reachable dead UX (a 36px strip that
"disappeared" the content after one click) and the entry point was visible
in dead-end cases (remote instances, missing working dirs). The fix:

1. **Single source of truth for visibility.** Removed `isCollapsed` from
   `SourceControlComponent`. The dashboard's `showSourceControl` signal
   alone controls whether the panel is mounted. The panel header now has
   an explicit `×` close button that emits a `closeRequested` output;
   dashboard flips the signal off → component unmounts. No more
   collapse-to-strip state.

2. **Tighter eligibility.** `canShowSourceControl` no longer mirrors the
   File Explorer rules. It also excludes remote instances (until Tier D
   ships remote support) and missing/empty working directories. The
   header icon and the control-plane chip both hide in those cases.

3. **Eligibility predicate is pure.** Extracted to
   `src/renderer/app/features/source-control/source-control-eligibility.ts`
   so the rule is unit-testable without Angular DI (mirrors the pattern
   used by `instance-header-cursor.spec.ts`). Eight test cases cover all
   exclusion paths.

4. **Dead code removed.** The in-panel "remote source control coming soon"
   banner branch is gone; the dashboard now hides the entry point in that
   case so the banner is unreachable. `executionNodeId` input and
   `isRemote` computed removed from the component.

These were urgent Phase-1-bug fixes, not Phase-2 work. Documented here so
the cross-model review trail is traceable.

## Phase-2 goals

In rough priority order. Each item is a candidate; we'll pick the cut once
you sign off.

### Tier A — quick wins that pay back immediately

1. **Header status badge.** Show a change-count pip on the git-branch icon
   in the instance header (e.g. `⎇ 5`) so the user knows there's something
   to look at without opening the panel.
   - Effort: tiny on the UI (~30 LOC across `instance-header`, `instance-
     detail`, `dashboard`) once item 3 is in place.
   - **Eager-load tradeoff to confirm**: today's component fetches only
     when its panel is open. For the pip to be accurate before the user
     opens the panel, we have to run `vcsFindRepos` + per-repo
     `vcsGetStatus` **whenever an instance is selected**, even if the user
     never opens SCM. Cost: a fork+exec of `git` per repo per instance
     click. On the `dingley-assessment` example (2 repos) that's tolerable;
     on a monorepo with many submodules it could be felt. Options:
     - Accept the cost (simplest).
     - Gate behind a setting "Show SCM badge on instance header".
     - Compute lazily on hover (worst latency UX).
   - Dependency: item 3 must land first so the header can read the store.
   - **Phase 2 default unless sign-off changes it**: accept the cost for the
     first implementation, but make the eager-load effect conditional on a
     store flag (`badgeMode: 'eager' | 'hover' | 'off'`) so the decision can
     be changed without reworking the store.

2. **Ahead/behind chips in the repo header.** `getStatus()` already returns
   `ahead` and `behind` ints; we just don't show them. Add `↑2 ↓0` chips
   next to the branch label when non-zero.
   - Effort: tiny (~10 LOC template change in `source-control.component.ts`).
   - Risk: none. No new IPC, data already there.

3. **Move per-repo state into a `SourceControlStore` (signal service).**
   Right now the component owns `repos: signal<RepoState[]>` locally. To
   support (a) the header pip, (b) auto-refresh, and (c) future widgets, we
   want a single source of truth.

   **Stale-response protection (required, not optional).** With eager
   loading on instance selection (item 1) plus a long-lived singleton
   store, the existing race in Phase 1 becomes user-visible. Phase 1's
   `refresh()` (`source-control.component.ts:748` and `:785`) awaits
   `vcsFindRepos` then `vcsGetStatus` per repo and writes results back
   guarded only by `findIndex(absolutePath === ...)`. If the user clicks
   instance A, then quickly switches to instance B before A's status
   calls resolve, A's results can land in B's repos signal whenever the
   two instances happen to share a repo path (common in monorepos /
   shared work directories).

   **Required mitigation in the store**:
   - Eager-load trigger lives inside `SourceControlStore`, not the
     dashboard. The store injects `InstanceStore` and the same eligibility
     inputs the dashboard uses (`ChatStore`, benchmark flag source, selected
     instance execution location), owns an `effect()` that watches
     `InstanceStore.selectedInstance()`, and calls
     `loadForRoot(root, { reason: 'selection' })` only when:
     `badgeMode === 'eager'`, the instance is source-control eligible, and
     the root is a non-empty local working directory. This keeps the header
     pip and panel view backed by the same owner, makes the eager-load trigger
     testable without dashboard component tests, and prevents the unresolved
     badge tradeoff from forcing eager git work in modes that should not do
     it. The component still calls `loadForRoot(root, { reason: 'manual' })`
     for explicit refreshes.
   - Sequence counter: `private requestSeq = 0`. Every `refresh(root)`
     does `const reqId = ++this.requestSeq` at entry, and every `await`
     boundary checks `if (reqId !== this.requestSeq) return` before
     mutating signals. The same counter guards the eager per-instance
     load triggered by selection changes.
   - Active root token: store `private activeRoot = signal<string | null>
     (null)`. Results that arrive after `activeRoot` no longer matches
     the in-flight `root` are dropped silently (logged at debug).

   Mandatory test: with a mocked `InstanceStore.selectedInstance` signal,
   simulate a slow `vcsFindRepos` for root A, switch selection to root B
   mid-flight, assert A's late-arriving repo list and statuses do not
   overwrite B's state. Without this test the regression is silent —
   counts will look "mostly right" with occasional drift.

   - Effort: medium (~half day for the move + ~half day for the
     sequence-counter logic and its test). **~1 day total**, not the
     half day I previously estimated.
   - Risk: light refactor of the Phase 1 component. Phase 1
     typecheck/lint pass coverage is the safety net.
   - **This item is a prerequisite for items 1 and 4.** Do not start
     them until the store is in place.

### Tier B — the real "make it useful" pass

4. **Auto-refresh on git state changes.** Build a `GitStatusWatcher` in the
   main process that emits `vcs:status-changed` events the renderer
   subscribes to. The store re-fetches affected repos and updates signals.

   **The watch set must cover all four trigger surfaces:**
   - **Per-worktree gitdir** — staged changes (`.../index`), HEAD position
     (`.../HEAD`), per-worktree logs (`.../logs/HEAD`).
   - **Common gitdir** — `refs/heads/*`, `refs/remotes/*`, `packed-refs`
     for branch and remote-tracking changes (drives ahead/behind chips).
   - **Working tree** (debounced, gitignore-aware) — unstaged edits do
     NOT touch the index. If we only watch the gitdir we'll miss
     "Claude just edited 5 files in another window" until the user runs
     `git add`. This is the most common case and the one that motivated
     the whole feature, so we must watch the working tree too.

   **Important: do not assume `<repo>/.git` is a directory.** This app
   creates linked worktrees via `git worktree add` (see
   `src/main/workspace/git/worktree-manager.ts:123`). In a linked worktree
   `<repo>/.git` is a **file** containing `gitdir: <path>` pointing at
   `<main-gitdir>/worktrees/<name>/`. The per-worktree HEAD and index live
   inside that linked gitdir, not at `<repo>/.git/HEAD`. Watching the
   wrong path will silently never fire.

   The right discovery flow per repo is:
   ```
   git rev-parse --git-dir          # per-worktree gitdir
   git rev-parse --git-common-dir   # shared common dir (refs, packed-refs)
   ```
   For a normal (non-worktree) repo both commands return `<repo>/.git`.
   For a linked worktree they differ. Watch the gitdir for HEAD + index +
   logs, and the common dir for refs + packed-refs.

   **Prior art to compose, not reinvent**: `src/main/workspace/watcher/file-
   watcher.ts` already implements gitignore-aware chokidar watching with
   debouncing, depth limits, and a `WatchSession` lifecycle. The new
   `GitStatusWatcher` should reuse it for the working-tree watch and add a
   small gitdir + common-dir watcher on top. Configure that working-tree watch
   so `.git` directory/file creation and deletion events are visible while
   `.git/**` internals remain ignored; otherwise clone/worktree creation under
   the selected root can be swallowed before the repo-set logic sees it. For
   normal working-tree changes, resolve the changed path to absolute form,
   match it against the known repository roots, and emit one per-repo event for
   each containing repo root. If no repo contains the path, ignore it unless it
   is a `.git` create/delete event that triggers the repo-set flow.

   **Repo appearance / disappearance lifecycle**: reuse the already-running
   working-tree watcher to detect repository set changes. When a debounced
   `addDir` event has basename `.git` (normal clone) or an `add` event has
   basename `.git` (linked worktree file), re-run `vcsFindRepos(root)`,
   diff the repo set, and attach gitdir/common-dir watchers for new repos.
   Emit one root-level `repo-set` event containing the added/removed repo paths
   so the renderer can reload the root instead of guessing an affected repo.
   Mirror that for `unlinkDir` / `unlink` to detach watchers when repos
   disappear. Do not trigger repo discovery on every working-tree event.

   **Write-action interaction (forward link to Tier C)**: when the user is
   mid-stage, discard, commit, or push, watcher events can fire while a
   local write is still in flight. A fixed timeout is wrong for long-running
   writes: `git push` can run for 30+ seconds and update `refs/remotes/*`
   mid-operation. The store needs a token-based write suspension API:

   ```
   const token = store.beginWrite(repoPath, 'push');
   try {
     await vcs.push(...);
   } finally {
     store.endWrite(token);
   }
   ```

   `beginWrite()` records an active write token per repo. Incoming
   `vcs:status-changed` events for repos with active tokens are coalesced
   into a pending-refresh set, not applied immediately. `endWrite(token)`
   removes that token, waits a short grace period (~300-500ms), then
   performs one refresh for the affected repo if no newer write token is
   still active. Stale or double-ended tokens are ignored and logged at
   debug level. Every Tier C write action must use `try/finally` around
   this API.

   **IPC lifecycle contract**:
   - New channels:
     - `VCS_WATCH_STATUS_START: 'vcs:watch-status:start'`
     - `VCS_WATCH_STATUS_STOP: 'vcs:watch-status:stop'`
     - `VCS_STATUS_CHANGED: 'vcs:status-changed'`
   - Payload schemas:
     - Start:
       `{ rootPath: string, repositories: string[] }`
       where `repositories` is the latest repo list from `vcsFindRepos`.
       Handler returns `{ watchId: string }`.
       The main handler must still treat this as untrusted renderer input:
       normalize/realpath `rootPath` and each repository path where possible,
       require every repository working directory to be absolute and inside or
       equal to `rootPath`, and reject non-directory or duplicate entries before
       opening watchers.
     - Stop:
       `{ watchId: string }`.
     - Event:
       `{ watchId, rootPath, reason, changedPath?, eventType, timestamp,
       repoPath?, addedRepositories?, removedRepositories? }`, where `reason`
       is one of `'gitdir' | 'common-gitdir' | 'working-tree' | 'repo-set'`.
       `repoPath` is required for `gitdir`, `common-gitdir`, and `working-tree`
       events. `repo-set` is root-scoped: omit `repoPath`, populate
       `addedRepositories` / `removedRepositories`, and have the store call
       `loadForRoot(root, { reason: 'watcher' })`.
   - Preload / renderer API:
     - `vcsWatchStatusStart(payload)`
     - `vcsWatchStatusStop(watchId)`
     - `onVcsStatusChanged(callback): () => void`
   - Store lifecycle:
     - After `loadForRoot()` resolves the repo list, the store starts or
       refreshes the watcher with that root + repo list.
     - When `activeRoot` changes, source-control eligibility becomes false,
       or the app is leaving the workspace view, stop the old `watchId`.
     - Incoming events whose `watchId` or `rootPath` no longer matches
       current store state are dropped at debug level.
     - Incoming per-repo events refresh only the affected repo. Incoming
       `repo-set` events refresh the whole active root because the repository
       list itself changed.

   - Effort: **2 days realistic**. Composing the existing watcher cuts
     the chokidar wiring; new work is gitdir resolution + debouncing
     across the four trigger surfaces, watcher lifecycle when repos
     appear/disappear (new clone under cwd), token-based write suspension,
     and the linked-worktree integration test.
   - Risk: watcher overhead on very large repos (e.g. browser engine
     forks). The existing `FileWatcher` already respects `.gitignore` and
     a depth cap, so this is mostly inherited.
   - Tests:
     - Unit: mock chokidar emits across the four trigger surfaces, assert
       debounced fan-out.
     - **Linked-worktree integration test**: create a parent repo + a
       worktree under it, stage a change in the worktree, assert the
       watcher fires `vcs:status-changed` for the worktree path (not the
       parent). Without this test, the wrong-path regression is invisible.
     - Repo-lifecycle test: emit a debounced `.git` `addDir` event and
       assert `vcsFindRepos(root)` reruns, the emitted `repo-set` event carries
       added/removed repositories, and new watchers attach.
     - Channel-spec assertion + handler integration test covering start,
       stop, start-payload path validation, event forwarding, and stale event
       drops.

   **Nested repo discovery fix**: Phase 1's `VcsManager.findRepositories()`
   currently stops walking a subtree as soon as it finds `.git`. That means
   selecting a repo root will skip nested repos/submodules inside it, despite
   this plan discussing monorepos and submodules. Phase 2a must adjust
   discovery to continue walking below the selected root after adding the root
   repo, while still ignoring the `.git` internals themselves. Add a test with
   `root/.git` plus `root/packages/child/.git` and assert both repos are
   returned.

   **Gitdir path resolution detail**: `git rev-parse --git-dir` and
   `git rev-parse --git-common-dir` can return relative paths. Resolve each
   non-absolute output against the repo working directory before handing it
   to chokidar. Add a unit test that mocks relative outputs and asserts the
   watcher attaches to absolute paths.

5. **Inline diff expansion** (optional second viewing mode alongside the
   modal). Click a row → expand the unified diff inline below the row
   (chevron toggles). Modal stays for "give me the whole thing"; inline
   for "let me skim ten files quickly".
   - Refactor target: create
     `src/renderer/app/features/source-control/source-control-diff-loader.service.ts`.
     It exposes
     `loadFileDiff({ workingDirectory, filePath, staged }): Promise<DiffViewState>`
     and uses `VcsIpcService.vcsGetDiff` internally. Move the rendered-line
     transformation into a pure helper (`renderDiffLines(diffFile)`) so the
     modal and inline expansion share one pipeline.
   - Effort: **~250–300 LOC realistic.** Today's rendered-lines logic in
     `source-control-diff-viewer.component.ts` is coupled to the modal's
     `effect()`-driven load lifecycle. The estimate assumes the named
     loader service + pure line renderer above.
   - Tests: render snapshot of the lines pipeline for a simple unified-
     diff fixture, plus component tests for expand/collapse, lazy load on
     first expand, and per-row error state.

6. **"Open file" jump from the diff viewer.** Top-right button on the
   modal that opens the file in the user's preferred editor.

   **Use the handled editor IPC, not `editor:open`.** `FileIpcService.editorOpen`
   currently calls `editor:open`, but the main process only registers the
   handled extended editor channels (`EDITOR_OPEN_FILE`,
   `EDITOR_OPEN_FILE_AT_LINE`, `EDITOR_OPEN_DIRECTORY`). Item 6 must add
   renderer service wrappers for the existing preload methods:
   - `FileIpcService.editorOpenFile(filePath, options?)` →
     `window.electronAPI.editorOpenFile({ filePath, options })`
   - `FileIpcService.editorOpenFileAtLine(filePath, line, column?)` →
     `window.electronAPI.editorOpenFileAtLine({ filePath, line, column })`

   The diff viewer should call `editorOpenFileAtLine(absPath, firstHunkLine)`
   when a textual hunk is available and `editorOpenFile(absPath)` otherwise.
   Construct `absPath` with the existing renderer-safe
   `resolveRelativePath(workingDirectory, filePath)` helper from
   `src/shared/utils/cross-platform-path.ts`; do not hand-roll
   `workingDirectory + '/' + filePath`, which breaks Windows paths and
   `..`-prefixed file paths.
   Do **not** route this through `editorOpen()` unless a real `EDITOR_OPEN`
   main handler is added first.

   - Effort: tiny (~45 LOC for service wrappers, button, and editor call).
   - Line-number choice: the diff viewer doesn't know "the right line" —
     options are (a) open at file top (line=1), (b) jump to the first
     hunk's `newStart`, (c) jump to the line under cursor in the diff
     pane. Phase 2 picks (b) for usefulness; cursor-aware (c) is a
     follow-up if we ever add hunk navigation.
   - Fallback: when no editor is configured, surface the error from
     `editorOpenFileAtLine` / `editorOpenFile` (don't silently open the repo
     directory — that's a different user intent).

### Tier C — write actions (was the original "deferred" list)

These each need: new channel + Zod schema + channels-spec assertion +
handler + preload + IPC service + (sometimes) new VcsManager method +
UI + handler test. Realistic per-item cost is below; they should ship one
at a time, not as a bundle.

7. **Stage / unstage individual files.** `git add -- <file>` and
   `git restore --staged -- <file>`. Hover affordance on each file row →
   `+` icon to stage, `−` to unstage.
   - New channels: `VCS_STAGE_FILES`, `VCS_UNSTAGE_FILES`.
   - New `VcsManager` methods: `stageFiles(paths: string[])`,
     `unstageFiles(paths: string[])`, both using `--` before path args.
   - Implements the `beginWrite()` / `endWrite()` token contract from item 4.
   - **Effort: ~1 day** including tests.

8. **Discard changes.** "Discard" is three distinct operations in git;
   the UI must pick one and the implementation must use the right
   command. The bare `git restore <file>` only discards the **worktree**
   side, leaving staged changes intact — that's almost never what a user
   means when they click "Discard".

   **The three modes:**
   | UI action | Effect | Git command |
   |---|---|---|
   | Discard (default, single button) | Revert file fully to HEAD — drop both staged and unstaged changes | `git restore --source=HEAD --staged --worktree -- <file>` |
   | Unstage | Move staged change back to unstaged (keep edits) | `git restore --staged -- <file>` |
   | Discard worktree only (rare) | Drop unstaged changes, keep staged | `git restore -- <file>` |

   **Phase 2-d ships only "Discard" (mode 1) + "Unstage" (mode 2, via
   item 7).** Mode 3 is fringe; defer until requested.

   **Untracked files** go via Electron's `shell.trashItem` (recoverable
   from the user's Trash). Untracked directories are the most dangerous
   case — confirmation modal required, then pass the directory itself to
   `shell.trashItem`; assert the directory is gone after the call resolves.

   - New channel: `VCS_DISCARD_FILES`. Handler dispatches per-path based
     on current status: tracked-with-changes → `git restore --source=HEAD
     --staged --worktree`, untracked file or dir → `shell.trashItem`.
   - New `VcsManager` method: `discardTracked(paths: string[])` using
     the `--source=HEAD --staged --worktree` form.
   - **Effort: ~1 day** including confirmation modal and tests.
   - Tests (matrix):
     - Staged-only modification — verify command actually removes from
       index, not just worktree.
     - Unstaged-only modification — verify reverts to HEAD content.
     - Staged + unstaged on same file (the case bare `git restore` would
       half-handle) — verify both are dropped.
     - Untracked file → trashed, recoverable.
     - Untracked directory → confirmation modal, directory no longer
       present on disk after `shell.trashItem(dirPath)` resolves.
     - Mixed selection (one tracked + one untracked) — verify both
       dispatch paths fire correctly.

9. **Commit.** Per-repo commit message input + commit button.
   - New channel: `VCS_COMMIT` with payload
     `{ workingDirectory, message, signoff?: boolean, amend?: boolean }`.
   - New `VcsManager` method: `commit(opts)`.
   - **UI checkbox** for "Add `Signed-off-by`" (off by default). No
     project-specific policy — just expose the option.
   - Commit-message persistence: `SourceControlStore` owns
     `commitMessages = signal<Record<string, string>>({})`, keyed by
     absolute repo path. Messages survive panel close/reopen and instance
     switches within the same app session. They are cleared on successful
     commit or when the user clears the input. Phase 2 does **not** persist
     drafts across app restart; add localStorage/project persistence later
     only if users ask for it.
   - **Effort: ~1.5 days** including the message-input UX (multiline,
     keep across re-renders, `⌘+Enter` submit), tests.

10. **Push / pull.** Buttons in each repo header. `VcsManager` already
    has `fetch()` and `pullFastForward()` (lines 844, 855); they just
    need IPC surface. `push` is new.
    - New channels: `VCS_FETCH`, `VCS_PULL`, `VCS_PUSH`.
    - New `VcsManager` method: `push(opts)`.
    - Long-running: needs progress streaming via existing event-emit
      pattern. Concrete reference: `src/main/ipc/handlers/codebase-handlers.ts`
      emits `CODEBASE_INDEX_PROGRESS`; `src/preload/domains/infrastructure.preload.ts`
      exposes the matching renderer listener. Reuse that shape for
      `vcs:operation-progress` / cancellation rather than inventing a
      one-off stream.
    - **Effort: ~1.5 days** — the streaming + cancellation is most of it.

11. **Branch switcher.** Dropdown in each repo header listing branches
    with checkout action.
    - New channel: `VCS_CHECKOUT_BRANCH`.
    - Payload: `{ workingDirectory, branchName, force?: boolean }`.
      First attempt without `force` should fail with a structured dirty-tree
      reason when checkout is unsafe; the confirmation path retries with
      `force: true`.
    - **Prerequisite**: `VcsManager` has no `checkout()` method today;
      we need to add `checkoutBranch(name: string, opts?: { force?: boolean })`
      to the manager first.
      Plan must not skip this.
    - **Effort: ~1 day** including the manager method, dirty-tree
      detection ("you have unstaged changes — switch anyway?"), tests.

### Tier D — future / nice-to-haves

12. **Remote-node support.** Run git ops over the existing remote-shell
    transport for non-local instances. Replaces the "coming soon" banner
    with real data. Touches `remote-fs` + a new remote-vcs adapter.
    Significant work. When this lands, remove the `isRemote` exclusion from
    `isSourceControlEligible` and update `source-control-eligibility.spec.ts`;
    otherwise the new support remains unreachable from the dashboard.
13. **Hunk-level staging** (`git apply --cached` with synthesized
    patches). VS Code does this; legitimately hard but powerful.
14. **Conflict resolution UI** (merge marker viewer, mark-resolved button).
15. **Hide-noise toggle** for very long untracked lists.
16. **Stash list + apply.** `VcsManager.listStashes()` already exists,
    just no IPC.
17. **Blame in the diff viewer.** `vcsGetBlame` IPC already exists.

## Testing strategy (applies to every Phase 2 PR)

The Phase 1 testing surface set the convention; Phase 2 extends it:

- **Every new IPC channel** → assertion in
  `packages/contracts/src/channels/__tests__/workspace.channels.spec.ts`.
- **Every new Zod payload schema** → at least one valid + one invalid
  fixture in `packages/contracts/src/schemas/__tests__/workspace-tools.
  schemas.spec.ts`.
- **Every new IPC handler** → mock-electron unit test in
  `src/main/ipc/handlers/__tests__/vcs-handlers.spec.ts` (file to be
  created on the first Tier B/C item; doesn't exist yet — Phase 1 added
  channel tests but not handler tests for VCS).
- **`SourceControlStore`** → component-free signal-based unit test (mock
  `VcsIpcService` and `InstanceStore`). Must cover store-internal eager
  loading gated by `badgeMode`, stale-response drops, write-token coalescing,
  watcher start/stop lifecycle, stale watcher-event drops, and commit-message
  draft persistence.
- **`GitStatusWatcher`** → unit test driving mocked chokidar events
  through the four trigger surfaces, asserting debounced fan-out.
- **`VcsManager.findRepositories()`** → unit test for nested repo discovery
  under a selected repo root (`root/.git` plus `root/packages/child/.git`).
- **Gitdir resolution helper** → unit test that relative `--git-dir` and
  `--git-common-dir` outputs are resolved to absolute paths before watching.
- **VCS watcher IPC handler** → rejects start payloads containing duplicate
  repositories, non-absolute repository paths, or repository working
  directories outside the normalized `rootPath`.
- **Open-in-editor path resolution** → focused renderer unit test that
  verifies diff viewer calls use `resolveRelativePath(workingDirectory,
  filePath)` for POSIX and Windows-style roots before invoking
  `editorOpenFileAtLine`.
- **Source-control component UI** → Angular component tests for non-trivial
  UI state, not just pure helpers. Required coverage for Phase 2: inline
  diff row expand/collapse, lazy loading only on first expand, per-row
  loading/error states, and a regression assertion that closing the panel
  unmounts it rather than leaving a collapsed 36px strip.

## Telemetry / observability

Phase 2 adds long-lived watchers, eager background loads, and write actions.
Debugging these from user reports will be painful without structured logs.
Do not log diff contents or commit messages.

- **`SourceControlStore`** (`getLogger('SourceControlStore')`): info on root
  load start/finish with root, repo count, duration, and reason (`selection`,
  `manual`, `watcher`, `write-complete`); debug for stale response drops and
  coalesced watcher events; warn on failed repo/status loads.
- **`GitStatusWatcher`** (`getLogger('GitStatusWatcher')`): info on watcher
  attach/detach with repo path, gitdir/common-dir paths, and watch-session ids;
  debug for debounce fan-out and repo discovery reruns; warn on chokidar errors
  or missing gitdir/common-dir resolution.
- **Write actions**: use the existing `VcsManager` command audit hook shape
  (`cmd`, `args`, `cwd`, `exitCode`, duration, stdout/stderr byte counts).
  Log command metadata, never file contents, diffs, or commit message bodies.
- **Long-running operations** (`fetch`/`pull`/`push`): emit progress and
  terminal status events with operation id, repo path, phase, and duration;
  log cancellation and failure paths at info/warn respectively.

## Implementation phasing (with explicit dependencies)

Order is mandatory where noted, not just preferred:

- **Phase 2a — store refactor + nested repo discovery + chips + pip (Tier A,
  items 3 → 1 → 2).** Item 3 is a prerequisite for item 1. Item 2 is
  independent and can land in the same PR or separately. Include the
  `VcsManager.findRepositories()` nested-repo fix here so the badge and store
  count the same repo set that later watchers will track. ~1 day for item 3
  plus the focused discovery fix. 1 PR.
- **Phase 2b — auto-refresh (item 4).** Depends on Phase 2a so the store
  is in place for the watcher to push into. ~2 days with the linked-worktree
  integration test. 1 PR.
- **Phase 2c — inline diff + open-in-editor (items 5, 6).** Independent
  of 2b and can run in parallel if a second owner takes it; listed after 2b
  for narrative cohesion. ~half day for item 6, ~1.5 days for item 5; can be
  split into two PRs.
- **Phase 2d…2h — Tier C write actions, one per PR.** Order suggested:
  stage/unstage (7) → discard (8) → commit (9) → push/pull (10) →
  branch switcher (11). Each ~1–1.5 days. The write-token contract introduced
  in 2b must be honored by each.

I'd stop here and revisit before Tier D — by then we'll know what's
actually missing from real use.

## Open questions before we start

1. **Override the default eager-load decision for the header pip?** Item 1 now
   defaults to eager loading with a `badgeMode` gate; confirm that default or
   switch to hover/off before implementation.
2. **Keep the control-plane chip** in the "more" menu now that the header
   icon exists, or rip it out for one source of truth? Phase 1 left both.
3. **Header pip semantics**: count untracked files too (VS Code default,
   but can be very noisy if a project under-gitignores generated files),
   or only tracked changes?
4. **Header icon order**: the SCM icon now sits to the right of the
   folder icon. Keep that order, or swap so SCM comes first (matches
   VS Code activity-bar order)?
5. **Signoff default for commits** (item 9): off by default with an opt-in
   checkbox is my recommendation. Confirm or override?
