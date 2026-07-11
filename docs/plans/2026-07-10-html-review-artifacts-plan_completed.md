# HTML Review Artifacts — Implementation Plan (2026-07-10)

## Summary

Adopt the "Markdown for machines, HTML for humans" split formalised by the May 2026
Anthropic guidance (Thariq Shihipar, "The Unreasonable Effectiveness of HTML") and the
llms.txt movement:

- **Docs only agents read** (conventions, runbooks, agent instructions, specs in
  `docs/`) stay Markdown. No change.
- **Docs James must check and approve** (plans, decision docs, audits, reports) are
  presented as a **self-contained interactive HTML review artifact** with per-item
  approve/reject controls and inline comments, and the decisions flow back to the
  requesting agent.
- **Markdown stays the source of truth in the repo.** HTML is a disposable render
  target, never committed. The `_completed` rename convention and loop completion
  detection are unchanged.

Three phases, each independently shippable:

| Phase | Deliverable | App code? |
|-------|-------------|-----------|
| 0 | Format policy in `AGENTS.md`, artifact dir + gitignore | No |
| 1 | `doc-review-artifact` skill: generate artifact, manual decision round-trip | No |
| 2 | AIO-native review pane: MCP tool + doc-review service + renderer feature | Yes |
| 3 | Loop integration: auto-review on `stop-needs-review`, durable approval record | Yes |

Phase 1 delivers James's ask immediately (any Claude Code session, no AIO changes).
Phases 2–3 remove the manual copy-back step and integrate with loops.

## Grounding (verified in codebase 2026-07-10)

- Loop attachments: `src/main/orchestration/loop-attachments.ts` — per-run dirs under
  `.aio-loop-attachments/<loopRunId>/`, `renderAttachmentBlock()` prepended each
  iteration (`loop-coordinator.ts:817–821`), `ensureLoopAttachmentsIgnored()` auto-adds
  the dir to `.gitignore`. We mirror this pattern for review artifacts.
- Approval round-trip precedent: `browser-escalation-queue.component.ts` +
  `browser-unattended.store.ts:218–232` (store → IPC → main handler → state update).
- Push feedback into a running instance:
  `instance-messaging.store.ts` `sendInputImmediate()` →
  `IPC_CHANNELS.INSTANCE_SEND_INPUT` → `instance-handlers.ts:57+` →
  `instanceManager.sendInput()`.
- Renderer markdown pipeline (`markdown.service.ts:388–403`) sanitises with DOMPurify —
  **strips `<script>`, so it cannot host interactive artifacts**; the review pane uses a
  sandboxed iframe instead (see Security).
- Window security: `window-manager.ts:70–76` — `nodeIntegration: false`,
  `contextIsolation: true`, `sandbox: true`.
- IPC domain pattern to copy: TODO domain — channels
  `packages/contracts/src/channels/workspace.channels.ts:60–67`, schemas
  `packages/contracts/src/schemas/session.schemas.ts:650–659`, handlers
  `src/main/ipc/handlers/todo-handlers.ts`, preload
  `src/preload/domains/workspace.preload.ts:205–210`, registration
  `src/main/ipc/ipc-main-handler.ts:53,299`.
- MCP tool pattern: `src/main/mcp/orchestrator-settings-tools.ts:115–287`
  (`createXxxToolDefinitions()` → `McpServer.registerTools()`; instance-scoped tools via
  `orchestrator-tools-rpc-server.ts`).
- Singleton pattern: `src/main/session/agent-tree-persistence.ts:42–59`
  (`getInstance()` + `_resetForTesting()`).
- Loop review gate: evidence-resolver emits `stop-needs-review` when verify is skipped —
  the natural Phase 3 hook. `durable-approval-store.ts` exists backend-only.
- Naming: an existing renderer feature is already called `review` (cross-model review,
  `app.routes.ts:56–59`). This feature is **`doc-review`** everywhere to avoid collision.

## The artifact contract (v1) — shared by all phases

A review artifact is **one self-contained HTML file**:

- No external requests of any kind: inline CSS, inline JS, images as data URIs. No
  `fetch`, no CDN links, no forms posting anywhere.
- `<meta name="aio-doc-review" content="v1">` plus `<meta name="aio-doc-review-title">`
  and optional `<meta name="aio-doc-review-source">` (repo-relative md source path).
