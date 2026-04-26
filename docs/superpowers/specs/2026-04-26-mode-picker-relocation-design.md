# Mode Picker Relocation — Sidebar to New-Session Composer

**Date:** 2026-04-26
**Status:** Design

## Problem

The sidebar header currently has a large "+" gradient button paired with a wide outlined "Build ▾" agent-mode dropdown. This pair has three problems:

1. **Visual heaviness disproportionate to function.** The gradient "+" is the most visually loud control in the rail; it just opens the welcome screen.
2. **Confusing peer relationship.** "+" and the mode picker sit side-by-side as visual peers, but the dropdown is actually a *modifier* of "+". They look co-equal but aren't.
3. **The dropdown is silently broken on the most common path.** Tracing the code:
   - `sidebar-header.component.ts` hosts `<app-agent-selector>`
   - `<app-agent-selector>` writes to `AgentStore.selectedAgentId` (persisted)
   - The welcome screen's send button calls `instanceListStore.createInstanceWithMessage(...)`
   - `createInstanceWithMessage` does **not** accept an `agentId` parameter
   - `InstanceCreateWithMessagePayloadSchema` does **not** include `agentId`
   - `instance-handlers.ts` `INSTANCE_CREATE_WITH_MESSAGE` handler does **not** pass `agentId` to `instanceManager.createInstance({...})`

   Result: setting "Plan" in the sidebar and then sending a message from the welcome screen still launches the session as Build. The picker only affects the (rarely used) "create empty instance" path that `createInstance(config)` flows through.

User confirms they almost never switch modes anyway — so the picker doesn't deserve prime real estate, *and* the wiring needs fixing for the rare time they do switch.

## Goals

1. Replace the giant "+" + Build pair in the sidebar with a single header-action "+" icon button consistent with History/Settings.
2. Move the agent-mode picker into the new-session composer toolbar, alongside the existing provider and YOLO controls.
3. Plumb `agentId` end-to-end through the `createInstanceWithMessage` path so the picker actually takes effect.
4. Default the mode to Build on every new session draft.

## Non-goals

- Redesigning the agent-mode dropdown menu itself (Build / Plan / Review / Retriever stay; their colors and copy stay).
- Removing or changing `AgentStore` — it still backs CLI preferences (model/timeout/personality/path).
- Adding a per-project default mode, mode keyboard shortcut, or mode in the post-creation instance header. These are out of scope.
- Changing the empty-instance creation path (`createInstance(config)`); that already plumbs `agentId` correctly.

## Design

### A. Sidebar header — collapse the launch row

`src/renderer/app/features/dashboard/sidebar-header.component.ts`

```
OPERATOR WORKSPACE          [⏱] [⚙] [⊕]
Projects
```

- Delete the entire `.launch-row` block, including `<app-agent-selector />` and the gradient `.btn-create` button.
- Add a third button to `.header-actions` for "Create new session", emitting the existing `createClicked` output.
- The new "+" button uses the existing `.btn-header-icon` class plus a new `--primary` modifier:
  - Background: `rgba(var(--primary-rgb), 0.12)`
  - Border: `rgba(var(--primary-rgb), 0.4)`
  - Icon color: `var(--primary)` default, `var(--text-primary)` on hover
  - Same 34×34 size and pill radius as History/Settings — visual parity within the action row
- Drop the `AgentSelectorComponent` import from this file's `imports` array.
- Drop the now-unused `.btn-create`, `.btn-icon`, and `.launch-row` rules from `sidebar-header.component.scss`.

### B. New-session composer — add a Mode pill

`src/renderer/app/features/instance-detail/input-panel.component.html`

Inside the existing `@if (isDraftComposer()) { <div class="composer-toolbar draft-mode"> ... <div class="default-controls"> ... }` block, insert `<app-agent-selector>` between the provider selector and the YOLO toggle:

```html
<app-provider-selector ... />
@if (selectedProvider() === 'copilot') { <app-copilot-model-selector ... /> }
<app-agent-selector
  [selectedAgentId]="selectedAgentId()"
  (agentSelected)="onAgentSelected($event)"
/>
<button class="yolo-toggle" ... > ... </button>
```

The pill order — provider · model (when relevant) · mode · YOLO — groups *who* (provider/model), *how* (mode), *risk* (YOLO).

`src/renderer/app/features/instance-detail/input-panel.component.ts`
- Add `AgentSelectorComponent` to `imports`.
- Add a `selectedAgentId` computed that returns `newSessionDraft.agentId()`. The draft state guarantees a non-empty string id after hydration / `createEmptyDraft()` (see section D), so no fallback is needed. The non-draft branch is unreachable because the toolbar block is gated by `@if (isDraftComposer())`.
- Add `onAgentSelected(agent: AgentProfile)` that calls `newSessionDraft.setAgentId(agent.id)`.

### C. AgentSelectorComponent — make it a controlled component, restyle to a pill

`src/renderer/app/features/agents/agent-selector.component.ts`

