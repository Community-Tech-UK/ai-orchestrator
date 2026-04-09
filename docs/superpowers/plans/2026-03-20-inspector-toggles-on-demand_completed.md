# Inspector Toggles: Appear on Demand — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide inspector toggle buttons (Tasks, Review) until they have meaningful content, animate them in when they appear, and add review badge + auto-expand for Tasks.

**Architecture:** Wrap each toggle in conditional rendering based on content signals (`todoStore.hasTodos()`, `reviewHasContent()`). Add `output()` events to the review panel so the parent can track review state. Use CSS `translateY` + opacity for smooth entrance animation. Reset all state on instance change via an existing-pattern `effect()`. The review panel's first access is via the `openReviewPanel()` method (which both opens the panel and marks it as having content), callable from any entry point.

**Tech Stack:** Angular 21 (zoneless, signals, `output()`), CSS animations, `prefers-reduced-motion`

**Spec:** `docs/superpowers/specs/2026-03-20-inspector-toggles-appear-on-demand-design_completed.md`

**Note:** Line numbers are approximate — they will shift as earlier tasks insert code. Descriptions of code anchors (e.g., "after the `hasChildren` computed") are the authoritative reference.

---

## File Structure

### Modified Files

| File | Responsibility |
|------|---------------|
| `src/renderer/app/features/instance-detail/instance-review-panel.component.ts` | Add `output()` events: `reviewStarted`, `reviewCompleted`. Remove internal `visible()` guard. |
| `src/renderer/app/features/instance-detail/instance-detail.component.ts` | Conditional toggle rendering, entrance animation, auto-expand, badge, state reset on instance change, `openReviewPanel()` method |

### Test Files

| File | Tests |
|------|-------|
| `src/renderer/app/features/instance-detail/instance-detail-inspectors.spec.ts` | Toggle visibility, auto-expand, state reset, badge rendering |

---

## Task 1: Add `output()` Events to Review Panel

The parent component needs to know when a review starts and completes so it can show/hide the Review toggle. Currently this state is locked inside the review panel.

**Files:**
- Modify: `src/renderer/app/features/instance-detail/instance-review-panel.component.ts:8-16` (imports), `:68` (template `@if`), `:340-364` (signals), `:444-482` (runReview), `:523-554` (pollSession)

- [ ] **Step 1.1: Add `output` to Angular imports and declare output events**

In `src/renderer/app/features/instance-detail/instance-review-panel.component.ts`, add `output` to the Angular import:

```typescript
// Line 8-16: add 'output' to imports
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal
} from '@angular/core';
```

Add output events after the existing signal declarations (after line 364):

```typescript
  /** Emitted when user clicks "Run review" — tells parent the review toggle should stay visible */
  reviewStarted = output<void>();

  /** Emitted when review completes — carries issue count and whether any are error/critical severity */
  reviewCompleted = output<{ issueCount: number; hasErrors: boolean }>();
```

- [ ] **Step 1.2: Emit `reviewStarted` when review begins**

In the `runReview()` method (line 444), emit after validation passes but before the API call:

```typescript
  async runReview(): Promise<void> {
    const instanceId = this.instanceId();
    const agentIds = this.selectedAgentIds();
    const files = this.files();
    if (agentIds.length === 0 || files.length === 0) return;

    this.reviewStarted.emit();  // <-- ADD THIS LINE

    this.busy.set(true);
    // ... rest unchanged
```

- [ ] **Step 1.3: Emit `reviewCompleted` when review finishes**

In the `pollSession()` method (line 541), emit after setting status to completed:

```typescript
      if (status === 'completed') {
        this.sessionStatus.set('completed');
        const issues = (session?.aggregatedIssues || []) as ReviewIssue[];
        this.issues.set(issues);
        this.summary.set(this.buildSummary(issues));
        // ADD: notify parent with issue summary
        const hasErrors = issues.some(
          (i) => i.severity === 'critical' || i.severity === 'high'
        );
        this.reviewCompleted.emit({ issueCount: issues.length, hasErrors });
        return;
      }
```

- [ ] **Step 1.4: Remove internal `visible()` guard from template**

The parent now controls whether the review panel renders. Remove the `@if (visible())` wrapper at line 68 so the panel always renders its content when the parent includes it. Change:

```html
    @if (visible()) {
      <div class="panel">
        ...
      </div>
    }
```

To just the inner content (remove the `@if` wrapper, keep everything inside):

```html
      <div class="panel">
        ...
      </div>
```

The `visible` computed and `expanded` signal can stay — `expanded` is still used internally for collapsing the body. The `visible` computed is no longer referenced in the template but can remain for now (removing it is optional cleanup).

- [ ] **Step 1.5: Verify compilation**

Run: `npx tsc --noEmit`
Expected: PASS — no new errors

---

## Task 2: Conditional Toggle Rendering + Review State in Parent

Make each toggle appear only when it has content. Add signals to track review state from the child's output events.

**Files:**
- Modify: `src/renderer/app/features/instance-detail/instance-detail.component.ts:164-210` (template), `:591-611` (signals)

- [ ] **Step 2.1: Add review state signals and `anyInspectorVisible` computed**

In the component class (after line 594), add:

```typescript
  // Review panel state — driven by output events from InstanceReviewPanelComponent
  reviewHasContent = signal(false);
  reviewBadgeInfo = signal<{ issueCount: number; hasErrors: boolean } | null>(null);

  // Container visibility — only render the toggle bar when at least one toggle has content
  anyInspectorVisible = computed(() =>
    this.todoStore.hasTodos() || this.reviewHasContent() || this.hasChildren()
  );
```

- [ ] **Step 2.2: Update template — wrap `.inspector-toggles` in conditional**

Replace the inspector toggles section (lines 163-210) with:

```html
          <!-- Inspector toggles — only rendered when at least one has content -->
          @if (anyInspectorVisible()) {
            <div class="inspector-toggles"
                 role="toolbar"
                 aria-label="Session inspectors">
              @if (todoStore.hasTodos()) {
                <button
                  class="inspector-toggle"
                  [class.active]="showTodoInspector()"
                  (click)="showTodoInspector.set(!showTodoInspector())"
                  [attr.aria-expanded]="showTodoInspector()"
                  title="Toggle task list"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/>
                  </svg>
                  Tasks
                  @if (!showTodoInspector()) {
                    <span class="inspector-badge">{{ todoStore.stats().completed }}/{{ todoStore.stats().total }}</span>
                  }
                </button>
              }
              @if (reviewHasContent()) {
                <button
                  class="inspector-toggle"
                  [class.active]="showReviewInspector()"
                  (click)="showReviewInspector.set(!showReviewInspector())"
                  [attr.aria-expanded]="showReviewInspector()"
                  title="Toggle review panel"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/>
                  </svg>
                  Review
                  @if (!showReviewInspector()) {
                    @if (reviewBadgeInfo(); as badge) {
                      <span class="inspector-badge" [class.severity-error]="badge.hasErrors">
                        {{ badge.issueCount }} {{ badge.issueCount === 1 ? 'issue' : 'issues' }}
                      </span>
                    }
                  }
                </button>
              }
              @if (hasChildren()) {
                <button
                  class="inspector-toggle"
                  [class.active]="showChildrenInspector()"
                  (click)="showChildrenInspector.set(!showChildrenInspector())"
                  [attr.aria-expanded]="showChildrenInspector()"
                  title="Toggle child agents"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
                    <circle cx="9" cy="7" r="4"/>
                    <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
                    <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                  </svg>
                  Agents ({{ inst.childrenIds.length }})
                </button>
              }
            </div>
          }
```

- [ ] **Step 2.3: Update inspector panels to wire review output events**

In the inspector panels section (lines 219-224), add the output event bindings to the review panel:

```html
              @if (showReviewInspector()) {
                <app-instance-review-panel
                  [instanceId]="inst.id"
                  [workingDirectory]="inst.workingDirectory"
                  (reviewStarted)="onReviewStarted()"
                  (reviewCompleted)="onReviewCompleted($event)"
                />
              }
```

- [ ] **Step 2.4: Add event handler methods and `openReviewPanel()` entry point**

In the component class, add handler methods:

```typescript
  onReviewStarted(): void {
    this.reviewHasContent.set(true);
  }

  onReviewCompleted(result: { issueCount: number; hasErrors: boolean }): void {
    this.reviewBadgeInfo.set(result);
  }

  /**
   * Open the review panel directly — resolves the chicken-and-egg problem
   * where the Review toggle is hidden until a review runs, but the user
   * needs a way to open the panel for the first review.
   *
   * Called from: keyboard shortcut (@HostListener in this component),
   * or any future command palette integration.
   */
  openReviewPanel(): void {
    this.reviewHasContent.set(true);
    this.showReviewInspector.set(true);
  }
```

