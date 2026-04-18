# Click-to-Preview, Revive-on-Typing Design

**Status:** Design approved, pending implementation plan
**Date:** 2026-04-18
**Scope:** Renderer UX — instance list click behaviour and input-panel revival triggers

## Problem

Clicking a row in the instance list today causes expensive revival in two cases without the user asking:

1. **History entry (archived thread).** `instance-list.component.ts:1928` → `onRestoreHistory` → `historyStore.restoreEntry()` → IPC `HISTORY_RESTORE` → spawns a brand-new CLI adapter process, rehydrates the message buffer, re-establishes provider session, optionally falls back to replay. Triggered by a single click.
2. **Hibernated instance (live but sleeping).** The row's tooltip reads `"Hibernated — click to wake"` (`instance-row.component.ts:42, 46`) but clicking only calls `setSelectedInstance`. There is no renderer call site for `api.instance.wakeInstance()`. The tooltip is aspirational — the click does nothing.

Both behaviours are wrong. Case 1 burns resources for casual browsing; case 2 lies to the user about what clicking does.

## Goal

Make **click = cheap preview** and **first typing or paste = revival** for both history entries and hibernated instances. Revival must feel seamless: any keystrokes that land before the process is ready are buffered locally and flushed as the first message once revival completes.

## Non-Goals

- Changes to main-process lifecycle, IPC surface, or contract schemas.
- Changes to hibernation timing, session-continuity, or recovery recipes.
- Adding new provider-side "preview" support — preview is pure renderer state reading existing history data.
- Explicit "Resume" buttons or modal banners. The transition is silent.
- Changes to the active-instance row click behaviour (status = `idle|ready|busy|…`). Only hibernated and history-entry rows change.

## Decisions Summary

| Q | Decision |
| --- | --- |
| Revival trigger | **First `input` event** (typing, paste, IME composition end). Focus alone does not trigger revival — too many false positives from tab-through and programmatic focus. |
| Already-restored thread detection | **Yes.** Before previewing a history entry, match by `historyThreadId` against live instances; if one exists, select it instead of previewing. |
| State ownership | **Dedicated `RevivalPreviewService`** (new). `HistoryStore` stays a data store; preview UX state lives in its own injectable service. |
| Input-panel mode | **Generic `revivalTrigger` callback input**, not per-mode branching. Panel is agnostic to whether it is reviving a history entry or waking a hibernated instance. |
| Buffer handoff | **Service-owned, atomic.** Set `draftService.setDraft(newId, buffer)` *before* `setSelectedInstance(newId)` so input-panel re-binds with the draft already present. |
| Explicit UI affordance | **None.** Placeholder text reflects state (`"Resume this thread — start typing…"`). No banner, no button. |

---

## Architecture

### New injectable: `RevivalPreviewService`

Path: `src/renderer/app/core/services/revival-preview.service.ts`

Single source of truth for "something is being previewed or revived." Signal-based, Angular-injectable.

```ts
@Injectable({ providedIn: 'root' })
export class RevivalPreviewService {
  previewedEntryId = signal<string | null>(null);
  previewedConversation = signal<ConversationData | null>(null);
  pendingDraft = signal<string>('');
  revivalState = signal<'idle' | 'preview' | 'reviving' | 'failed'>('idle');
  revivalError = signal<string | null>(null);

  async previewEntry(entryId: string): Promise<void>;  // loads via historyStore.loadConversation
  clearPreview(): void;                                // called on any setSelectedInstance(non-null)
  async revive(): Promise<void>;                       // the generic revival trigger
  setPendingDraft(text: string): void;
}
```

**`previewEntry(entryId)`:**
1. Short-circuit if an already-restored live instance exists with matching `historyThreadId` — call `instanceStore.setSelectedInstance(liveId)` and return.
2. Otherwise: `historyStore.loadConversation(entryId)` (IPC `HISTORY_LOAD`, read-only, cheap).
3. Set `previewedEntryId`, `previewedConversation`, `revivalState = 'preview'`.
4. Clear `selectedInstanceId` (mutually exclusive states).

**`revive()`:**
1. Guard: if `revivalState !== 'preview'`, noop. Prevents double-fire from rapid `input` events.
2. Transition `revivalState = 'reviving'`.
3. Capture `entryId = previewedEntryId()` and `buffer = pendingDraft()`.
4. Call `historyStore.restoreEntry(entryId, entry.workingDirectory)`.
5. On success:
   - `draftService.setDraft(result.instanceId, buffer)` — **first**, so the draft is present when input-panel re-binds.
   - `instanceStore.setSelectedInstance(result.instanceId)` — triggers the detail-pane switch from preview view to live view.
   - Clear preview state (`previewedEntryId = null`, `revivalState = 'idle'`).
6. On failure: `revivalState = 'failed'`, surface `revivalError`. Preview remains so the user can retry. Buffer stays intact.

