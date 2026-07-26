# Mobile Provider Continue Action Implementation Plan

> **For agentic workers:** Implement this focused bug fix on the current checkout. Do not create a branch or worktree, commit active planning documents, or disturb unrelated working-tree changes.

**Status:** Completed and verified on 2026-07-26.

**Specification:** [2026-07-26-mobile-provider-continue_spec_completed.md](../specs/2026-07-26-mobile-provider-continue_spec_completed.md)

**Goal:** Let mobile users accept the selected provider and its current/default model without being forced through model selection.

**Architecture:** Add one explicit completion action to the existing Session settings header. The component method only closes the settings signal and triggers the existing haptic service; provider, model, reasoning, gateway, and payload behavior remain unchanged.

**Tech Stack:** Angular 22 standalone components, TypeScript 6, signals, SCSS, Vitest, Playwright CLI.

## Global Constraints

- Work on the current checkout; do not create a branch or worktree.
- Preserve unrelated dirty-tree changes.
- Follow the repository bug order: reproduce, implement the minimal fix, verify the real UI, then update tests.
- Use the shared check icon and existing mobile design tokens.
- Keep the action at least `--control-size` and label it `Continue with selected provider`.
- Do not change gateway calls, creation payloads, persistence, provider selection, model selection, or reasoning selection.

---

### Task 1: Add and verify the provider Continue action

**Files:**

- Modify: `apps/mobile/src/app/features/new-session/new-session.component.ts`
- Modify: `apps/mobile/src/app/features/new-session/new-session.component.scss`
- Modify after UI verification: `apps/mobile/src/app/features/new-session/new-session.component.spec.ts`

**Interfaces:**

- Adds component method: `completeSettings(): void`
- Consumes: `settingsSheetOpen`, `HapticsService.tap()`, and shared `MobileIconComponent`

- [x] **Step 1: Record the reproduced baseline**

At a 390×844 viewport, open `/new-session`, open Session settings, select Codex, and confirm the provider is checked while the sheet has no explicit completion action.

- [x] **Step 2: Implement the minimal header action**

Wrap the existing heading copy and add:

```html
<button
  class="sheet-confirm mobile-icon-button"
  type="button"
  (click)="completeSettings()"
  aria-label="Continue with selected provider"
>
  <app-mobile-icon name="check" />
</button>
```

Add:

```ts
protected completeSettings(): void {
  this.settingsSheetOpen.set(false);
  this.haptics.tap();
}
```

Use a BEM-style heading modifier and existing tokens to keep the action aligned, touch-sized, and non-shrinking.

- [x] **Step 3: Verify the real UI**

With the mobile development server running, use the Playwright CLI at 390×844 to:

1. Open `/new-session`.
2. Open Session settings.
3. Select Codex.
4. Confirm `Continue with selected provider` is exposed as a button.
5. Activate it.
6. Confirm the dialog closes, the composer returns, and Codex remains displayed as the execution target.

- [x] **Step 4: Add the regression test**

After Step 3 passes, update the existing component structure spec to assert the accessible action, `completeSettings()` binding, settings-sheet close, and tap haptic are present. The mutation this test catches is removing the only explicit exit that preserves the selected/default model.

- [x] **Step 5: Run focused and mobile verification**

Run from `apps/mobile/`:

```bash
rtk npx vitest run src/app/features/new-session/new-session.component.spec.ts
rtk npx vitest run
rtk npm run typecheck
rtk npm run lint
rtk npm run build
```

- [x] **Step 6: Run repository canonical verification**

Run from the repository root:

```bash
rtk npx tsc --noEmit
rtk npx tsc --noEmit -p tsconfig.spec.json
rtk npm run lint
rtk npm run check:ts-max-loc
rtk npm run test:quiet
```

- [x] **Step 7: Run the independent completion gate and close documentation**

Have a genuinely fresh agent use `task-completion-gate` against the task-owned diff and acceptance criteria. Resolve every actionable finding until `VERDICT: PASS`, then record as-built evidence and rename both documents with `_completed`.

## As-Built Notes

- Reproduced the original dead end at 390×844 before changing the component.
- Added a right-aligned, accessible check action using `mobile-icon-button`; its existing `--control-size` styling provides the 44px touch target.
- `completeSettings()` changes only `settingsSheetOpen` and invokes `HapticsService.tap()`.
- Preserved the existing provider, model, reasoning, gateway, payload, and persistence paths.
- Added a render-level component regression test. Its red/green mutation check failed when the close-state line was removed and passed when restored.
- Independently smoked the completed Auto and Codex flows at 390×844; Model remained optional and no model sheet opened on Continue.

## Verification Evidence

- Focused component spec: 5/5 passed.
- Full mobile suite: 18 files, 95/95 tests passed.
- Mobile typecheck, lint, and production build: passed.
- Root TypeScript and spec TypeScript checks, lint, and TypeScript LOC ratchet: passed.
- Canonical root suite: 1,593 files, 15,909 tests passed.
- Independent completion gate: `VERDICT: PASS`, with no actionable findings.