- Reviewable sections carry `data-review-item="<stable-id>"` and
  `data-review-title="<short title>"`. Decision points (things James answers by number)
  additionally carry `data-decision-id="<n>"` and render as numbered items.
- An embedded **review runtime** (small vanilla JS, part of the artifact template) with
  two modes:
  - **Standalone** (Phase 1, opened directly in a browser): renders its own comment UI
    (per-item comment box, approve/reject toggle, overall verdict bar). "Export
    decisions" downloads `<artifact-basename>.decisions.json` and copies a markdown
    summary to the clipboard.
  - **Embedded** (Phase 2, `window.parent !== window`): suppresses its own chrome and
    speaks `postMessage` to the host: emits `aio-review/ready`,
    `aio-review/comment`, `aio-review/decision`; accepts `aio-review/init` (existing
    comments) and `aio-review/request-state`.

Decisions always reduce to one canonical markdown block (this is what agents consume):

```markdown
## Document review feedback — <title> (review <id>)
Overall: APPROVED | CHANGES REQUESTED | REJECTED
1. [<item-title>] approve — <optional comment>
2. [<item-title>] reject — <comment>
General: <free-text>
```

## Phase 0 — Policy and hygiene (no code)

1. Add a **"Documentation formats"** section to `AGENTS.md`:
   - Markdown is canonical for anything an agent reads or that lives in the repo
     long-term. HTML is a render target only.
   - Any doc that requires James's review/approval must be presented as a review
     artifact per the contract above, generated into `.aio-review/` (never committed).
   - Never commit rendered HTML; never treat an HTML artifact as the source of truth;
     apply agreed changes to the md source, then re-render.
   - Plain-language decision docs keep the numbered-items convention (matches how James
     answers).
2. Add `.aio-review/` to `.gitignore` (service also self-heals it in Phase 2, mirroring
   `ensureLoopAttachmentsIgnored()`).
3. No changes to `_completed` conventions or evidence ladder.

## Phase 1 — `doc-review-artifact` skill (works everywhere, today)

New project skill `.claude/skills/doc-review-artifact/SKILL.md` (first project skill;
prose must follow `docs/prompt-engineering-house-style.md`). It instructs the agent to:

1. Take the md source (plan/spec/report/decision doc) — or write it first — and generate
   an artifact conforming to the contract: sections mapped to `data-review-item`,
   decision points numbered, comparisons rendered as tables/toggles where genuinely
   useful. Template + runtime live in the skill dir
   (`references/artifact-template.html`) so artifacts are consistent and the runtime is
   not re-invented per generation.
2. Write it to `<workspace>/.aio-review/<yyyy-mm-dd>-<slug>.html` and open it
   (`open <file>` on macOS).
3. Tell James it's ready, then **wait for decisions**: watch for
   `<artifact>.decisions.json` beside the artifact (James clicks "Export decisions" and
   saves into that folder) or accept the clipboard markdown pasted into chat.
4. Apply agreed changes to the **md source**, re-render, repeat until Overall=APPROVED.
   Never edit the HTML as if it were the document.

Acceptance for Phase 1: run the skill on a real plan; James reviews in the browser,
exports decisions; agent ingests them and updates the md source. No repo runtime code.

## Phase 2 — AIO-native review flow

Removes the manual export/paste hop: agents request a review via MCP, AIO surfaces it,
James reviews in-app (or pops out to browser), decisions are pushed straight back into
the instance.

### 2a. Main process — `DocReviewService`

`src/main/doc-review/doc-review-service.ts` — singleton (`getInstance()`,
`getDocReviewService()`, `_resetForTesting()`), logger `getLogger('DocReviewService')`.

State: `DocReviewSession` = `{ id, instanceId, workspacePath, title, artifactPath,
sourcePath?, status: 'pending' | 'approved' | 'changes_requested' | 'rejected',
comments: DocReviewComment[], decisions: DocReviewDecision[], createdAt, decidedAt? }`.

- Persistence: ElectronStore (`name: 'doc-reviews'`), pattern from
  `recent-directories-manager.ts:43–46`. Sessions are small and short-lived; prune
  decided sessions after 30 days. (Revisit SQLite only if we later want review history
  analytics.)
- `createSession()` validates `artifactPath` is inside the workspace's `.aio-review/`
  dir and the file parses as an artifact (has the `aio-doc-review` meta). Ensures
  `.aio-review/` is gitignored.