**`clearPreview()`:**
Called by any `setSelectedInstance(non-null id)` — wired via an effect or via direct invocation from `InstanceStore.setSelectedInstance`. Clears all preview signals. Does **not** cancel an in-flight `revive()` — that promise completes, lands idle, gets auto-hibernated later by the existing idle monitor.

### New input-panel input: `revivalTrigger`

Path: `src/renderer/app/features/instance-detail/input-panel.component.ts`

```ts
revivalTrigger = input<(() => Promise<void>) | null>(null);
```

Behaviour change:
- When `revivalTrigger()` is non-null, the textarea is **enabled** (not disabled like the existing `isInitializing` path), but any first `input` event invokes the trigger — guarded by a local `triggerInFlight` signal so multiple rapid events coalesce into one call.
- `triggerInFlight` is panel-local and unrelated to the service's `revivalState`. The panel only knows "has my trigger been invoked yet on this mount"; the service owns the broader `idle|preview|reviving|failed` state.
- Placeholder override: `"Resume this thread — start typing…"` when `revivalTrigger()` is non-null and the instance is hibernated or in preview mode.
- The textarea value remains editable during and after revival — the buffered text is written to the appropriate draft store as the user types:
  - History preview case: `RevivalPreviewService.setPendingDraft()`.
  - Hibernated case: `draftService.setDraft(instanceId, text)` (the draft key already exists for the live instance).

This keeps input-panel agnostic to revival semantics — it just knows "when the user produces content for the first time, call the trigger."

### `InstanceDetailComponent` render branches

Current:
```
@if (instance()) { <live view> }
@else { <welcome> }
```

New:
```
@if (instance()) { <live view> }
@else if (previewService.previewedConversation()) { <preview view> }
@else { <welcome> }
```

**Preview view composition:**
- `<app-instance-header>` in a read-only variant: shows title, provider badge, disabled action buttons. No model selector, no YOLO toggle.
- `<app-output-stream>` fed from `previewService.previewedConversation().messages` — same component, different source.
- `<app-input-panel>` with `revivalTrigger` bound to `() => previewService.revive()`.

**Live view (unchanged for active instances; new input-panel wiring for hibernated):**
- When `instance().status === 'hibernated'`, bind `revivalTrigger` to `() => api.instance.wakeInstance({ instanceId: instance().id })`. The existing send-queue (`instance-messaging.store.ts:201-207`) handles `waking` status — buffered messages flush when the instance reaches `ready`/`idle`.
- When status is `initializing|waking|respawning|…` → no `revivalTrigger` (existing `isInitializing` path continues to disable input during the transition).
- All other statuses: no `revivalTrigger`, normal input behaviour.

### Click handlers

**`onRestoreHistory` renamed to `onPreviewHistory`** in `instance-list.component.ts:1928`:
```ts
async onPreviewHistory(entryId: string): Promise<void> {
  this.closeProjectMenu({ restoreFocus: false });
  await this.previewService.previewEntry(entryId);
}
```
No IPC `HISTORY_RESTORE` call here. No `restoringHistoryIds` bookkeeping (moved to the service if needed).

**`onSelectInstance` (`instance-list.component.ts:1675`):**
Unchanged in signature. Add one line: `this.previewService.clearPreview()` before `setSelectedInstance`. Alternatively, call `clearPreview` from inside `InstanceStore.setSelectedInstance` — cleaner; single call site.

### Tooltip updates

`instance-row.component.ts:42, 46`:
- `"Hibernated — click to wake"` → `"Hibernated — start typing to resume"`

---

## Edge Cases

**User clicks preview, then clicks a live instance before typing.**
`setSelectedInstance` clears preview. No restore fires. Zero cost.

**User clicks preview, types, then clicks away mid-revive.**
`revive()` is already in flight. Let it complete. New instance lands idle; auto-hibernation handles it later. User sees no error because the selection has moved on. Acceptable.

**User clicks the same preview entry twice quickly.**
First click fires `previewEntry`. Second click short-circuits because `previewedEntryId` already matches. If the first load is still in flight, guard inside `previewEntry` via a local `loadingEntryId` flag.

**User previews entry A, types buffer, clicks entry B without typing.**
`previewEntry(B)` clears `previewedEntryId = A` and replaces with B. `pendingDraft` is cleared too — A's typed buffer is lost. Intentional: the user switched context.

**User previews an entry whose thread is already live.**
`previewEntry` detects via `historyThreadId`, calls `setSelectedInstance(liveId)` instead. No preview, no duplicate spawn.

**User focuses the input without typing (e.g. tabs through), then clicks away.**
No revival (focus is not the trigger). Zero cost.

**User pastes into the input.**
`input` event fires. Revival triggers. Pasted content ends up in the buffer, flushed as the first message. Seamless.

**Revive fails (provider down, replay fallback exhausted).**
`revivalState = 'failed'`, `revivalError` populated. Preview view stays mounted. User sees an inline error near the input; buffer is preserved so they can retry by typing another key (or the input-panel exposes a one-click retry).

