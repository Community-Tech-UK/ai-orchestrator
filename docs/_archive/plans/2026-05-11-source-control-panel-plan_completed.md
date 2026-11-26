# Source Control Panel (VS Code–style RHS slideout)

**Status:** completed
**Started:** 2026-05-11
**Completed:** 2026-05-11

## Goal

Add a VS Code–style Source Control slideout to the right of the dashboard,
sibling to the existing File Explorer. For each git repository found under the
selected instance's working directory, show the current branch and a list of
changed files with M/A/D/? status badges. Click a file → open a modal with the
unified diff for that file.

## User-confirmed scope (2026-05-11)

1. Both Source Control and File Explorer panels can be open at the same time.
2. Show the file list with M/A/D/? badges, AND include an inline diff viewer
   (click a file → modal showing the unified diff).
3. **Skip** staging/commit/discard buttons in v1. See "Deferred to v2" below.
4. Repo discovery root = selected instance's `workingDirectory` (same source
   as the File Explorer).
5. Local execution only in v1. Remote-node instances show a "Source control
   on remote nodes coming soon" message.

## Existing infrastructure (no work needed)

- `VcsManager` (`src/main/workspace/git/vcs-manager.ts`)
  - `findRepositories(root, ignores)` — walks a directory tree, returns absolute
    paths of every nested git repo (already filters `.git`, `node_modules`,
    `dist`, `build`, `out`, `target`, `coverage`, `.pnpm-store`, etc.)
  - `getStatus()` → `{ branch, ahead, behind, staged, unstaged, untracked, ... }`
  - `getUnstagedDiff()` / `getStagedDiff()` / `getFileDiff(path, staged)` →
    `DiffResult` with parsed hunks
- IPC handlers: `VCS_IS_REPO`, `VCS_GET_STATUS`, `VCS_GET_DIFF`, …
- Preload: `vcsIsRepo`, `vcsGetStatus`, `vcsGetDiff`, …
- `VcsIpcService` already wraps every existing channel.
- `FileExplorerComponent` is the template to mirror for the new panel (header,
  collapse/resize, persisted width via `ViewLayoutService`).

## What's missing

1. No IPC for multi-repo discovery (`VcsManager.findRepositories` only callable
   from main process).
2. No source-control UI component.
3. No layout slot in dashboard for a second right-side slideout.

## Implementation steps

### Backend (one new channel + handler)

- [ ] `packages/contracts/src/channels/workspace.channels.ts`
  - Add `VCS_FIND_REPOS: 'vcs:find-repos'`
- [ ] `packages/contracts/src/channels/__tests__/workspace.channels.spec.ts`
  - Add assertion for the new channel
- [ ] `packages/contracts/src/schemas/workspace-tools.schemas.ts`
  - Add `VcsFindReposPayloadSchema` = `{ rootPath: DirectoryPathSchema }`
- [ ] `src/main/ipc/handlers/vcs-handlers.ts`
  - Add handler that calls `VcsManager.findRepositories(rootPath)` and returns
    `{ repositories: string[] }`. Guard with `isGitAvailable()` check.
- [ ] Run `npm run generate:ipc` to regenerate `src/preload/generated/channels.ts`

### Preload + renderer wiring

- [ ] `src/preload/domains/workspace.preload.ts`
  - Add `vcsFindRepos(rootPath: string)` calling `ch.VCS_FIND_REPOS`
- [ ] `src/renderer/app/core/services/ipc/vcs-ipc.service.ts`
  - Add `vcsFindRepos(rootPath)` method
- [ ] `src/renderer/app/core/services/view-layout.service.ts`
  - Add `sourceControlWidth: number` to `ViewLayout` interface
  - Default 300, min 220, max 500
  - Add `setSourceControlWidth()` setter

### Source Control component

- [ ] `src/renderer/app/features/source-control/source-control.component.ts`
  - Standalone, OnPush, signal-based
  - Inputs: `rootPath: string | null`, `executionNodeId: string | null`
  - State:
    - `isCollapsed` (default true, mirrors file-explorer)
    - `repos: signal<RepoStatus[]>`
    - `expandedRepos: signal<Set<string>>`
    - `selectedDiffFile: signal<{ repoPath, filePath, staged } | null>`
    - `isLoading`, `error`
  - Behaviours:
    - effect: when `rootPath` or `executionNodeId` changes → refresh
    - effect: when `executionNodeId !== null` (remote) → show banner, no load
    - `refresh()`: call `vcsFindRepos(rootPath)`, then `vcsGetStatus` per repo
      in parallel; sort repos alphabetically; auto-expand all on first load
    - `onFileClick(repoPath, fileChange)`: opens diff viewer modal
  - Rendering:
    - Header: "Source Control" + refresh icon + collapse arrow
    - Remote-node banner (if remote)
    - Loading/error/empty states
    - For each repo: collapsible section
      - Header row: 📦 repoName · branch · changeCount badge
      - Body: list of changes grouped: Staged / Unstaged / Untracked
      - Each row: status badge (M/A/D/R/?) + filename + relative path
      - Empty repo: "No changes" subtle text

### Diff viewer modal

- [ ] `src/renderer/app/features/source-control/source-control-diff-viewer.component.ts`
  - Standalone modal overlay (similar pattern to command palette)
  - Inputs: `workingDirectory`, `filePath`, `staged`
  - On open: call `vcsGetDiff({ workingDirectory, type: staged?'staged':'unstaged', filePath })`
  - Render: file header + unified diff with color-coded lines
    - `+` lines green background
    - `-` lines red background
    - `@@` hunk headers in muted color
    - Binary files: "Binary file changed" placeholder
  - Esc to close, backdrop click to close

### Dashboard wiring

- [ ] `src/renderer/app/features/dashboard/dashboard.component.ts`
  - Import `SourceControlComponent`
  - Add `showSourceControl = signal(false)` + `toggleSourceControl()` method
  - Add `canShowSourceControl = computed(() => ...)` mirroring file explorer logic
- [ ] `src/renderer/app/features/dashboard/dashboard.component.html`
  - Slot `<app-source-control>` immediately BEFORE `<app-file-explorer>` so it
    sits to the left of the file list
  - Control plane chip: "Source Control" (toggles `showSourceControl`)
- [ ] `src/renderer/app/features/dashboard/dashboard.component.scss`
  - Add `app-source-control` flex-shrink: 0 + border-left styling (mirror
    `app-file-explorer`)

### Verification

- [ ] `npx tsc --noEmit`
- [ ] `npx tsc --noEmit -p tsconfig.spec.json`
- [ ] `npm run lint`
- [ ] Run vcs-handler tests if any exist
- [ ] Manual: launch app, select an instance whose working directory contains
  one or more git repos with changes, open Source Control panel, verify list
  matches `git status` output. Click a file → diff modal renders correctly.

## Deferred to v2 (NOT in this change — capture for later)

- Staging / unstaging individual files (`git add <file>`, `git restore --staged <file>`)
- Discarding changes (`git restore <file>`, `git clean` for untracked)
- Commit message + commit button (per-repo, like VS Code)
- Push / pull buttons + ahead/behind indicators in the repo header
- Branch switcher dropdown
- File watcher for auto-refresh (currently manual refresh button)
- Diff view: side-by-side mode, syntax highlighting, "open file" jump
- Remote-node support (currently local-only)
- Inline diff expansion (vs modal)
- Conflict resolution UI
