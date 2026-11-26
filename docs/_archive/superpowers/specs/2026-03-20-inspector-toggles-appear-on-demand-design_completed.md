# Inspector Toggles: Appear on Demand

**Date:** 2026-03-20
**Status:** Approved
**Scope:** `instance-detail.component.ts`, `todo-list.component.ts`, `instance-review-panel.component.ts`

## Problem

The instance detail view has an inspector toggle bar (Tasks, Review, and conditionally Agents) that sits between the output stream and the input composer. These toggles are always visible even when they have no content:

- **Tasks** renders an empty panel (the `TodoListComponent` guards on `hasTodos()` and shows nothing)
- **Review** is visible whenever any changed files exist in the working directory, even if no review has been requested

The result: permanent visual noise between the chat and the composer that serves no purpose most of the time. The user reports never using these buttons because they always appear empty.

## Solution

**Hide toggle buttons by default. Show them only when they have meaningful content.** When they appear, use subtle animation and a one-time attention pulse so the user notices.

## Design

### 1. Visibility Rules

Each inspector toggle is only rendered when it has content:

| Toggle | Visibility condition |
|--------|---------------------|
| **Tasks** | `todoStore.hasTodos()` — at least one todo item exists for the session |
| **Review** | `reviewHasContent()` — a review session has been run for this instance (see Section 7 for how this is tracked). Hidden entirely until a review is triggered. |
| **Agents** | `inst.childrenIds.length > 0` — unchanged, already works this way |

The `.inspector-toggles` container div is only rendered when at least one toggle is visible. When no toggles are visible (the common case), the layout collapses to **Output Stream → Input Panel** with nothing between.

### 2. Entrance Animation

When a toggle first appears (e.g., AI creates a todo mid-conversation):

- **Container**: The `.inspector-toggles` div animates in using `grid-template-rows: 0fr → 1fr` with opacity fade, ~200ms `ease-out`. This avoids the timing issues of `max-height` hacks and is well-supported in Electron's Chromium.
- **Attention pulse**: The newly-appeared toggle button gets a single CSS glow pulse on its border using `--primary-color` (gold). The animation plays once (`animation-iteration-count: 1`) and lasts ~600ms. The `.entering` class is applied on appearance and removed via an `animationend` event listener to prevent replaying on re-render.
- **No pulse on subsequent additions**: If the toggle bar is already visible and a new toggle appears alongside (e.g., Tasks is showing, then Agents appears), the new button fades in but does not pulse — the bar is already noticed.
- **Reduced motion**: All animations are wrapped in `@media (prefers-reduced-motion: no-preference)`. When the user prefers reduced motion, toggles appear instantly with no animation or pulse.

### 3. Auto-expand on First Appearance

- **Tasks**: When the Tasks toggle first appears (AI just started tracking todos), it automatically sets `showTodoInspector` to `true` so the task list panel opens immediately. This is a **one-time** action per instance: an `effect()` watches `todoStore.hasTodos()` and tracks the previous value to detect the `false → true` transition. If the user manually collapses Tasks and the AI adds more items, it does not re-expand. If the user switches instances, the tracking resets (see Section 6).
- **Review**: Does NOT auto-expand. The toggle appears with a badge showing status, but the panel stays collapsed. Reviews are user-initiated workflows; auto-expanding would be presumptuous.
- **Agents**: No change to current behavior.

### 4. Disappearance Rules

- **Tasks**: Toggle stays visible as long as `todoStore.hasTodos()` is true. It disappears when the session changes (new instance selected) or the todo list is explicitly cleared. Completed todos still count — the user may want to review what was done.
- **Review**: Toggle stays visible as long as `reviewHasContent()` is true. Resets on instance change.
- **Agents**: Already correct — disappears when `childrenIds` is empty.

No exit animation needed. Disappearance is tied to session/instance changes where the whole view is re-rendering anyway.

### 5. Badge Behavior

