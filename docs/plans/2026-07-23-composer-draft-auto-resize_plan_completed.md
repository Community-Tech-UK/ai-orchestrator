# Composer Draft Auto-Resize Implementation Plan

> **For agentic workers:** Implement inline in the current session. Do not commit unless James explicitly asks. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a restored session draft's textarea at the height required by its current content.

**Architecture:** Keep draft text in the existing stores and treat height as derived DOM state. A component effect observes the message plus textarea view child and funnels every restore/update through the existing animation-frame scheduler; the scheduler resets before measuring so it can expand and contract.

**Tech Stack:** Angular 21 signals and signal queries, TypeScript, Vitest/JSDOM, Playwright CLI against the renderer benchmark harness.

## Global Constraints

- Preserve all unrelated dirty-tree changes.
- Do not commit or push.
- Do not persist pixel heights per session.
- Keep the existing `min(30vh, 220px)` maximum.
- Verify behaviour in the renderer benchmark before changing tests.

---

### Task 1: Make textarea height derived from active message content

**Files:**

- Modify: `src/renderer/app/features/instance-detail/input-panel.component.ts`

**Interfaces:**

- Consumes: `message(): string` and `textareaRef(): ElementRef<HTMLTextAreaElement> | undefined`.
- Produces: one scheduled resize per animation frame through `scheduleTextareaResize(textarea)`.

- [x] **Step 1: Add the reactive resize invariant**

Add an effect after draft synchronization that tracks both the message and textarea view child:

```ts
effect(() => {
  this.message();
  const textarea = this.textareaRef()?.nativeElement;
  if (textarea) {
    this.scheduleTextareaResize(textarea);
  }
});
```

The effect must not persist drafts or dispatch an input event.

- [x] **Step 2: Measure unconstrained content before clamping**

Update the scheduled callback:

```ts
requestAnimationFrame(() => {
  this.resizeScheduled = false;
  const maxHeight = Math.min(window.innerHeight * 0.3, 220);
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
});
```

- [x] **Step 3: Re-run the renderer benchmark reproduction**

Use `window.__workspaceBench.runThreadSwitchBenchmark(0)` in `?bench=1`, enter a 12-line draft in Benchmark light, switch to Benchmark medium, choose New Session, and return to Benchmark light.

Expected:

- Benchmark medium contracts to its one-row content height.
- Benchmark light returns with all draft text and an inline height of `220px`, not a `51px` client height.

---

### Task 2: Add regression coverage after UI confirmation

**Files:**

- Modify: `src/renderer/app/features/instance-detail/input-panel.component.spec.ts`

**Interfaces:**

- Consumes: real `InputPanelComponent` template and a draft-service test double keyed by instance id.
- Produces: regression coverage for initial restore and session-switch resize scheduling.

- [x] **Step 1: Extend the draft-service test double**

Return a mutable drafts map and a real `textVersion` signal so the test can model two session drafts without bypassing the component's synchronization effect.

- [x] **Step 2: Add a focused resize lifecycle test**

Stub `requestAnimationFrame` to collect callbacks. Set the component input with:

```ts
fixture.componentRef.setInput('instanceId', 'inst-long');
```

Provide a long draft for `inst-long`, flush change detection and the scheduled frame, and verify the textarea receives the clamped height. Switch to `inst-short`, flush again, and verify the scheduler resets to `auto` before measuring and assigns the shorter height.

- [x] **Step 3: Run the targeted spec**

Run:

```bash
rtk npm run test:quiet -- src/renderer/app/features/instance-detail/input-panel.component.spec.ts
```

Expected: all tests in the file pass.

---

### Task 3: Complete project verification and close working documents

**Files:**

- Rename: `docs/plans/2026-07-23-composer-draft-auto-resize_plan.md` to `docs/plans/2026-07-23-composer-draft-auto-resize_plan_completed.md`
- Rename: `docs/plans/2026-07-23-composer-draft-auto-resize_spec_planned.md` to `docs/plans/2026-07-23-composer-draft-auto-resize_spec_completed.md`

- [x] **Step 1: Run canonical gates**

```bash
rtk npx tsc --noEmit
rtk npx tsc --noEmit -p tsconfig.spec.json
rtk npm run lint
rtk npm run check:ts-max-loc
rtk npm run test:quiet
```

Expected: every applicable command exits `0`. Any unrelated dirty-tree blocker is recorded exactly and not hidden.

Final gate evidence (2026-07-25 closing run, all commands exited `0`):

- Focused component spec: 1 file, 7/7 tests passed.
- `npx tsc --noEmit`: exit `0`.
- `npx tsc --noEmit -p tsconfig.spec.json`: exit `0`, no diagnostics.
- `npm run lint`: exit `0`, "All files pass linting."
- `npm run check:ts-max-loc`: exit `0`, ratchet passed over 2,540 production files.
- `git diff --check`: exit `0`.
- `npm run test:quiet` (full suite): exit `0`, 1,572 files and 15,577 tests
  passed in 450s.

Earlier runs of this plan recorded two full-suite failures in the unrelated
`src/main/diagnostics/heap-snapshot.spec.ts` with `Cannot create a string longer
than 0x1fffffe8 characters`. The closing full-suite run above passed with no such
failure. That test is load-sensitive rather than broken by this change: at
`src/main/diagnostics/heap-snapshot.spec.ts:51` it reads the whole heap-snapshot
file into a JavaScript string to inspect only its first 32 characters, so it
throws when full-suite memory pressure pushes the snapshot past Node's maximum
string length. It touches no composer code. Making that test independent of heap
size is a worthwhile follow-up but is outside this plan's scope, so no change was
made to it here.

A concurrent writer held unrelated edits to `src/main/cli/adapters/` during this
run. Those changes were left untouched.

- [x] **Step 2: Record as-built evidence**

Update the specification and plan with the implemented code path, renderer dimension evidence, targeted test result, and canonical gate results.

- [x] **Step 3: Close the documents**

Rename both documents with `_completed`, update the specification's plan link to the completed filename, and verify their final Git status. Do not stage or commit them.

## As-Built Notes

The component now reacts to restored or otherwise programmatically changed
message content and schedules height derivation for the current textarea. The
scheduler resets height before measuring, retains the latest target while
coalescing animation-frame work, and clears that target on destruction.

Renderer evidence after the change:

- 527-character long draft: `220px` client height with `298px` scroll height;
- empty session: `51px` client height;
- same restored 527-character draft after returning: `220px` client height.

The implementation and focused tests are complete, and the full canonical gate
now passes end to end, so this plan is closed.

The renderer dimension evidence above was captured in the implementation session
against the `?bench=1` harness and is reproduced here as recorded evidence rather
than re-measured during the closing gate run; the expansion, contraction, and
remount behaviour it describes is covered by the focused component spec.