- `submitDecision(sessionId, decisions, overall, generalComment)` → renders the
  canonical feedback block → `instanceManager.sendInput(instanceId, block)` (same path
  as `INSTANCE_SEND_INPUT`) → marks session decided → emits changed event.
- EventEmitter `doc-review:changed` consumed by the IPC handler layer.

### 2b. MCP tools (how agents request a review)

Add `createDocReviewToolDefinitions()` in `src/main/mcp/doc-review-tools.ts`, registered
alongside existing instance-scoped tools in `orchestrator-tools-rpc-server.ts`:

- `request_doc_review` `{ artifact_path, title, source_path? }` → creates session for
  the calling instance, returns `{ reviewId }`. Fire-and-forget: the decision arrives
  later as a user-role message (the canonical block), which suits both interactive
  sessions and loops.
- `get_doc_review_result` `{ review_id }` → pull variant for agents that poll.

Document both in `docs/AIO_MCP_CLI.md` / `docs/llm/AIO_MCP_CLI_REFERENCE.md`.

### 2c. IPC domain (TODO-domain pattern)

- Channels `packages/contracts/src/channels/doc-review.channels.ts`:
  `DOC_REVIEW_LIST`, `DOC_REVIEW_GET`, `DOC_REVIEW_READ_ARTIFACT`,
  `DOC_REVIEW_SUBMIT_DECISION`, `DOC_REVIEW_DISMISS`, `DOC_REVIEW_OPEN_EXTERNAL`,
  event `DOC_REVIEW_CHANGED`. Export via `packages/contracts/src/channels/index.ts`.
- Zod schemas `packages/contracts/src/schemas/doc-review.schemas.ts`. **If a new
  `@contracts/...` subpath is added, update `tsconfig.json`,
  `tsconfig.electron.json`, `src/main/register-aliases.ts`, and `vitest.config.ts`**
  (AGENTS.md rule).
- Handlers `src/main/ipc/handlers/doc-review-handlers.ts`
  (`registerDocReviewHandlers({ windowManager })`; forward `doc-review:changed` via
  `windowManager.sendToRenderer(...)`). Register in `ipc-main-handler.ts`.
- Preload `src/preload/domains/doc-review.preload.ts`, merged into `preload.ts`.
- `DOC_REVIEW_READ_ARTIFACT` returns the artifact HTML string **only after re-validating
  the stored path** (no arbitrary file reads over this channel).
- `DOC_REVIEW_OPEN_EXTERNAL` uses `shell.openExternal`/`shell.openPath` on the validated
  artifact path (browser fallback keeps Phase 1 standalone mode working in-app).

### 2d. Renderer — `doc-review` feature

`src/renderer/app/features/doc-review/` (standalone, OnPush, signals; lazy route
`/doc-review` in `app.routes.ts`):

- `doc-review.store.ts` — injectable signal store: `sessions`, `pendingCount`
  (drives a badge in the shell nav), refresh on `DOC_REVIEW_CHANGED`.
- `doc-review-page.component.ts` — pending/decided list + selected review.
- `doc-review-viewer.component.ts` — hosts the artifact in
  `<iframe [attr.srcdoc]="html" sandbox="allow-scripts">` (**no
  `allow-same-origin`**), bridges `postMessage` (validate `event.source` is the iframe's
  `contentWindow`; ignore anything without the `aio-review/` type prefix).
- `doc-review-decision-bar.component.ts` — Angular-owned chrome: overall verdict
  buttons (Approve / Request changes / Reject), general comment box, per-item decision
  summary mirrored from iframe events, Submit → store → IPC.
- Follow `docs/angular-conventions.md` and existing shell/panel standards
  (`docs/shell-component-standards.md`).

### Security requirements (Phase 2 gate)

1. Artifact JS runs **only** inside `sandbox="allow-scripts"` iframes without
   `allow-same-origin` — no cookies, no `electronAPI`, no same-origin DOM access.
   Never render artifact HTML through `bypassSecurityTrustHtml` into the app DOM.
2. Main process treats artifact paths as untrusted: must resolve inside
   `<workspace>/.aio-review/`, reject symlinks escaping it, cap file size (reuse the
   25 MB attachment cap).
3. The feedback block sent to instances is plain text built by the service from
   structured decisions — never raw HTML from the artifact.