- **Tasks**: Show the badge with `completed/total` count (e.g., `3/7`) when the panel is **closed**. The current template condition `@if (todoStore.hasTodos() && !showTodoInspector())` simplifies to `@if (!showTodoInspector())` since the Tasks toggle is now only rendered when `hasTodos()` is true. When the panel is open, the user can already see all the tasks — the badge would be redundant.
- **Review**: Add a badge showing review status. The review panel emits two output events: `reviewStarted = output<void>()` when a review begins, and `reviewCompleted = output<{ issueCount: number; hasErrors: boolean }>()` when results are available. The parent stores this in `reviewBadgeInfo = signal<{ issueCount: number; hasErrors: boolean } | null>(null)`. Badge format: `"running"` while in progress, `"N issues"` when complete. Severity coloring: if `hasErrors` is true, badge uses `--error-color`; otherwise default `--primary-color`.
- **Agents**: Already shows count in button text `Agents (3)`. No change.

### 6. State Reset on Instance Change

When the selected instance changes:

- `showTodoInspector`, `showReviewInspector`, `showChildrenInspector` are all reset to `false`.
- The auto-expand "has been triggered" tracking for Tasks resets (so it can fire again for the new instance if that instance has todos).
- The `reviewHasContent` signal resets to `false`.

This is implemented via an `effect()` watching `instance()` (or `inst.id`). The existing codebase already has instance-change effects in this component, so this follows the established pattern.

### 7. Review Toggle Visibility — Architectural Approach

**Problem**: The `sessionStatus()` signal that tracks whether a review is running/completed lives inside `InstanceReviewPanelComponent` (line 353). The parent `InstanceDetailComponent` cannot read it because: (a) there is no `@ViewChild` reference, and (b) the child is conditionally rendered inside `@if (showReviewInspector())` so it doesn't exist in the DOM until the toggle is clicked.

**Solution**: Track review state in the parent via a simple `reviewHasContent` signal. The Review toggle is **fully hidden** until a review has been triggered.

1. Add a `reviewHasContent = signal(false)` to `InstanceDetailComponent`.
2. Add a `reviewStarted = output<void>()` event to `InstanceReviewPanelComponent` that fires when the user clicks "Run review".
3. When the review panel emits `reviewStarted`, set `reviewHasContent` to `true` in the parent.
4. The toggle visibility condition is: `reviewHasContent()`.

**Entry points for the first review** (since the toggle is hidden before any review runs):
- **Command palette**: The existing command palette can include a "Run Review" command that opens the review panel directly (sets `showReviewInspector` to `true`).
- **Keyboard shortcut**: A keybinding can open the review panel. The specific key is deferred to implementation (note: `Cmd+Shift+R` is already bound to "Restart Instance").
- **The review panel is always rendered when `showReviewInspector` is true** — the parent just conditionally renders it. The toggle button's visibility is separate from the panel's rendering. The user can open the panel via command palette/shortcut, trigger a review, and then the toggle button appears for subsequent access.

This avoids the chicken-and-egg problem without resorting to an always-visible subdued toggle, which would undermine the core goal of removing visual noise.

### 8. Review Panel Internal `visible()` — Deduplication

The `InstanceReviewPanelComponent` has its own `visible()` computed:
```typescript
visible = computed(() =>
  this.expanded() || this.sessionStatus() !== null || this.files().length > 0
);
```

With the parent now controlling when the review panel renders (via `@if (showReviewInspector())`), this internal guard creates **dual visibility control**. Simplify: change the review panel's `visible()` to always return `true` (or remove the `@if (visible())` wrapper in its template). The parent owns the decision of whether the panel is rendered; the child should not second-guess it.

### 9. Accessibility

- Toggle buttons get `[attr.aria-expanded]="showTodoInspector()"` (and equivalent for Review, Agents).
- The `.inspector-toggles` container gets `role="toolbar"` and `aria-label="Session inspectors"`.
- When a toggle dynamically appears, an `aria-live="polite"` region announces it. Implementation: a visually-hidden `<span>` inside the toggle bar that updates text when toggles appear (e.g., "Task list available").
- All entrance animations respect `prefers-reduced-motion` (see Section 2).