The component currently is dual-purpose: it both reads/writes `AgentStore.selectedAgentId` and emits `agentSelected`. After this change it has one consumer (the composer), and the composer owns the state via `NewSessionDraftService`. Convert it to a fully controlled component:

- Add a required `selectedAgentId` input.
- Remove the `agentStore` injection and the `selectedAgent`/`allAgents` reads from the store. Read directly from `BUILTIN_AGENTS` (rationale for built-ins-only is below).
- Remove the `this.agentStore.selectAgent(agent.id)` call from `selectAgent()`. Just emit `agentSelected`; the parent persists.
- The dropdown markup, anchoring (`top: 100%; left: 0`), click-outside behavior, and ESC handler stay as-is.

**Custom agents — deliberate scope cut.** Custom markdown agents *are* a real feature: `src/main/agents/agent-registry.ts` loads project- and user-defined markdown agent definitions, and `src/renderer/app/features/settings/ecosystem-settings-tab.component.ts` exposes a UX for browsing them. However, the renderer-side `AgentStore._customAgents` is never populated from main today — `addCustomAgent()` exists but has no caller — so even the current sidebar selector only shows built-ins in practice. This change preserves that status quo: the composer pill shows `BUILTIN_AGENTS` only. Wiring custom agents through to the picker requires plumbing main → renderer, which is a separate piece of work and is intentionally out of scope here.

Restyle the trigger to match the composer pill aesthetic:
- Height ~32px (matches the YOLO toggle and provider selector)
- Padding `6px 10px`, gap `6px`
- Background: transparent default, `var(--bg-tertiary)` on hover
- Border: 1px solid using the selected agent's `color` (matches today's behavior — green for Build, indigo for Plan, etc.)
- Border radius: 6px (already)
- Font size 13px (already)

### D. NewSessionDraftService — add `agentId` to the draft state

`src/renderer/app/core/services/new-session-draft.service.ts`

The service is a **single state signal** that holds per-directory `NewSessionDraftState` records inside a `drafts: Record<string, NewSessionDraftState>` map (line 12). All field mutations route through `updateActiveDraft()`, and persistence is via `hydrateDraft()` / `persistState()`. The new `agentId` follows that pattern — it is **not** a separate top-level signal.

- Add `agentId: string` to the `NewSessionDraftState` interface.
- Add `agentId?: string` to `PersistedNewSessionDraft` (optional in storage so older persisted records hydrate cleanly).
- Update `createEmptyDraft()` to initialize `agentId: getDefaultAgent().id` (`'build'`).
- Update `hydrateDraft()` to accept the persisted value when it is a non-empty string matching a known agent id; otherwise fall back to `getDefaultAgent().id`. (Validate against `BUILTIN_AGENTS` ids; ignore unknown ids defensively, since custom agents in `AgentStore._customAgents` are not yet wired through here — see section C.)
- Add a public `readonly agentId = computed(() => this.activeDraft().agentId)` next to the existing `readonly provider`, `readonly model`, etc.
- Add `setAgentId(agentId: string): void` that uses `updateActiveDraft((draft) => ({ ...draft, agentId, updatedAt: Date.now() }))`, mirroring `setProvider` / `setModel`.

**Reset semantics — explicit decision.** `clearActiveComposer()` (line 258) currently clears `prompt` + `pendingFolders` + pending files but **intentionally preserves** `provider` / `model` / `yoloMode` / `nodeId`. The existing test asserts this preservation (`new-session-draft.service.spec.ts:31`). Mode picker behavior should diverge: per the goal "default Build on every new session draft," agentId should **reset to `getDefaultAgent().id` after a successful launch and on explicit discard** — but provider/model behavior is unchanged.

Implementation: extend `clearActiveComposer()` to also reset `agentId: getDefaultAgent().id`. This is reached on both successful launch (called from `welcome-coordinator.service.ts:206`) and discard. Update the existing spec test to assert the new behavior — agentId clears even though provider/model do not.

### E. Plumb `agentId` through `createInstanceWithMessage`

The chain (renderer → preload → IPC handler → instanceManager) currently drops `agentId`. Add it at every layer:

1. **`packages/contracts/src/schemas/instance.schemas.ts`**
   Add `agentId: z.string().max(100).optional()` to `InstanceCreateWithMessagePayloadSchema`.

2. **`src/preload/domains/instance.preload.ts`**
   Add `agentId?: string` to the `createInstanceWithMessage` payload type.

3. **`src/main/ipc/handlers/instance-handlers.ts`**
   In the `INSTANCE_CREATE_WITH_MESSAGE` handler, pass `agentId: validated.agentId` to `instanceManager.createInstance({...})`. The instance manager already accepts `agentId` (used by the empty-create path).

4. **`src/renderer/app/core/services/ipc/instance-ipc.service.ts`**
   Add `agentId?: string` to `CreateInstanceWithMessageConfig`. The body passes it through unchanged.

