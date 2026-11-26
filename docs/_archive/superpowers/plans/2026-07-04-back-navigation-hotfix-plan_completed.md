# Back Navigation Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the missing Back control on the split-compare window immediately, add a small route-level safety net, and then migrate toward the existing `PageHeaderComponent` without introducing a new shell abstraction.

**Architecture:** Keep the hotfix local and reversible: preserve the existing route table, do not add `ControlSurfaceShellComponent`, and do not reorganize Settings/Tools navigation. The urgent fix is a visible Back button on `/compare/split` plus an app-level fallback Back button for non-dashboard routes. Follow-up cleanup hardens and adopts the existing shared `PageHeaderComponent` page by page.

**Tech Stack:** Angular 21 standalone components, Angular Router, signals, TypeScript 5.9, Vitest, existing renderer CSS conventions.

## Global Constraints

- Do not commit unless James explicitly asks.
- Do not overwrite unrelated dirty working-tree changes.
- Do not implement `docs/superpowers/plans/2026-07-04-control-center-shell-plan.md` for this bug.
- Do not create `ControlSurfaceShellComponent` or a new route-shell registry for the hotfix.
- Preserve existing URLs, especially `/compare/split`, `/settings`, `/automations`, `/campaigns`, `/verification`, and `/setup`.
- The immediate fix must make Back visible in the reported window before any broad migration starts.
- Existing page-level Back buttons are allowed to remain during the hotfix; duplication is acceptable until the shared-header migration is deliberate.
- Use the existing `PageHeaderComponent` for follow-up standardization after it is hardened with visible Back text and tests.
- Use `apply_patch` for manual file edits.
- Read each file in full before modifying it.
- Write or update tests before production code changes.
- Prefer `npm run test:quiet -- <spec>` for targeted checks.
- Final verification must include TypeScript, spec TypeScript, lint, LOC ratchet, targeted tests, and manual UI repro.

---

## Root Cause

The missing Back failure is not caused by route configuration. It is caused by page-level navigation being opt-in and hand-rolled per feature.

The concrete missing window is `/compare/split`, implemented by:

- `src/renderer/app/features/compare/split-session-compare.component.html`
- `src/renderer/app/features/compare/split-session-compare.component.ts`
- `src/renderer/app/features/compare/split-session-compare.component.scss`

Before the current partial hotfix, the split-compare template started directly with the left and right panes and had no route title/header area. Because the app had no route-level fallback and `PageHeaderComponent` is currently exported but unused, the fullscreen split-compare route could strand the user with no visible Back control.

Evidence from current repo inspection:

- `src/renderer/app/shared/components/page-header/page-header.component.ts` exists and is exported from `src/renderer/app/shared/components/index.ts`.
- `rg "app-page-header" src/renderer/app` finds no actual usages.
- Most feature pages already have their own Back button, so pattern duplication is not the immediate blocker.
- `/compare/split` is a full-height custom layout and is the likely missing-back window.
- The current working tree already contains a partial app-level route backstop in `src/renderer/app/app.component.*`; keep or refine it, do not discard it without replacing the guarantee.

## Current Working Tree Context

This plan is written against a dirty working tree. Treat existing changes as user work unless proven otherwise.

Observed partial hotfix already present:

- `src/renderer/app/features/compare/split-session-compare.component.html` already contains a visible `&larr; Back` button in the left pane header.
- `src/renderer/app/features/compare/split-session-compare.component.ts` already injects `Router` and exposes `goBack()` to navigate to `/`.
- `src/renderer/app/app.component.html`, `.scss`, `.ts`, and `.spec.ts` already contain an app-level route backstop implementation and basic tests.

Observed gaps still to close:

- `src/renderer/app/features/compare/split-session-compare.component.spec.ts` does not yet lock the split-compare Back button regression.
- `src/renderer/app/app.component.spec.ts` does not yet cover dashboard URLs with query strings or fragments.
- `PageHeaderComponent` is still icon-only and untested.
- No standard page has adopted `PageHeaderComponent`.
- `docs/superpowers/plans/2026-07-04-control-center-shell-plan.md` exists but is superseded for this incident. Do not implement it as part of the hotfix.

## Approach Decision