## Files Changed

### `src/renderer/app/features/instance-detail/instance-detail.component.ts`

**Template changes:**
- Wrap `.inspector-toggles` div in `@if (anyInspectorVisible())`
- Add `role="toolbar"` and `aria-label` to `.inspector-toggles`
- Add `aria-expanded` bindings to all toggle buttons
- Wrap Tasks toggle in `@if (todoStore.hasTodos())`
- Wrap Review toggle in `@if (reviewHasContent())`
- Simplify Tasks badge condition from `@if (todoStore.hasTodos() && !showTodoInspector())` to `@if (!showTodoInspector())`
- Add Review badge markup
- Add visually-hidden `aria-live` span for screen reader announcements

**Style changes:**
- Add `@keyframes inspectorSlideIn` using `grid-template-rows: 0fr → 1fr` + opacity
- Add `@keyframes inspectorPulse` for the single border glow
- Add `.inspector-toggle.entering` class with the pulse animation
- Add `.inspector-badge.severity-error` class (error color for review badges with critical/error issues)
- Wrap all animation keyframes in `@media (prefers-reduced-motion: no-preference)`

**Component class changes:**
- Add `reviewHasContent = signal(false)` — tracks whether a review session has been run for this instance
- Add `reviewBadgeInfo = signal<{ issueCount: number; hasErrors: boolean } | null>(null)` — stores review result summary for badge display
- Add `anyInspectorVisible` computed signal: `todoStore.hasTodos() || reviewHasContent() || hasChildren()`
- Add `effect()` watching `todoStore.hasTodos()` with previous-value tracking for auto-expand (false → true transition only, one-time per instance)
- Add `effect()` watching `instance()` to reset inspector state on instance change
- Add `entering` signal + `animationend` listener cleanup for the pulse animation
- Handle `reviewStarted` and `reviewCompleted` output events from review panel

### `src/renderer/app/features/instance-detail/instance-review-panel.component.ts`

- Add `output` to imports from `@angular/core`
- Add `reviewStarted = output<void>()` — emitted when the user clicks "Run review"
- Add `reviewCompleted = output<{ issueCount: number; hasErrors: boolean }>()` — emitted when review session completes, carrying issue count and whether any are error/critical severity
- Simplify or remove the internal `visible()` computed and its `@if` template guard, since the parent now controls rendering

### `src/renderer/app/core/state/todo.store.ts`

- No changes needed. Already exposes `hasTodos()` and `stats()` as public signals.

## Testing

### Unit Tests

- `anyInspectorVisible` computed: returns `false` when no todos, no review content, no children; returns `true` when any condition is met
- Auto-expand effect: verify `showTodoInspector` is set to `true` on `hasTodos()` false→true transition; verify it does NOT re-fire on subsequent todo additions; verify it resets on instance change
- `reviewHasContent` signal: verify it resets on instance change; verify it sets to true on `reviewStarted` event
- Badge rendering: verify Tasks badge renders when `showTodoInspector` is false; verify it hides when panel is open

### Manual Testing

- Start a session → verify no toggle bar visible between output and input
- Send a message that triggers TodoWrite → verify toggle bar slides in with pulse, Tasks panel auto-opens
- Collapse Tasks panel → verify badge shows count (e.g., "1/3")
- Switch to another instance → verify toggle bar disappears and state resets
- Open Review panel via command palette → run a review → verify Review toggle appears with badge
- Close and reopen the review → verify toggle persists (reviewHasContent stays true)

## Out of Scope

- Changing the inspector panel overlay/positioning (approach B — floating chips)
- Rendering tasks inline in the output stream (approach C)
- Changes to the Repo Jobs page (`/tasks` route) — that's a separate feature
- Changes to the Agents toggle behavior (already works correctly)
