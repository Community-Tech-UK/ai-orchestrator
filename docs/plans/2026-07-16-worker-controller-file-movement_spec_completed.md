# Worker ↔ Controller File Movement — Spec

**Date:** 2026-07-16
**Status:** COMPLETE 2026-07-16 — approved via review `2026-07-16-worker-controller-file-movement` (all six items), implemented and verified the same day; live checks deferred to the plan's livetest doc.
**Plan:** [2026-07-16-worker-controller-file-movement-plan_completed.md](2026-07-16-worker-controller-file-movement-plan_completed.md)
**Trigger:** BinsOut Instagram-upload session (instance `cdzii831t`): the agent moved a file to the Windows worker, the browser upload failed twice, and the agent told James to "approve the pending upload request in the AIO dialog" — a dialog that does not exist. James: "We should be able to move files between our worker and controller easily and effectively."

## What already works (verified live 2026-07-16)

The raw transfer plumbing is solid and was NOT the failure:

- Six MCP tools are wired and reachable by agents: `list_node_files`, `find_node_files`, `get_node_file_info`, `download_from_node`, `upload_to_node`, `collect_browser_download` (`src/main/mcp/orchestrator-file-transfer-tools.ts:109-249`, wired in `src/main/app/orchestrator-tools-step.ts:570`).
- Both directions work with SHA-256 verification and allowlisted roots (`src/main/remote-node/file-transfer-service.ts`, worker sandbox `src/worker-agent/path-sandbox.ts:7-20`).
- Verified live against `windows-pc`: root listing and directory browsing work; the BinsOut session's two `upload_to_node` calls succeeded with matching checksums (app.log `file_transfer_audit` 13:37–13:39).
- Browser uploads to a tab on a remote node auto-stage the controller-local file to the node before `DOM.setFileInputFiles` (`src/main/browser-gateway/browser-remote-upload-staging.ts:31-70`, called from `browser-gateway-service.ts:1649-1657`).

## Root causes of the bad session

1. **Existing-tab upload denials are unapprovable (bug).** When `validateBrowserUploadPath` rejects an upload on a shared/existing tab, the service returns `decision: 'requires_user'` with a synthetic `requestId: browser-${Date.now()}` and never calls `approvalStore.createRequest()` (`browser-gateway-service.ts:1628-1645`). No row is written, so neither the instance card nor the /browser page can ever show it. The managed-profile path (same file, lines 1705-1758) does create a request — the existing-tab path just skips it.
2. **No proactive approval surface.** Real approval requests only appear (a) in a card on the instance-detail page for the *currently viewed* instance, polled every 3 s (`src/renderer/app/features/instance-detail/browser-approval-request.component.ts:66-93`), or (b) on the `/browser` diagnostics page (`browser-page.component.ts:183`). No toast, banner, dock badge, or dialog anywhere. Evidence this fails in practice: every historical non-YOLO approval request in `rlm.db → browser_approval_requests` sat undecided until its 30-minute expiry (rows from 2026-06-27 through 2026-07-08, decide latencies 1800–28000 s, status `expired`). The BinsOut session only proceeded because YOLO mode auto-approved everything in ~2 ms (`auto_approved_by_yolo_mode` grants).
3. **Agents aren't told the upload filesystem model.** `browser_upload_file` paths are always **controller-local**; remote staging is automatic. Nothing in the tool description or the `file_not_found` / `root_not_allowed` error text says so (`browser-upload-policy.ts:50,75`). The BinsOut agent therefore hand-transferred the file to Windows, passed a Windows path, got `file_not_found`, and burned ~6 tool calls and two staged copies discovering the topology. The "Browser upload staging (safety net until fix confirmed live)" transfer root that was added to windows-pc's config is a workaround for exactly this confusion and should become unnecessary.
4. **Agent prompt/error text references a nonexistent "AIO dialog",** so when approval genuinely is needed the human is sent hunting for UI that isn't there.

## Gaps for "move files easily" (beyond the incident)

- **No UI at all for file movement.** No drag-drop, no node file browser. Transfers are MCP/agent-only; IPC channels for copy and directory sync exist but nothing in the renderer consumes them (`REMOTE_FS_COPY_TO_REMOTE`, `REMOTE_FS_SYNC_*` in `src/main/ipc/handlers/remote-fs-handlers.ts:70-393`; zero renderer references).
- **Directory sync engine (rsync-style, delta + rolling checksum, `src/main/remote-node/sync/`) is wired to IPC only** — agents can't call it, and no UI calls it either. Single files only via MCP.
- **50 MB hard cap** per file, whole-file base64 in memory, no streaming (`file-transfer-service.ts:12`). Big artifacts (videos, AABs, zips) can't move.

## Proposed work items (decide by number)

1. **Fix the unapprovable existing-tab upload denial** — make the existing-tab path create a real approval request and honor auto-approve, same as the managed-profile path. Small, surgical, closes the outright bug.
2. **Global approval visibility** — a persistent composer/header banner + one-click approve/deny whenever ANY instance has a pending browser approval (same pattern as the provider-limit park banner), instead of per-instance cards you have to already be looking at. Kills the "requests silently expire" failure class.
3. **Teach agents the upload model** — rewrite `browser_upload_file` tool description + `file_not_found`/`root_not_allowed` error text: "path must be controller-local; remote staging is automatic; to get approval, ask the user to check the approvals banner / /browser page." Also remove "AIO dialog" phrasing everywhere. Cheap, prevents the whole wasted-retries spiral.
4. **Files panel in the UI** — a simple two-pane browser (controller ↔ selected worker) over the existing transfer roots with drag-drop send/fetch, using the already-built IPC. This is the "move files easily" user-facing piece.
5. **Expose directory sync to agents** — `sync_to_node` / `sync_from_node` MCP tools wrapping DirectorySyncService, for multi-file jobs (e.g. a screenshot batch) that currently need N single-file calls.
6. **Large-file streaming** — chunked transfer above 50 MB. Defer unless you actually hit the cap.

## Decisions (James, 2026-07-16, via review artifact)

Overall: APPROVED.

1. Fix the unapprovable existing-tab upload denial — **approved**
2. Global approval visibility — **approved**
3. Teach agents the upload model — **approved**
4. Files panel in the UI — **approved**
5. Expose directory sync to agents — **approved**
6. Large-file streaming — **approved** (James approved despite the suggested deferral, so it is in scope)