Recommended approach: ship the smallest hotfix first, then standardize.

1. Immediate hotfix:
   - Ensure `/compare/split` itself has a visible text Back button.
   - Keep/refine the app-level route backstop as a safety net for any future fullscreen route that forgets its local Back control.
   - Add focused regression tests.
   - Manually verify `/compare/split` before starting shared-header cleanup.

2. Follow-up shared component adoption:
   - Harden `PageHeaderComponent` so it has visible Back text, an accessible label, and unit tests.
   - Adopt it only on standard pages in small batches.
   - Leave custom fullscreen pages, such as split compare, on local compact Back controls unless the shared header fits their layout.

Rejected for this bug:

- A new `ControlSurfaceShellComponent`.
- A Control Center route registry.
- Removing all existing per-page Back buttons in one migration.
- Reclassifying Settings and Tools navigation as part of the urgent fix.

Critical execution order:

1. Do Tasks 1 and 2 first.
2. Run the split-compare parts of Task 5 immediately after Tasks 1 and 2.
3. Run the targeted tests from Task 6 Step 1 for `app.component.spec.ts` and `split-session-compare.component.spec.ts`.
4. Only then do Tasks 3 and 4, which are shared-header hardening and first adoption.
5. Finish with the full automated gates in Task 6.

---

### Task 1: Add A Route-Specific Regression Test For Split Compare

**Files:**

- Modify: `src/renderer/app/features/compare/split-session-compare.component.spec.ts`
- Read only: `src/renderer/app/features/compare/split-session-compare.component.html`

**Interfaces:**

- Consumes: the existing split-compare template and Vitest test file.
- Produces: a test that fails when the split-compare page has no visible dashboard Back control.

- [ ] **Step 1: Read the files**

Run:

```bash
sed -n '1,260p' src/renderer/app/features/compare/split-session-compare.component.spec.ts
sed -n '1,180p' src/renderer/app/features/compare/split-session-compare.component.html
```

- [ ] **Step 2: Write the failing template regression test**

Add these imports near the top of `split-session-compare.component.spec.ts`:

```ts
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
```

Add this constant after the imports:

```ts
const specDirectory = dirname(fileURLToPath(import.meta.url));
const splitCompareTemplate = readFileSync(
  resolve(specDirectory, './split-session-compare.component.html'),
  'utf8',
);
```

Add this test block before `describe('pickPaneDefaults()', ...)`:

```ts
describe('Split compare route navigation', () => {
  it('keeps a visible dashboard Back control in the split compare window', () => {
    expect(splitCompareTemplate).toContain('aria-label="Back to dashboard"');
    expect(splitCompareTemplate).toContain('&larr; Back');
  });
});
```

- [ ] **Step 3: Run the test against the current tree**

Run:

```bash
npm run test:quiet -- src/renderer/app/features/compare/split-session-compare.component.spec.ts
```

Expected in the current dirty tree: PASS if the existing partial hotfix is still present.

Expected on a clean pre-hotfix baseline: FAIL because `splitCompareTemplate` does not contain the accessible visible Back control.

If this test already passes, keep Step 4 as a verification checklist rather than re-editing the template.

- [ ] **Step 4: Keep or implement the minimal template fix**

In `src/renderer/app/features/compare/split-session-compare.component.html`, add the Back button as the first item inside the left pane header:

```html
<button class="back-button" type="button" (click)="goBack()" aria-label="Back to dashboard">
  &larr; Back
</button>
```

Do not move the pane pickers or restructure the split layout.

- [ ] **Step 5: Ensure the component has the navigation method**

In `src/renderer/app/features/compare/split-session-compare.component.ts`, keep this method:

```ts
protected goBack(): void {
  void this.router.navigate(['/']);
}
```

- [ ] **Step 6: Verify the targeted test passes**

Run:

```bash
npm run test:quiet -- src/renderer/app/features/compare/split-session-compare.component.spec.ts
```

Expected: PASS.

---

### Task 2: Keep And Tighten The App-Level Route Backstop

**Files:**

- Modify: `src/renderer/app/app.component.ts`
- Modify: `src/renderer/app/app.component.html`
- Modify: `src/renderer/app/app.component.scss`
- Modify: `src/renderer/app/app.component.spec.ts`

