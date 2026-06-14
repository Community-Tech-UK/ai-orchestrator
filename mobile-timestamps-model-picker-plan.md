# Mobile app: message timestamps + proper model picker

Date: 2026-06-11
Status: PLANNED (not started)

Two independent features for the iPhone control app (`apps/mobile`) and its
Mobile Gateway backend (`src/main/mobile-gateway/`).

---

## Investigation summary (what exists today)

### Timestamps
- `MobileMessageDto.timestamp: number` **already flows end-to-end**:
  - Live transcript: `serializeMessage()` maps `message.timestamp`
    (`mobile-gateway-serializers.ts:108`).
  - History transcript: maps `createdAt` (`:179`).
  - Optimistic local echo in `gateway-client.service.ts` stamps `Date.now()`.
- The UI simply never renders it. `conversation.component.ts` and
  `history-detail.component.ts` both render bubbles with no time info.
- Both components contain a **duplicated** `displayItems()` fold (collapsing
  consecutive tool calls into one expandable group). Timestamps rows need to be
  inserted into that same fold, so this is the moment to deduplicate it.

### Model picker
- New-session screen (`new-session.component.ts`) has a **free-text** model
  input ("e.g. opus / gpt-5.3-codex"). No list, no validation, no defaults.
- Gateway `POST /api/instances` already accepts `model` and passes it as
  `modelOverride` (`mobile-gateway-server.ts:1257`); backend spawn-time
  validation/normalisation already exists.
- Source of truth for pickable models (what the desktop compact picker uses):
  - Static curated catalog `PROVIDER_MODEL_LIST` / `getModelsForProvider()` in
    `src/shared/types/provider.types.ts` (`ModelDisplayInfo { id, name, tier,
    pinned?, family? }`).
  - **Dynamic** lists for `copilot` and `cursor` only, queried from the
    installed CLI (`CopilotCliAdapter/CursorCliAdapter.listAvailableModels()`,
    adapter-cached). Pattern already exists in main:
    `getKnownModelsForCli()` in
    `src/main/instance/lifecycle/create-validation-helpers.ts` (ids only).
  - The renderer overlay (`mergeStaticMetadata` in
    `apps/../models/dynamic-model-catalog.service.ts`) merges static
    tier/family/pinned onto live entries.
- **Mid-session model switching exists in the backend**:
  `instanceManager.changeModel(instanceId, newModel, reasoningEffort?)`
  (`instance-manager.ts:1311` → `instance-lifecycle.ts:2834`). It validates the
  model per provider (dynamic list for copilot/cursor), throws a human-readable
  error when the instance status disallows switching
  (`getModelSwitchUnavailableReason`), and handles resume/replay continuity.
  The gateway does not expose it.
- `MobileInstanceDto.model` is already serialized (`serializeInstance` maps
  `instance.currentModel`), so the phone already knows each session's model —
  it just doesn't display it.

### Constraints discovered
- **LOC ratchet**: `mobile-gateway-server.ts` is at 1377 lines with a cap of
  **1378** (`scripts/check-ts-max-loc.ts:125`). New endpoints cannot be added
  inline — they must live in a new handlers module (follow the existing
  `mobile-gateway-history-handlers.ts` pattern), and even the route-dispatch
  lines in the server file need offsetting (extract the model routes into a
  delegated `handleModelRoutes(...)` so the server file gains ~3 lines, and
  trim/justify as needed).
- DTOs are mirrored by hand: `src/shared/types/mobile-gateway.types.ts` ↔
  `apps/mobile/src/app/core/models.ts` (header comment in models.ts mandates
  keeping both in sync).
- `apps/mobile` is a standalone package (own `node_modules`); it cannot import
  from `src/shared`. Verification there is `npm run typecheck` + `npm run lint`
  (no test runner configured).

---

## Feature 1 — Message timestamps

No backend changes. UI-only, in `apps/mobile`.

### Design
iMessage-style, low-noise:
- **Time separators**, not per-bubble labels: insert a centered stamp row when
  the gap since the previous message exceeds 15 minutes, and always at day
  boundaries. Label format: `Today 14:32`, `Yesterday 09:05`, else
  `Mon 8 Jun, 14:32` (device locale via `Intl.DateTimeFormat`).
- Guard: skip stamp rows for messages with falsy/zero `timestamp`.

### Tasks
1. **Extract the shared transcript fold.** New
   `apps/mobile/src/app/shared/transcript-items.ts` (or `core/`):
   - Move the `DisplayItem` type + tool-folding logic (currently duplicated in
     `conversation.component.ts:284` and `history-detail.component.ts`) into a
     pure function `buildDisplayItems(messages: MobileMessageDto[]): DisplayItem[]`.
   - Extend `DisplayItem` with `{ kind: 'stamp'; id: string; label: string }`
     and insert stamp rows per the design above (15-min gap + day boundary).
   - Pure date-label helper `formatStampLabel(ts: number, now: number)` so it
     stays trivially testable later.
2. **Conversation screen** (`conversation.component.ts`): use the shared
   builder; render `kind === 'stamp'` rows as a centered, small,
   `--text-secondary` label (match the existing `.t-system` styling scale).
   `trackItem` returns the stamp id.
3. **History detail** (`history-detail.component.ts`): same change.
4. Stamp rows must not break the tool-group folding (a stamp between two tool
   calls splits the group — acceptable and correct).

---

## Feature 2 — Proper model picker

### 2a. Gateway: model catalog endpoint

1. **Shared DTO** (`src/shared/types/mobile-gateway.types.ts`):
   ```ts
   export interface MobileModelDto {
     id: string; name: string;
     tier: 'fast' | 'balanced' | 'powerful';
     pinned?: boolean; family?: string;
   }
   export type MobileModelCatalog = Record<string, MobileModelDto[]>; // provider → models
   ```