- [ ] **Step 2.5: Add keyboard shortcut to open review panel**

The component already has a `@HostListener('window:keydown')` handler at `handleKeyboardShortcut()` (~line 778). Add the new shortcut inside that existing handler — do NOT create a second `@HostListener`:

```typescript
  @HostListener('window:keydown', ['$event'])
  handleKeyboardShortcut(event: KeyboardEvent): void {
    // Escape - interrupt busy instance
    if (event.key === 'Escape') {
      const inst = this.instance();
      if (inst && inst.status === 'busy') {
        event.preventDefault();
        this.onInterrupt();
      }
    }

    // Cmd/Ctrl + O - open folder selection
    if ((event.metaKey || event.ctrlKey) && event.key === 'o') {
      event.preventDefault();
      this.openFolderSelection();
    }

    // Cmd/Ctrl + Shift + V — open review panel
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'V') {
      event.preventDefault();
      this.openReviewPanel();
    }
  }
```

- [ ] **Step 2.6: Simplify Tasks badge condition**

In step 2.2 above, the Tasks badge condition was already simplified from:
```html
@if (todoStore.hasTodos() && !showTodoInspector())
```
to:
```html
@if (!showTodoInspector())
```

This is correct because the Tasks button is now only rendered when `todoStore.hasTodos()` is true, so the outer check is redundant.

- [ ] **Step 2.7: Verify compilation**

Run: `npx tsc --noEmit`
Expected: PASS

---

## Task 3: Auto-Expand Tasks on First Appearance

When the Tasks toggle first appears (AI starts tracking todos), automatically open the task panel so the user sees it immediately. One-time per instance — don't re-expand if user manually closes it.

**Files:**
- Modify: `src/renderer/app/features/instance-detail/instance-detail.component.ts:591-611` (signals/effects)

- [ ] **Step 3.1: Add auto-expand effect**

Add after the `anyInspectorVisible` computed:

```typescript
  // Auto-expand Tasks panel on first appearance (false → true transition).
  // Tracks per-instance so switching instances resets the guard.
  private todoAutoExpandedForInstance = signal<string | null>(null);

  private todoAutoExpandEffect = effect(() => {
    const inst = this.instance();
    const hasTodos = this.todoStore.hasTodos();
    if (!inst) return;

    // If instance changed, the guard resets naturally because
    // todoAutoExpandedForInstance won't match the new instance id
    if (hasTodos && this.todoAutoExpandedForInstance() !== inst.id) {
      this.todoAutoExpandedForInstance.set(inst.id);
      this.showTodoInspector.set(true);
    }
  });
```

This works because:
- When the instance changes, `inst.id` changes so the guard (`todoAutoExpandedForInstance`) no longer matches → eligible to fire again
- When `hasTodos` goes from false→true for the current instance, it fires once and records the instance id
- If user closes the panel and more todos arrive, the guard already matches → no re-expand

**Effect ordering with instance-change reset (Task 4):** There is no race condition. When the user switches instances, `instance()` changes synchronously, which triggers the `instanceChangeSync` effect (Task 4) to reset `showTodoInspector` to `false`. The `todoAutoExpandEffect` also re-runs since it reads `instance()`, but `todoStore.hasTodos()` is `false` at this point (the async `setSession()` hasn't loaded the new instance's todos yet). The auto-expand only fires later, when `setSession()` completes and `hasTodos()` transitions to `true` — well after the reset has already run. This is the intended flow: reset first (sync), then auto-expand if applicable (async).

- [ ] **Step 3.2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: PASS

---

## Task 4: State Reset on Instance Change

When the user switches instances, reset all inspector state so stale data from the previous instance doesn't show.

**Files:**
- Modify: `src/renderer/app/features/instance-detail/instance-detail.component.ts:596-600` (existing todoSessionSync effect)

- [ ] **Step 4.1: Extend existing instance-change effect to reset inspector state**

The component already has a `todoSessionSync` effect (line 597) that watches `instance()`. Extend it to also reset inspector state:

