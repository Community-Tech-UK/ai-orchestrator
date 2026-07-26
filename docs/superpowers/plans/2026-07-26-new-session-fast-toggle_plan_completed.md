# New-session Fast Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a provider-scoped Fast toggle to the new-session composer and verify that the existing creation path uses it.

**Architecture:** Reuse `ProviderStateService` as the single source of truth for per-provider Fast preferences. The draft composer derives visibility and state from its selected provider and writes through the existing memory method; `InstanceListStore` already reads the same preference when constructing create payloads.

**Tech Stack:** Angular 22 standalone components and signals, TypeScript, Vitest.

## Global Constraints

- Work in the current checkout; do not create a branch or worktree.
- Preserve unrelated dirty-tree changes.
- Do not add IPC, settings, or draft-schema fields.
- Show the control only for Claude and Codex.
- Keep this plan and its linked spec untracked until implementation and verification complete.

---

### Task 1: Draft composer Fast control

**Files:**
- Modify: `src/renderer/app/features/instance-detail/input-panel.component.ts`
- Modify: `src/renderer/app/features/instance-detail/input-panel.component.html`
- Test: `src/renderer/app/features/instance-detail/input-panel.component.spec.ts`

**Interfaces:**
- Consumes: `ProviderStateService.getFastModeForProvider(provider)` and `rememberFastModeForProvider(provider, fastMode)`.
- Produces: `showDraftFastModeToggle`, `effectiveDraftFastMode`, and `onToggleDraftFastMode()` on `InputPanelComponent`.

- [x] **Step 1: Write failing component tests**

Add draft-composer tests which mount `InputPanelComponent` with `instanceId="new"` and assert:

```typescript
expect(fixture.nativeElement.querySelector('.fast-toggle')?.textContent).toContain('FAST OFF');
fastButton.click();
expect(providerState.rememberFastModeForProvider).toHaveBeenCalledWith('claude', true);
```

Also switch the provider signal to an unsupported provider and assert the button is absent, then seed distinct Claude/Codex preferences and assert the displayed state follows the selected provider.

- [x] **Step 2: Run the focused test and confirm RED**

Run:

```bash
rtk npm run test:quiet -- src/renderer/app/features/instance-detail/input-panel.component.spec.ts
```

Expected: FAIL because `.fast-toggle` and the draft Fast component API do not exist.

- [x] **Step 3: Implement the minimal component behavior**

Add computed state equivalent to:

```typescript
readonly showDraftFastModeToggle = computed(() => {
  const provider = this.selectedProvider();
  return this.isDraftComposer() && (provider === 'claude' || provider === 'codex');
});

readonly effectiveDraftFastMode = computed(() =>
  this.providerState.getFastModeForProvider(this.selectedProvider())
);

onToggleDraftFastMode(): void {
  const provider = this.selectedProvider();
  if (provider !== 'claude' && provider !== 'codex') return;
  this.providerState.rememberFastModeForProvider(provider, !this.effectiveDraftFastMode());
}
```

Render a native button beside YOLO:

```html
@if (showDraftFastModeToggle()) {
  <button
    type="button"
    class="yolo-toggle fast-toggle"
    [class.active]="effectiveDraftFastMode()"
    (click)="onToggleDraftFastMode()"
  >
    <span class="yolo-label">FAST {{ effectiveDraftFastMode() ? 'ON' : 'OFF' }}</span>
  </button>
}
```

Include title text explaining Fast mode's speed/capability trade-off.

- [x] **Step 4: Run the focused component test and confirm GREEN**

Run:

```bash
rtk npm run test:quiet -- src/renderer/app/features/instance-detail/input-panel.component.spec.ts
```

Expected: PASS.

### Task 2: Creation-path regression coverage

**Files:**
- Test: `src/renderer/app/core/state/instance/instance-list.store.spec.ts`

**Interfaces:**
- Consumes: `InstanceListStore.createInstanceWithMessageAndReturnId()` and `ProviderStateService.getFastModeForProvider()`.
- Produces: regression proof that an omitted explicit `fastMode` uses the selected provider's remembered value.

- [x] **Step 1: Add a failing-or-characterization regression test**

Add a test with the provider-state mock returning `true` for Codex and assert the real store sends:

```typescript
expect(ipc.createInstanceWithMessage).toHaveBeenCalledWith(
  expect.objectContaining({ provider: 'codex', fastMode: true }),
);
```

- [x] **Step 2: Run the focused store test**

Run:

```bash
rtk npm run test:quiet -- src/renderer/app/core/state/instance/instance-list.store.spec.ts
```

Expected: PASS if existing creation behavior is already fully wired; otherwise FAIL for the missing payload behavior.

- [x] **Step 3: Make only the implementation change required by the test**

No production change was required because the existing resolver already used the provider-scoped preference.

- [x] **Step 4: Re-run both focused tests**

Run:

```bash
rtk npm run test:quiet -- src/renderer/app/features/instance-detail/input-panel.component.spec.ts src/renderer/app/core/state/instance/instance-list.store.spec.ts
```

Expected: PASS.

### Task 3: Final verification and lifecycle closure

**Files:**
- Rename after all checks pass: `docs/superpowers/plans/2026-07-26-new-session-fast-toggle_plan.md` to `docs/superpowers/plans/2026-07-26-new-session-fast-toggle_plan_completed.md`
- Rename after all checks pass: `docs/superpowers/specs/2026-07-26-new-session-fast-toggle_spec_planned.md` to `docs/superpowers/specs/2026-07-26-new-session-fast-toggle_spec_completed.md`

- [x] **Step 1: Run canonical gates**

```bash
rtk npx tsc --noEmit
rtk npx tsc --noEmit -p tsconfig.spec.json
rtk npm run lint
rtk npm run check:ts-max-loc
rtk npm run test:quiet
```

- [x] **Step 2: Obtain independent completion-gate review**

Start a genuinely fresh agent context and require the `task-completion-gate` skill. Resolve all actionable findings and repeat until it returns `VERDICT: PASS`.

- [x] **Step 3: Close the documentation lifecycle**

Record verification evidence and as-built notes in both documents, update the spec link to the completed plan filename, then rename both files with `_completed`.

- [x] **Step 4: Verify repository state**

```bash
rtk git status --short
rtk git diff -- src/renderer/app/features/instance-detail/input-panel.component.ts src/renderer/app/features/instance-detail/input-panel.component.html src/renderer/app/features/instance-detail/input-panel.component.spec.ts src/renderer/app/core/state/instance/instance-list.store.spec.ts
rtk git worktree list
rtk git branch --list
```

Confirm only intended paths were changed by this task and no branch/worktree was created.

## Completion evidence

- RED: the initial draft-composer run failed 2 of 9 tests because `.fast-toggle` did not exist.
- Focused GREEN: 2 files and 31 tests passed after adding local-model coverage.
- Canonical gates: `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`, and `npm run test:quiet` all exited 0 on the final revision.
- Fresh completion-gate cycle: the first two reviews identified missing local-model coverage and a legacy Angular test-stub convention; both were fixed. A third genuinely fresh review returned `VERDICT: PASS` with no findings.
- No branch, worktree, commit, dependency, IPC, persistence schema, or backend change was created for this feature.