2. **New handlers module** `src/main/mobile-gateway/mobile-gateway-model-handlers.ts`:
   - `GET /api/models` → full catalog for the providers in `VALID_PROVIDERS`
     (minus `auto`): static `getModelsForProvider(p)` for claude/codex/gemini;
     for copilot/cursor, query the CLI adapters' `listAvailableModels()`
     (mirroring `getKnownModelsForCli`, but keeping display info and overlaying
     static `tier/family/pinned` like the renderer's `mergeStaticMetadata`),
     falling back to the static list when the CLI is unreachable.
   - Cache the dynamic lists in-module (~5 min TTL, matching the renderer) so a
     phone opening the picker repeatedly doesn't shell out each time.
   - Keep the adapter import lazy/structural so the gateway module doesn't pull
     adapter weight at startup (check how history handlers inject deps —
     inject a `listDynamicModels(provider)` function in the handler context,
     defaulting to the adapter call; tests pass a stub).
3. **Route dispatch** in `mobile-gateway-server.ts`:
   `segments[1] === 'models' && method === 'GET'` → delegate. **Watch the
   1378-line ratchet** — extract enough into the new module that the server
   file stays under the cap (acceptable alternative: raise the entry only if
   genuinely justified; prefer extraction).

### 2b. Gateway: mid-session model change

1. Add to `GatewayInstanceSource` (structural — real `InstanceManager` already
   satisfies it):
   ```ts
   changeModel(instanceId: string, newModel: string): Promise<Instance>;
   ```
2. `POST /api/instances/:id/model` `{ model: string, idempotencyKey? }` in the
   new handlers module:
   - 404 when instance unknown (same pattern as rename).
   - Call `changeModel`; map a thrown "switch unavailable" error to **409**
     with the error message as `{ error }` (the phone shows it verbatim).
   - Idempotency-key dedupe like interrupt/terminate (B2 pattern,
     `IdempotencyStore.compose('change-model', instanceId, key)`).
   - Success returns `serializeInstance(updated)`. Snapshot broadcast happens
     automatically via the state-update listeners (changeModel transitions
     state), so no manual broadcast needed — verify in tests.

### 2c. Mobile app: picker UI

1. **Mirror DTOs** into `apps/mobile/src/app/core/models.ts`
   (`MobileModelDto`, `MobileModelCatalog`).
2. **GatewayClient**: add `models(): Promise<MobileModelCatalog>` (GET
   `/api/models`) with a session-lifetime signal cache + `changeModel(
   instanceId, model)` (POST). Invalidate the models cache on host change
   (in `connect()`).
3. **Shared model-sheet component**
   `apps/mobile/src/app/shared/model-sheet.component.ts`: bottom-sheet/list for
   one provider's models — pinned entries first ("Latest"), then the rest
   grouped by `family` under "Other versions" (collapsed by default), plus a
   "Default (auto)" row meaning *no override*. Emits the chosen model id (or
   `undefined` for default).
4. **New-session screen**: replace the free-text model input with a button row
   showing the current selection ("Default" initially) that opens the model
   sheet for the selected provider. Reset the selection when the provider
   changes. Hide the model row entirely when provider is `auto`. Keep the
   request contract unchanged (`model: string | undefined`).
5. **Conversation screen**:
   - Show the current model in the subheader (e.g. `· opus-latest`), from
     `instance().model` — already in the snapshot.
   - Add "Change model…" to the ⋯ popover → opens the model sheet for
     `instance().provider`; on pick, call `gateway.changeModel()`; on failure
     (409 busy etc.) surface the error text (reuse the existing error styling /
     `alert` consistent with current rename/terminate UX simplicity).

---

## Out of scope (deliberate)
- Reasoning-effort picker (backend supports it; phone UX TBD separately).
- models.dev / API-provider models in the phone catalog — phone sessions are
  CLI instances; only CLI-launchable models are offered (matches desktop
  compact picker behaviour).
- Timestamps in the sessions/history *list* rows (already show relative
  activity via `lastActivity`).

## Risks / gotchas
- **LOC ratchet on mobile-gateway-server.ts (1377/1378)** — the plan's main
  structural constraint; all new logic goes into the new handlers module.
- Dynamic copilot/cursor lists shell out to installed CLIs; must be cached and
  failure-tolerant (static fallback) so the picker never blocks pairing-fresh
  hosts without those CLIs.
- `changeModel` replaces the adapter (terminate + respawn with resume/replay);
  calling it while busy is rejected by `getModelSwitchUnavailableReason` —
  surfaced as 409, not silently queued.
- DTO mirror drift: update **both** `src/shared/types/mobile-gateway.types.ts`
  and `apps/mobile/src/app/core/models.ts` in the same change.

## Verification checklist
Main repo:
- [ ] `npx tsc --noEmit` and `npx tsc --noEmit -p tsconfig.spec.json`
- [ ] `npm run lint` (ng lint + oxlint — not raw eslint)
- [ ] `npm run check:ts-max-loc` (the gateway server file is the hot spot)
- [ ] New vitest specs in `mobile-gateway-model-handlers.spec.ts` (or extend
      `mobile-gateway-server.spec.ts`): GET /api/models (static + dynamic stub
      + fallback), POST model change (success / 404 / 409 / idempotent dupe)
- [ ] Run the existing `mobile-gateway-server.spec.ts` suite

Mobile app (`apps/mobile`):
- [ ] `npm run typecheck`, `npm run lint`
- [ ] Manual: `ng serve` against a live host — new-session picker per provider,
      timestamps in live + history transcripts, mid-session model change while
      idle and the 409 path while busy
- [ ] Device pass via `npm run ios` (Capacitor) before calling it done