**Interfaces:**

- Consumes: Angular `Router.events`, `NavigationEnd`, and the existing root app template.
- Produces: a route-level Back fallback that appears on non-dashboard routes and navigates to `/`.

- [ ] **Step 1: Read the files**

Run:

```bash
sed -n '1,460p' src/renderer/app/app.component.ts
sed -n '1,180p' src/renderer/app/app.component.html
sed -n '1,260p' src/renderer/app/app.component.scss
sed -n '1,240p' src/renderer/app/app.component.spec.ts
```

- [ ] **Step 2: Confirm the backstop tests exist**

`src/renderer/app/app.component.spec.ts` must include:

```ts
it('does not show the route fallback back button on the dashboard route', () => {
  expect(fixture.nativeElement.querySelector('[data-testid="route-backstop"]')).toBeNull();
});

it('shows a route fallback back button on non-dashboard routes', () => {
  router.url = '/browser';
  router.events.next(new NavigationEnd(1, '/browser', '/browser'));
  fixture.detectChanges();

  const backstop = fixture.nativeElement.querySelector('[data-testid="route-backstop"]') as HTMLButtonElement | null;
  expect(backstop).not.toBeNull();

  backstop?.click();
  expect(router.navigate).toHaveBeenCalledWith(['/']);
});
```

- [ ] **Step 3: Add query/hash coverage**

Add this test to `app.component.spec.ts`:

```ts
it('treats dashboard query strings and fragments as the dashboard route', () => {
  router.url = '/?tab=home#top';
  router.events.next(new NavigationEnd(1, '/?tab=home#top', '/?tab=home#top'));
  fixture.detectChanges();

  expect(fixture.nativeElement.querySelector('[data-testid="route-backstop"]')).toBeNull();
});
```

- [ ] **Step 4: Run the app component test**

Run:

```bash
npm run test:quiet -- src/renderer/app/app.component.spec.ts
```

Expected in the current dirty tree after adding query/hash coverage: PASS.

Expected on a baseline with no app-level backstop: FAIL on the route-backstop tests.

- [ ] **Step 5: Keep the root template fallback**

`src/renderer/app/app.component.html` should contain:

```html
@if (showRouteBackstop()) {
  <button
    type="button"
    class="route-backstop"
    [class.macos]="isMacOS"
    data-testid="route-backstop"
    aria-label="Back to dashboard"
    title="Back to dashboard"
    (click)="goToDashboard()"
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M19 12H5" />
      <path d="M12 19l-7-7 7-7" />
    </svg>
    <span>Back</span>
  </button>
}
```

- [ ] **Step 6: Keep the route tracking implementation**

`src/renderer/app/app.component.ts` should contain these members:

```ts
private routerEventsSubscription: { unsubscribe(): void } | null = null;

protected readonly currentRouteUrl = signal(this.router.url || '/');
protected readonly showRouteBackstop = computed(() => this.isNonDashboardRoute(this.currentRouteUrl()));
```

Call `this.bindRouteBackstop();` at the start of `ngOnInit()`.

Keep these methods:

```ts
protected goToDashboard(): void {
  void this.router.navigate(['/']);
}

private bindRouteBackstop(): void {
  this.currentRouteUrl.set(this.router.url || '/');
  this.routerEventsSubscription?.unsubscribe();
  this.routerEventsSubscription = this.router.events.subscribe((event) => {
    if (event instanceof NavigationEnd) {
      this.currentRouteUrl.set(event.urlAfterRedirects || event.url || '/');
    }
  });
}

private isNonDashboardRoute(url: string): boolean {
  const path = url.split(/[?#]/)[0] || '/';
  return path !== '/';
}
```

In `ngOnDestroy()`, keep:

```ts
this.routerEventsSubscription?.unsubscribe();
this.routerEventsSubscription = null;
```

- [ ] **Step 7: Keep the title-bar-safe CSS**

`src/renderer/app/app.component.scss` should keep `.route-backstop` positioned above page content and outside the draggable title-bar region:

```scss
.route-backstop {
  position: fixed;
  top: 8px;
  left: 12px;
  z-index: 1200;
  -webkit-app-region: no-drag;
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-full);
  background: var(--bg-elevated);
  color: var(--text-primary);
  box-shadow: var(--shadow-md);
  cursor: pointer;
  font-size: var(--text-xs);
  font-weight: 700;
  white-space: nowrap;
}

.route-backstop.macos {
  top: 12px;
  left: 84px;
}
```

---

### Task 3: Harden The Existing PageHeaderComponent

**Files:**

- Modify: `src/renderer/app/shared/components/page-header/page-header.component.ts`
- Create: `src/renderer/app/shared/components/page-header/page-header.component.spec.ts`

**Interfaces:**

- Consumes: Angular `input()` and `Router`.
- Produces: a tested shared page header with a visible, accessible Back affordance for later page-by-page adoption.

- [ ] **Step 1: Read the component**

Run:

```bash
sed -n '1,220p' src/renderer/app/shared/components/page-header/page-header.component.ts
```

- [ ] **Step 2: Write the failing tests**

Create `src/renderer/app/shared/components/page-header/page-header.component.spec.ts`:

```ts
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PageHeaderComponent } from './page-header.component';

@Component({
  standalone: true,
  imports: [PageHeaderComponent],
  template: `
    <app-page-header title="Automations" subtitle="Scheduled work" backRoute="/">
      <button actions type="button">Create</button>
    </app-page-header>
  `,
})
class HostComponent {}

describe('PageHeaderComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let router: { navigate: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    router = { navigate: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [{ provide: Router, useValue: router }],
    }).compileComponents();

    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  });

  it('renders title, subtitle, actions, and a visible Back label', () => {
    expect(fixture.nativeElement.textContent).toContain('Automations');
    expect(fixture.nativeElement.textContent).toContain('Scheduled work');
    expect(fixture.nativeElement.textContent).toContain('Create');
    expect(fixture.nativeElement.textContent).toContain('Back');
  });

  it('navigates to the configured back route', () => {
    const button = fixture.nativeElement.querySelector('.back-btn') as HTMLButtonElement;

    button.click();

    expect(router.navigate).toHaveBeenCalledWith(['/']);
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run:

```bash
npm run test:quiet -- src/renderer/app/shared/components/page-header/page-header.component.spec.ts
```

Expected before component hardening: FAIL because the current `PageHeaderComponent` has an icon-only Back control and no visible Back text.

- [ ] **Step 4: Update the component template**

In `src/renderer/app/shared/components/page-header/page-header.component.ts`, update the Back button block to:

```html
<button
  class="back-btn"
  type="button"
  (click)="goBack()"
  aria-label="Back to dashboard"
>
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <path d="M19 12H5M12 19l-7-7 7-7"/>
  </svg>
  <span>Back</span>
</button>
```

- [ ] **Step 5: Update the Back button CSS**

Still in `page-header.component.ts`, ensure `.back-btn` supports visible text:

```scss
.back-btn {
  padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px);
  background: none;
  border: none;
  color: var(--text-muted, #9a9aa0);
  cursor: pointer;
  border-radius: var(--radius-sm, 4px);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: all var(--transition-fast, 0.1s);
}
```

- [ ] **Step 6: Run the shared header test**

Run:

```bash
npm run test:quiet -- src/renderer/app/shared/components/page-header/page-header.component.spec.ts
```

Expected: PASS.

---

### Task 4: Adopt PageHeaderComponent In One Low-Risk Standard Page

**Files:**

- Modify: `src/renderer/app/features/automations/automations-page.component.ts`
- Modify: `src/renderer/app/features/automations/automations-page.component.html`
- Create: `src/renderer/app/features/automations/automations-page.component.spec.ts`
- Do not modify split compare in this task.

**Interfaces:**

- Consumes: tested `PageHeaderComponent`.
- Produces: one example migration that proves the existing shared header can replace local duplicated header markup without a new shell.

- [ ] **Step 1: Choose the first page**

Use `AutomationsPageComponent` first because it already has a simple top toolbar and the current working tree has already touched its Back button text.

Read the complete files before editing:

```bash
sed -n '1,760p' src/renderer/app/features/automations/automations-page.component.ts
sed -n '1,460p' src/renderer/app/features/automations/automations-page.component.html
sed -n '1,140p' src/renderer/app/features/automations/automations-page.component.css
```

- [ ] **Step 2: Write the failing adoption regression**

Create `src/renderer/app/features/automations/automations-page.component.spec.ts`:

```ts
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const componentSource = readFileSync(resolve(specDirectory, './automations-page.component.ts'), 'utf8');
const templateSource = readFileSync(resolve(specDirectory, './automations-page.component.html'), 'utf8');