5. **`src/renderer/app/core/state/instance/instance-list.store.ts`** — convert `createInstanceWithMessage(...)` from positional args to an options object.

   Today the signature is `createInstanceWithMessage(message, files?, workingDirectory?, provider?, model?, forceNodeId?)` — a 6-positional-arg signature with a single external caller. Adding `agentId?` as a 7th positional compounds the smell. Take the opportunity to refactor:

   ```ts
   interface CreateInstanceWithMessageOptions {
     message: string;
     files?: File[];
     workingDirectory?: string;
     provider?: 'claude' | 'codex' | 'gemini' | 'copilot' | 'cursor' | 'auto';
     model?: string;
     forceNodeId?: string;
     agentId?: string;
   }
   async createInstanceWithMessage(options: CreateInstanceWithMessageOptions): Promise<boolean>
   ```

   Pass `agentId` into the `this.ipc.createInstanceWithMessage({...})` call. Update the `console.log` payload to include it.

6. **`src/renderer/app/core/state/instance/instance.store.ts`** — mirror the new options-object signature on the public wrapper and pass through to `listStore`.

7. **`src/renderer/app/features/instance-detail/welcome-coordinator.service.ts`** — `onWelcomeSendMessage(...)` (line 134) is the only external caller. Update the `this.store.createInstanceWithMessage(...)` invocation at line 187 to pass an options object including `agentId: this.newSessionDraft.agentId()`.

### F. What stays the same

- `⌘N` keyboard shortcut, `createClicked` output, all click handlers in `sidebar-header.component.ts`.
- Mode dropdown menu content (Build / Plan / Review / Retriever) and per-mode color semantics.
- `AgentStore` as a whole — its CLI-preferences responsibility is unchanged. Only its `selectedAgentId` field becomes effectively unused for new-session creation (the field can remain; nothing currently reads it after the sidebar selector is removed, but removing it is out of scope and risks breaking persistence migrations).
- The empty-instance create path (`createInstance(config)`) — already plumbs `agentId`; not touched.
- Provider selector, model selector, YOLO toggle — unchanged.

## Testing

### Unit / schema
- `src/renderer/app/core/services/new-session-draft.service.spec.ts` — add cases for `setAgentId`, default `'build'` value on a fresh draft, persistence round-trip including `agentId`, hydration of legacy persisted records (no `agentId` field) defaulting to `'build'`, hydration of unknown agent ids defaulting to `'build'`. Update the existing `clearActiveComposer` test (line 31) to reflect that `agentId` now resets while provider/model still persist.
- `src/renderer/app/core/state/agent.store.spec.ts` — existing tests should still pass. The store is unchanged; this is a sanity check.
- `src/shared/validation/ipc-schemas.spec.ts` — add a case under `InstanceCreateWithMessagePayloadSchema` confirming `agentId` (when supplied) validates as a string ≤ 100 chars, and that the field is optional.

### Verification gates (every change set, before claiming done)
- `npx tsc --noEmit` — main typecheck must pass.
- `npx tsc --noEmit -p tsconfig.spec.json` — spec typecheck must pass.
- `npm run lint` — must pass without new errors.
- Targeted Vitest runs for the modified spec files (faster than the full suite while iterating):
  - `npx vitest run src/renderer/app/core/services/new-session-draft.service.spec.ts`
  - `npx vitest run src/shared/validation/ipc-schemas.spec.ts`
- Full `npm run test` once all targeted runs pass.

### Smoke (manual)
- Start a new session with the mode pill set to Plan. Verify the resulting instance reports `agentId: 'plan'` in `inst.agentId` and that plan-mode restrictions are active. Verify the next new session draft defaults back to Build.

### Notes
- No existing spec files for `sidebar-header.component.ts` or `features/agents/agent-selector.component.ts` — no spec updates required there.
- The change crosses renderer, preload, contracts, and main IPC, so the typecheck/lint gates are non-negotiable; a change passing in one tsconfig but not the other has been a regression source before.

## File-by-file change list

**Renderer**
1. `src/renderer/app/features/dashboard/sidebar-header.component.ts`
2. `src/renderer/app/features/dashboard/sidebar-header.component.scss`
3. `src/renderer/app/features/agents/agent-selector.component.ts`
4. `src/renderer/app/features/instance-detail/input-panel.component.ts`
5. `src/renderer/app/features/instance-detail/input-panel.component.html`
6. `src/renderer/app/core/services/new-session-draft.service.ts`
7. `src/renderer/app/core/services/ipc/instance-ipc.service.ts`
8. `src/renderer/app/core/state/instance/instance-list.store.ts`
9. `src/renderer/app/core/state/instance/instance.store.ts`
10. `src/renderer/app/features/instance-detail/welcome-coordinator.service.ts`

**Preload**
11. `src/preload/domains/instance.preload.ts`

**Contracts**
12. `packages/contracts/src/schemas/instance.schemas.ts`

**Main**
13. `src/main/ipc/handlers/instance-handlers.ts`

**Tests**
14. `src/renderer/app/core/services/new-session-draft.service.spec.ts`
15. `src/shared/validation/ipc-schemas.spec.ts`

## Open questions

None remaining. (Earlier draft considered a 7th-positional-argument approach for the store signature; replaced with an options-object refactor in section E.5 above.)