4. Artifacts must not be able to trigger IPC: only the postMessage bridge exists, and
   the host whitelists message types and shapes (Zod-parse the payloads).

## Phase 3 — Loop and approval integration

1. **`stop-needs-review` hook:** when a loop stops needing human review and has a
   `planFile`, the loop coordinator asks `DocReviewService` to create a session. If no
   HTML artifact exists, render the plan md → artifact using the same template
   (marked already ships in the renderer; add a small main-process md→artifact renderer
   in `src/main/doc-review/artifact-renderer.ts` reusing the skill's template).
2. **Approval record:** on APPROVED, write into `durable-approval-store.ts` (first
   renderer-visible use of it), so loop history can show who approved what and when.
3. **No evidence-ladder change in this plan.** Approval feeds back as a user message;
   the agent still completes via the existing Tier 2 path (`_completed` rename +
   verify). A follow-up may later treat an APPROVED doc-review as an explicit Tier 2
   input; that is out of scope here.

## Testing and verification

- **Phase 1:** manual acceptance (skill run on a real plan) + a template lint: a small
  vitest spec that loads `artifact-template.html` and asserts the contract markers
  (meta tag, runtime present, no `http(s)://` references).
- **Phase 2 unit tests (vitest, `_resetForTesting()` in `beforeEach`):**
  - `doc-review-service.spec.ts` — session lifecycle, path validation (rejects paths
    outside `.aio-review/`, symlink escape), feedback block rendering, prune logic.
  - `doc-review-handlers.spec.ts` — schema validation, event forwarding.
  - `doc-review-tools.spec.ts` — MCP tool arg parsing + happy path.
  - `doc-review.store.spec.ts` — renderer store state transitions.
- **Runtime check (per repo rule, before claiming done):** launch `npm run dev`, run an
  instance that calls `request_doc_review`, review + submit in the pane, confirm the
  feedback block arrives in the instance transcript, and confirm "Open in browser"
  standalone mode still exports decisions.
- **Gates after each phase:** `npx tsc --noEmit`, `npx tsc --noEmit -p
  tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`, `npm run test:quiet`.
- Keep every new file under the ts-max-loc cap; split the viewer bridge into its own
  file if needed.

## Risks / decided trade-offs

- **`srcdoc` + `sandbox="allow-scripts"` quirks in Electron:** verified posture is
  sandbox+contextIsolation, but test early that iframe scripts and postMessage behave
  under the app's session; fallback is always "Open in browser" (Phase 1 mode), so the
  feature degrades gracefully.
- **Interactivity vs sanitisation tension** is resolved by never mixing the two paths:
  DOMPurify pipeline for chat markdown, sandboxed iframe for artifacts.
- **Token cost of HTML generation** (~4–8× md) is confined to human-reviewed docs by
  policy; agent-consumed docs stay md.
- **Two "review" features** (cross-model `review` vs `doc-review`) — naming kept
  distinct in routes, channels, and folders.
- **ElectronStore vs SQLite** — ElectronStore chosen for MVP; migration path noted.

## File inventory (Phase 2)

| Area | Files |
|------|-------|
| Service | `src/main/doc-review/doc-review-service.ts`, `doc-review.types.ts`, `artifact-validator.ts` |
| MCP | `src/main/mcp/doc-review-tools.ts` (+ registration in `orchestrator-tools-rpc-server.ts`) |
| Contracts | `packages/contracts/src/channels/doc-review.channels.ts`, `packages/contracts/src/schemas/doc-review.schemas.ts` |
| IPC | `src/main/ipc/handlers/doc-review-handlers.ts` (+ `ipc-main-handler.ts` registration) |
| Preload | `src/preload/domains/doc-review.preload.ts` (+ `preload.ts` merge) |
| Renderer | `src/renderer/app/features/doc-review/` — page, viewer, decision-bar components, store, route entry |
| Skill | `.claude/skills/doc-review-artifact/SKILL.md`, `references/artifact-template.html` |
| Docs | `AGENTS.md` (formats section), `docs/AIO_MCP_CLI.md`, `docs/llm/AIO_MCP_CLI_REFERENCE.md` |

## Completion

Implement phases in order; run the canonical verification checklist and the real-UI
runtime check before marking each phase done. Rename this file with `_completed` only
after all in-scope phases are implemented and verified.