```typescript
  // Keep TodoStore session in sync and reset inspector state on instance change
  private instanceChangeSync = effect(() => {
    const inst = this.instance();
    void this.todoStore.setSession(inst?.sessionId ?? null);

    // Reset inspector panels on instance change
    this.showTodoInspector.set(false);
    this.showReviewInspector.set(false);
    this.showChildrenInspector.set(false);
    this.reviewHasContent.set(false);
    this.reviewBadgeInfo.set(null);
  });
```

Rename from `todoSessionSync` to `instanceChangeSync` for clarity.

**Note:** The `todoAutoExpandedForInstance` signal does NOT need explicit reset here — it self-resets because it compares against `inst.id` (see Task 3).

- [ ] **Step 4.2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: PASS

---

## Task 5: Entrance Animation + Error Badge Style

Animate the toggle bar in when it first appears. Add error severity styling for the review badge.

**Note:** The spec describes an attention pulse (`.entering` class + `animationend` listener) on the first toggle button. This is deferred — the slide-in animation is sufficient for launch, and the pulse can be added as a polish pass later without changing any data flow.

**Files:**
- Modify: `src/renderer/app/features/instance-detail/instance-detail.component.ts` — styles section, after the `.inspector-panels` block

- [ ] **Step 5.1: Add entrance animation and error badge style**

Add after the existing `.inspector-panels` styles:

```css
      /* Entrance animation for the toggle bar */
      @media (prefers-reduced-motion: no-preference) {
        .inspector-toggles {
          animation: inspectorSlideIn 200ms ease-out;
        }

        @keyframes inspectorSlideIn {
          from {
            opacity: 0;
            transform: translateY(-4px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      }

      .inspector-badge.severity-error {
        background: rgba(var(--error-rgb, 239, 68, 68), 0.15);
        color: var(--error-color, #ef4444);
      }
```

- [ ] **Step 5.2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: PASS

---

## Task 6: Accessibility

Add ARIA attributes and `aria-live` region for screen readers.

**Files:**
- Modify: `src/renderer/app/features/instance-detail/instance-detail.component.ts` — template (toggle bar section) and styles

- [ ] **Step 6.1: Add `aria-live` region to the toggle bar**

The template changes in Task 2 already include `role="toolbar"`, `aria-label`, and `aria-expanded`. Now add the `aria-live` announcement span inside the `.inspector-toggles` div (before the closing `</div>`):

```html
              <!-- Screen reader announcement for dynamically appearing toggles -->
              <span class="sr-only" aria-live="polite">
                @if (todoStore.hasTodos()) { Task list available. }
                @if (reviewHasContent()) { Review results available. }
              </span>
```

And add the `sr-only` class to the styles:

```css
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
```

- [ ] **Step 6.2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: PASS

---

## Task 7: Unit Tests

**Files:**
- Create: `src/renderer/app/features/instance-detail/instance-detail-inspectors.spec.ts`

- [ ] **Step 7.1: Write unit tests for inspector toggle visibility and auto-expand**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal, computed } from '@angular/core';

/**
 * Unit tests for the inspector toggle logic.
 *
 * These test the signal logic in isolation rather than the full Angular component,
 * because InstanceDetailComponent has heavy dependencies (IPC services, stores, etc.)
 * that make component-level testing impractical. We extract and test the logic.
 */

describe('Inspector Toggle Visibility Logic', () => {
  it('anyInspectorVisible returns false when no content exists', () => {
    const hasTodos = signal(false);
    const reviewHasContent = signal(false);
    const hasChildren = signal(false);

    const anyVisible = computed(() =>
      hasTodos() || reviewHasContent() || hasChildren()
    );

    expect(anyVisible()).toBe(false);
  });

  it('anyInspectorVisible returns true when todos exist', () => {
    const hasTodos = signal(true);
    const reviewHasContent = signal(false);
    const hasChildren = signal(false);

    const anyVisible = computed(() =>
      hasTodos() || reviewHasContent() || hasChildren()
    );

    expect(anyVisible()).toBe(true);
  });

  it('anyInspectorVisible returns true when review has content', () => {
    const hasTodos = signal(false);
    const reviewHasContent = signal(true);
    const hasChildren = signal(false);

    const anyVisible = computed(() =>
      hasTodos() || reviewHasContent() || hasChildren()
    );

    expect(anyVisible()).toBe(true);
  });

  it('anyInspectorVisible returns true when children exist', () => {
    const hasTodos = signal(false);
    const reviewHasContent = signal(false);
    const hasChildren = signal(true);

    const anyVisible = computed(() =>
      hasTodos() || reviewHasContent() || hasChildren()
    );

    expect(anyVisible()).toBe(true);
  });
});