describe('AutomationsPageComponent route header', () => {
  it('uses the shared PageHeaderComponent for the page title and dashboard Back control', () => {
    expect(componentSource).toContain('PageHeaderComponent');
    expect(templateSource).toContain('<app-page-header');
    expect(templateSource).toContain('title="Automations"');
    expect(templateSource).toContain('backRoute="/"');
    expect(templateSource).not.toContain('<header class="toolbar">');
  });
});
```

Run:

```bash
npm run test:quiet -- src/renderer/app/features/automations/automations-page.component.spec.ts
```

Expected before the migration: FAIL because `AutomationsPageComponent` still uses its local toolbar.

- [ ] **Step 3: Update the standalone imports**

In `src/renderer/app/features/automations/automations-page.component.ts`, add this import:

```ts
import { PageHeaderComponent } from '../../shared/components';
```

Change the component imports array from:

```ts
imports: [CommonModule, FormsModule, CompactModelPickerComponent],
```

to:

```ts
imports: [CommonModule, FormsModule, CompactModelPickerComponent, PageHeaderComponent],
```

- [ ] **Step 4: Replace only the duplicated header Back/title area**

In `src/renderer/app/features/automations/automations-page.component.html`, replace this header:

```html
<header class="toolbar">
  <div class="toolbar-title">
    <button class="icon-btn back-btn" type="button" (click)="goBack()" aria-label="Back to dashboard">
      &larr; Back
    </button>
    <h1>Automations</h1>
  </div>
  <div class="create" (mouseleave)="menuOpen.set(false)">
    <button class="btn btn--primary create-main" type="button" (click)="startChat()">
      Create via chat
    </button>
    <button class="btn btn--primary create-caret" type="button" aria-label="More create options" (click)="menuOpen.set(!menuOpen())">▾</button>
    @if (menuOpen()) {
      <div class="menu" role="menu">
        <button type="button" role="menuitem" (click)="startChat(); menuOpen.set(false)">Create via chat</button>
        <button type="button" role="menuitem" (click)="startCreate(); menuOpen.set(false)">Create manually</button>
        <button type="button" role="menuitem" (click)="store.refresh(); menuOpen.set(false)">Refresh</button>
      </div>
    }
  </div>
</header>
```

with:

```html
<app-page-header
  title="Automations"
  subtitle="Scheduled work and reusable agent actions"
  backRoute="/"
>
  <div actions class="create" (mouseleave)="menuOpen.set(false)">
    <button class="btn btn--primary create-main" type="button" (click)="startChat()">
      Create via chat
    </button>
    <button class="btn btn--primary create-caret" type="button" aria-label="More create options" (click)="menuOpen.set(!menuOpen())">▾</button>
    @if (menuOpen()) {
      <div class="menu" role="menu">
        <button type="button" role="menuitem" (click)="startChat(); menuOpen.set(false)">Create via chat</button>
        <button type="button" role="menuitem" (click)="startCreate(); menuOpen.set(false)">Create manually</button>
        <button type="button" role="menuitem" (click)="store.refresh(); menuOpen.set(false)">Refresh</button>
      </div>
    }
  </div>
</app-page-header>
```

Do not change automation behavior or menu state.

- [ ] **Step 5: Leave the local `goBack()` method for a cleanup pass**

Do not remove `goBack()` in this task. Removing it is safe only after checking for template/caller references in the full component and any tests. Leaving one unused method briefly is lower risk than mixing a shared-header adoption with behavior cleanup.

- [ ] **Step 6: Run the targeted tests**

Run:

```bash
npm run test:quiet -- src/renderer/app/features/automations/automations-page.component.spec.ts
npm run test:quiet -- src/renderer/app/shared/components/page-header/page-header.component.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Stop after one page**

Do not migrate more pages in the urgent bugfix. Additional pages should be separate small PRs or commits after the hotfix is verified in the app.

