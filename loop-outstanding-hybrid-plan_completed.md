# Loop Outstanding Items — Full Hybrid (capture + UI + export)

Date: 2026-06-06
Status: in progress (untracked until implemented + verified)

## Problem

When a loop ends `completed-needs-review`, the agent writes `OUTSTANDING.md`
(`## Needs human`, `## Open questions`) into the hidden per-run dir
`.aio-loop-state/<loopRunId>/OUTSTANDING.md`. Today this content is only read as
a *boolean* (`outstandingHasHumanItems`) to choose the terminal status. The item
text is never parsed, persisted, or surfaced — so the human-gated work is
effectively lost in a hidden dir + a buried chat message.

## Design (source of truth = structured DB + aggregated UI; markdown = export)

### Layer 1 — Parse (pure)
`src/main/orchestration/loop-stage-markdown.ts`
- Add `parseOutstandingSections(raw): { needsHuman: string[]; openQuestions: string[] }`.
- Refactor `outstandingHasHumanItems` to reuse it.

### Layer 2 — Types
- `src/shared/types/loop.types.ts`: add `LoopOutstanding { needsHuman: string[]; openQuestions: string[]; raw: string; capturedAt: number }`; add `outstanding?: LoopOutstanding` to `LoopState`.
- New aggregated item type `LoopOutstandingItem` (id, loopRunId, chatId, workspaceCwd, kind, text, status, loopStatus, createdAt, updatedAt, resolvedAt).
- `src/shared/types/loop-stream.types.ts`: add `openOutstandingCount?` to `LoopRunSummary` (optional, for past-runs badge).

### Layer 3 — Capture
- Coordinator `terminate()`: best-effort sync read + parse of OUTSTANDING.md (deterministic path via `resolveLoopArtifactPaths`); set `state.outstanding`. Cold path, tiny file.
- `loop-handlers.ts` terminal `loop:state-changed`: persist items via `store.saveOutstandingItems(state)`; emit `LOOP_OUTSTANDING_CHANGED`.

### Layer 4 — Persist
- `loop-schema.ts`: migration v5 `loop_outstanding_items` table + indexes.
- `loop-store.ts`: `saveOutstandingItems(state)` (upsert, preserve status on conflict), `listOutstandingItems({workspaceCwd?,status?,limit})`, `setOutstandingItemStatus(id,status)`, `countOpenOutstanding(workspaceCwd?)`.
- Stable item id = sha256(loopRunId|kind|text).

### Layer 5 — Chat summary
- `loop-chat-summary.ts`: append `Needs human` / `Open questions` sections from `state.outstanding` to the terminal summary content.

### Layer 6 — Export (derived artifact)
- `loop-outstanding-export.ts`: `buildOutstandingMarkdown(items)` + write to `<workspaceCwd>/OUTSTANDING.md` (consolidated, open items grouped by run). Triggered on demand from UI.

### Layer 7 — IPC plumbing
- channels: `LOOP_LIST_OUTSTANDING`, `LOOP_SET_OUTSTANDING_STATUS`, `LOOP_EXPORT_OUTSTANDING`, event `LOOP_OUTSTANDING_CHANGED`.
- zod schemas in `loop.schemas.ts`; handlers in `loop-handlers.ts`; preload `loop.preload.ts`; `loop-ipc.service.ts`.

### Layer 8 — Renderer
- `loop.store.ts`: outstanding signals + `loadOutstanding`, `setOutstandingStatus`, `exportOutstanding`, wire `onOutstandingChanged`.
- New `loop-outstanding-panel.component.ts` (standalone, OnPush): grouped list, resolve/dismiss, export button, open/all filter.
- Wire as inspector toggle in `instance-detail` with badge count.

## Verification
- `npx tsc --noEmit` + `-p tsconfig.spec.json`
- `npm run lint`
- unit tests: parser, store DAO, export builder
- fresh-eyes review of integration wiring