**Hibernated instance wakes while a second click fires `wakeInstance` again.**
Guarded in `input-panel` via `revivalInFlight` signal. Main-side `wakeInstance` also rejects if status is not `hibernated` (line 1697 in `instance-lifecycle.ts`) — belt-and-braces.

**User types in hibernated instance, wake fails, status reverts to `hibernated`.**
Existing send-queue retry logic (`instance-messaging.store.ts:281-350`) handles transient failures. `revivalInFlight` should clear on failure so a subsequent keystroke retries.

**Remote-node disconnected hibernated instance.**
`wakeInstance` will fail fast on the worker-agent side. Same failure path as above.

---

## Files Touched

**New:**
- `src/renderer/app/core/services/revival-preview.service.ts` — the new service.

**Modified (renderer only):**
- `src/renderer/app/features/instance-list/instance-list.component.ts` — rename `onRestoreHistory` → `onPreviewHistory`; strip spawn call; remove `restoringHistoryIds` bookkeeping.
- `src/renderer/app/features/instance-list/instance-row.component.ts` — tooltip strings (lines 42, 46).
- `src/renderer/app/core/state/history.store.ts` — no API changes; expose `loadConversation` return shape to the preview service.
- `src/renderer/app/core/state/instance/instance.store.ts` — call `previewService.clearPreview()` inside `setSelectedInstance` when id is non-null.
- `src/renderer/app/features/instance-detail/instance-detail.component.ts` — add preview branch; wire `revivalTrigger` for hibernated + preview cases.
- `src/renderer/app/features/instance-detail/input-panel.component.ts` — add `revivalTrigger` input; add `input`-event handler that invokes the trigger once; placeholder override.

**Unchanged:**
- All main-process code.
- All IPC handlers, channels, and schemas.
- `@contracts/*` packages.
- Preload surface.
- `instance-selection.store.ts`.
- `session-continuity.ts`, `hibernation-manager.ts`, `instance-lifecycle.ts`.

---

## Testing Plan

**Unit / store tests:**
- `revival-preview.service.spec.ts` (new)
  - `previewEntry` short-circuits to `setSelectedInstance` when a live instance has matching `historyThreadId`.
  - `previewEntry` loads conversation and sets preview state when no live match.
  - Second `previewEntry` call with the same id is a noop.
  - `revive()` guards against double-fire via `revivalState` check.
  - `revive()` sets draft before selection (verify call order via mock).
  - `revive()` on failure preserves `pendingDraft`.
  - `clearPreview()` resets all signals but does not abort in-flight `revive()`.

**Component tests:**
- `input-panel.component.spec.ts`
  - First `input` event with `revivalTrigger` set fires the trigger exactly once.
  - Subsequent `input` events during revival do not re-fire the trigger.
  - Focus without input does not fire the trigger.
  - Paste event fires the trigger.
  - Textarea is enabled when `revivalTrigger` is set (distinct from `isInitializing` which disables).

- `instance-list.component.spec.ts`
  - Clicking a history entry calls `previewService.previewEntry`, not `historyStore.restoreEntry`.
  - Clicking a live instance clears preview.
  - `onPreviewHistory` does not spawn an instance (assert `restoreEntry` mock never called).

- `instance-detail.component.spec.ts`
  - Preview view renders when `previewedConversation()` is non-null and no `selectedInstance`.
  - `revivalTrigger` is bound to preview service's `revive` in preview view.
  - `revivalTrigger` is bound to `wakeInstance` IPC in live view when status is `hibernated`.

**Integration / e2e-ish:**
- Preview → type → revival happy path: verify buffer is flushed as first message to the new live instance.
- Preview → click away before typing: verify no IPC call.
- Hibernated → type → wake + send: verify buffered message arrives at the CLI after wake.

---

## Rollout / Verification

1. `npx tsc --noEmit` and `npx tsc --noEmit -p tsconfig.spec.json` pass.
2. `npm run lint` passes.
3. Vitest green for all new and modified spec files.
4. Manual smoke in dev build:
   - Click 3 history entries in succession — verify no new instances appear in the list.
   - Click one, start typing — verify the live instance appears and the typed text is the first message.
   - Click a hibernated instance — verify tooltip update, no wake.
   - Start typing in that pane — verify status transitions to `waking` then `ready`, and the message is sent.
   - Preview an entry whose thread is already live — verify the live instance is selected directly (no preview).

## Open Risks

- **Hidden consumers of `onRestoreHistory`.** The rename is local, but if a keyboard shortcut, menu item, or test harness invokes `restoreEntry` directly, the new preview semantics won't apply. Mitigation: grep for `restoreEntry` callers during implementation; route them through the service if appropriate.
- **Draft service coupling.** `draftService.setDraft(id, text)` assumes the id exists. If it's called before the `instance:created` event lands in the renderer store, the draft may be dropped. Mitigation: verify by reading `draftService` internals during implementation; if needed, buffer drafts keyed by preview id and migrate on creation.
- **Effect-based `clearPreview`.** Wiring it via an Angular effect on `selectedInstanceId` risks feedback loops. Safer: explicit call inside `InstanceStore.setSelectedInstance`.