describe('Review Badge Info', () => {
  it('stores issue count and error flag from review completion', () => {
    const reviewBadgeInfo = signal<{ issueCount: number; hasErrors: boolean } | null>(null);

    reviewBadgeInfo.set({ issueCount: 3, hasErrors: true });
    expect(reviewBadgeInfo()).toEqual({ issueCount: 3, hasErrors: true });
  });

  it('resets on instance change', () => {
    const reviewBadgeInfo = signal<{ issueCount: number; hasErrors: boolean } | null>(null);
    reviewBadgeInfo.set({ issueCount: 5, hasErrors: false });

    // Simulate instance change
    reviewBadgeInfo.set(null);
    expect(reviewBadgeInfo()).toBeNull();
  });
});

describe('Auto-expand Tasks', () => {
  it('should auto-expand on first todo appearance for an instance', () => {
    const showTodoInspector = signal(false);
    const todoAutoExpandedForInstance = signal<string | null>(null);
    const instanceId = 'instance-1';
    const hasTodos = true;

    // Simulate the effect logic
    if (hasTodos && todoAutoExpandedForInstance() !== instanceId) {
      todoAutoExpandedForInstance.set(instanceId);
      showTodoInspector.set(true);
    }

    expect(showTodoInspector()).toBe(true);
    expect(todoAutoExpandedForInstance()).toBe(instanceId);
  });

  it('should NOT re-expand if already triggered for this instance', () => {
    const showTodoInspector = signal(false);
    const todoAutoExpandedForInstance = signal<string | null>('instance-1');
    const instanceId = 'instance-1';
    const hasTodos = true;

    // Simulate the effect logic — guard should prevent re-expand
    if (hasTodos && todoAutoExpandedForInstance() !== instanceId) {
      todoAutoExpandedForInstance.set(instanceId);
      showTodoInspector.set(true);
    }

    expect(showTodoInspector()).toBe(false); // Should remain false
  });

  it('should re-expand for a different instance', () => {
    const showTodoInspector = signal(false);
    const todoAutoExpandedForInstance = signal<string | null>('instance-1');
    const instanceId = 'instance-2';
    const hasTodos = true;

    // Simulate the effect logic — different instance, should fire
    if (hasTodos && todoAutoExpandedForInstance() !== instanceId) {
      todoAutoExpandedForInstance.set(instanceId);
      showTodoInspector.set(true);
    }

    expect(showTodoInspector()).toBe(true);
    expect(todoAutoExpandedForInstance()).toBe('instance-2');
  });
});
```

- [ ] **Step 7.2: Run the tests**

Run: `npx vitest run src/renderer/app/features/instance-detail/instance-detail-inspectors.spec.ts`
Expected: All tests PASS

- [ ] **Step 7.3: Verify full compilation**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS

---

## Task 8: Lint + Final Verification

- [ ] **Step 8.1: Run lint on all modified files**

Run: `npx eslint src/renderer/app/features/instance-detail/instance-detail.component.ts src/renderer/app/features/instance-detail/instance-review-panel.component.ts src/renderer/app/features/instance-detail/instance-detail-inspectors.spec.ts`
Expected: PASS (or fix any issues)

- [ ] **Step 8.2: Run full test suite**

Run: `npm run test`
Expected: PASS

- [ ] **Step 8.3: Manual testing checklist**

Verify in the running app:
1. Start a session → no toggle bar visible between output and input
2. Send a message that triggers TodoWrite → toggle bar slides in, Tasks panel auto-opens
3. Collapse Tasks panel → badge shows `completed/total` count
4. Switch to another instance → toggle bar disappears, state resets
5. Press Ctrl+Shift+V → Review panel opens, Review toggle appears in toggle bar
6. Run a review → Review badge shows issue count when panel is collapsed
7. Close and reopen review → toggle persists (`reviewHasContent` stays true)
8. Switch instances again → review toggle disappears (state resets)