---

### Task 5: Manual UI Repro And Verification

**Files:**

- No file edits.

**Interfaces:**

- Consumes: built app in dev mode.
- Produces: evidence that the reported window is fixed in the real UI.

Run the split-compare portion of this task immediately after Tasks 1 and 2. Do not wait for the `PageHeaderComponent` cleanup tasks before verifying the urgent route.

- [ ] **Step 1: Start the app**

Run:

```bash
npm run dev
```

- [ ] **Step 2: Reproduce the original route**

Open the split compare route through the app navigation if available. If needed, navigate directly to:

```text
/compare/split
```

Expected:

- A visible `Back` control appears in the split-compare window.
- The app-level route backstop is visible if enabled.
- The Back control is not hidden under macOS traffic lights or Windows caption buttons.
- The Back control does not cover the left agent picker enough to prevent selecting an agent.

- [ ] **Step 3: Click Back**

Expected:

- The app navigates to `/`.
- Dashboard content is visible.
- The route backstop disappears on the dashboard.

- [ ] **Step 4: Keyboard check**

On `/compare/split`, press Tab until Back is focused, then press Enter.

Expected:

- Focus reaches the Back control.
- Enter navigates to `/`.

- [ ] **Step 5: Smoke-check representative routes**

Open these routes and confirm a visible Back affordance exists and returns to `/`:

```text
/settings
/automations
/campaigns
/browser
/verification
/compare/split
```

Also open `/` and confirm the app-level route backstop is not visible.

---

### Task 6: Final Automated Gates

**Files:**

- No file edits unless a gate fails.

**Interfaces:**

- Consumes: the final working tree after Tasks 1-5.
- Produces: verification before claiming complete.

- [ ] **Step 1: Targeted tests**

Run:

```bash
npm run test:quiet -- src/renderer/app/app.component.spec.ts
npm run test:quiet -- src/renderer/app/features/compare/split-session-compare.component.spec.ts
npm run test:quiet -- src/renderer/app/shared/components/page-header/page-header.component.spec.ts
npm run test:quiet -- src/renderer/app/features/automations/automations-page.component.spec.ts
```

Expected: PASS.

- [ ] **Step 2: TypeScript checks**

Run:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: no errors.

- [ ] **Step 3: Lint and LOC ratchet**

Run:

```bash
npm run lint
npm run check:ts-max-loc
```

Expected: PASS.

- [ ] **Step 4: Full quiet suite**

Run:

```bash
npm run test:quiet
```

Expected: PASS.

---

## Migration After The Hotfix

Do this only after the urgent Back bug is verified in the real UI.

1. Keep the app-level route backstop until a route inventory proves every secondary route either uses `PageHeaderComponent` or has a documented custom fullscreen Back control.
2. Migrate standard pages in batches of one to three pages.
3. For each page, write or update a focused test first.
4. Do not remove local Back buttons from a page until its replacement is visually verified.
5. Do not migrate `/compare/split` into `PageHeaderComponent` unless the design is explicitly changed; its compact pane layout is a valid custom fullscreen case.
6. After all standard pages are migrated, decide whether to keep the route backstop permanently as a defensive safety net or hide it behind an explicit route-data opt-out.

Suggested first migration order:

1. `/automations`
2. `/campaigns`
3. `/tasks`
4. `/memory/stats`
5. `/remote-nodes`
6. `/observations`
7. `/replay`

Do not migrate Settings in the first cleanup batch. Settings has its own left rail and should be handled separately after the shared header proves out on simpler pages.

## Completion Checklist

- [ ] `/compare/split` has an immediate visible Back control.
- [ ] The app-level route backstop is tested and visible on non-dashboard routes.
- [ ] `PageHeaderComponent` is mentioned, tested, and hardened instead of replaced by a new shell.
- [ ] At most one standard page adopts `PageHeaderComponent` in the first implementation pass.
- [ ] No `ControlSurfaceShellComponent` is created.
- [ ] No route registry migration is started.
- [ ] Targeted tests pass.
- [ ] TypeScript, spec TypeScript, lint, LOC ratchet, and full quiet tests pass.
- [ ] Manual UI repro confirms Back works in the reported window.
