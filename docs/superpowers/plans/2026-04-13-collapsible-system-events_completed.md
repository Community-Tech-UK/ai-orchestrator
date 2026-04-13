# Collapsible System Event Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse runs of repetitive orchestration system messages (e.g. `get_children` polling) into a single accordion display item that shows the most recent state at a glance, mirroring the existing `app-thought-process` UX.

**Architecture:** Renderer-only change. Extend `DisplayItemProcessor` to detect and group consecutive orchestration messages by `metadata.action` (with empty assistant turns absorbed and a 5-min time-gap ceiling), introduce a new `'system-event-group'` `DisplayItem` variant, render it through a new standalone `app-system-event-group` component that mirrors the visual style and `ExpansionStateService` integration of `app-thought-process`. No producer code in `instance-orchestration.ts` is modified.

**Tech Stack:** Angular 21 (zoneless, signals, standalone components, `OnPush`), TypeScript 5.9, Vitest. The new component uses the existing `MarkdownService` and `ExpansionStateService`.

**Spec:** `docs/superpowers/specs/2026-04-13-collapsible-system-events-design.md`

---

## File Structure

**Modified:**
- `src/renderer/app/features/instance-detail/display-item-processor.service.ts`
  → Adds `'system-event-group'` to the `DisplayItem` union, adds 4 new optional fields, adds the grouping pass and helpers, exports new constants.
- `src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts`
  → Adds 8 new test cases covering the grouping behaviour.
- `src/renderer/app/features/instance-detail/output-stream.component.ts`
  → Adds one template branch for the new display item type and one import.

**Created:**
- `src/renderer/app/shared/components/system-event-group/system-event-group.component.ts`
  → New standalone component, mirrors `app-thought-process` structure.

**Untouched (deliberately):**
- `src/main/instance/instance-orchestration.ts` — message production is unchanged.
- `src/renderer/app/shared/components/thought-process/thought-process.component.ts` — used as a stylistic template only, no code shared.

---

## Task 1: Extend `DisplayItem` with the new variant and group fields

**Files:**
- Modify: `src/renderer/app/features/instance-detail/display-item-processor.service.ts:12-26`

This is a pure type change so the rest of the plan can compile. No behaviour change yet; existing tests must still pass.

- [ ] **Step 1: Read the current `DisplayItem` interface to confirm context**

Open `src/renderer/app/features/instance-detail/display-item-processor.service.ts`. Confirm the interface currently looks like the snippet shown in the spec (lines ~12-26).

- [ ] **Step 2: Replace the interface with the extended version**

Replace the existing interface block with:

```typescript
export interface DisplayItem {
  id: string;
  type: 'message' | 'tool-group' | 'thought-group' | 'system-event-group';
  message?: OutputMessage;
  renderedMessage?: unknown;  // SafeHtml at runtime, set by consuming component
  toolMessages?: OutputMessage[];
  thinking?: ThinkingContent[];
  thoughts?: string[];
  response?: OutputMessage;
  renderedResponse?: unknown;  // SafeHtml at runtime, set by consuming component
  timestamp?: number;
  repeatCount?: number;
  showHeader?: boolean;
  bufferIndex?: number;
  // ── system-event-group fields ──
  /** Non-empty orchestration messages that make up this group, in chronological order. */
  systemEvents?: OutputMessage[];
  /** The shared `metadata.action` value, e.g. `'get_children'`. */
  groupAction?: string;
  /** Friendly label resolved from `groupAction`, e.g. `'Active children polled'`. */
  groupLabel?: string;
  /** Single-line preview derived from the latest event's content, truncated for the header. */
  groupPreview?: string;
}
```

- [ ] **Step 3: Run the typecheck**

Run: `npx tsc --noEmit`
Expected: PASS — no errors.

- [ ] **Step 4: Run the spec typecheck and existing tests**

Run: `npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS.

Run: `npx vitest run src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts`
Expected: PASS — all existing tests still pass (no behaviour change).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/app/features/instance-detail/display-item-processor.service.ts
git commit -m "feat(transcript): add system-event-group variant to DisplayItem"
```

---

## Task 2: Add module-level constants and the action-label map

**Files:**
- Modify: `src/renderer/app/features/instance-detail/display-item-processor.service.ts` (top of file, after imports)

Adds the constants and the pure helper that turns an action string into a human label. Tested via the next task's behaviour tests, but introduce them as a separate commit so the diff stays small.

- [ ] **Step 1: Add constants and the label helper just above the `DisplayItemProcessor` class**

Insert this block immediately after the `TIME_GAP_THRESHOLD` constant on line 28:

```typescript
/**
 * Maximum wall-clock gap allowed between consecutive members of a
 * system-event-group. A new accordion is started after this much idle.
 */
const SYSTEM_GROUP_TIME_GAP_MS = 5 * 60 * 1000;

/**
 * Orchestration `metadata.action` values that must always render as their own
 * standalone system bubble — never absorbed into a system-event-group.
 *
 * These are state-changing events the user needs to see immediately; bucketing
 * them under an accordion would hide important signal.
 */
const ALWAYS_VISIBLE_SYSTEM_ACTIONS: ReadonlySet<string> = new Set([
  'task_complete',
  'task_error',
  'child_completed',
  'all_children_completed',
  'request_user_action',
  'user_action_response',
  'unknown',
]);

/**
 * Friendly labels for grouped orchestration actions. Anything not listed falls
 * back to humanising the action name (snake_case → Sentence case).
 */
const SYSTEM_ACTION_LABELS: Readonly<Record<string, string>> = {
  get_children: 'Active children polled',
  get_child_output: 'Child output fetched',
  get_child_summary: 'Child summary fetched',
  get_child_artifacts: 'Child artifacts fetched',
  get_child_section: 'Child section fetched',
  task_progress: 'Task progress',
  call_tool: 'Tool calls',
  message_child: 'Messages to children',
  spawn_child: 'Child spawned',
  terminate_child: 'Children terminated',
};

/**
 * Maximum length of the single-line preview rendered in the collapsed header.
 * Longer previews are truncated with an ellipsis.
 */
const SYSTEM_GROUP_PREVIEW_MAX_LEN = 120;

/**
 * Resolve the friendly label for an orchestration action. Falls back to a
 * humanised version of the snake_case action name.
 */
export function resolveSystemActionLabel(action: string): string {
  const known = SYSTEM_ACTION_LABELS[action];
  if (known) return known;
  // Humanise: replace underscores with spaces, capitalise the first letter only.
  const spaced = action.replace(/_/g, ' ').trim();
  if (!spaced) return 'System event';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Reduce a markdown message to a single line suitable for an accordion header:
 * strip common markdown emphasis markers, collapse whitespace, truncate.
 */
export function buildSystemGroupPreview(content: string): string {
  if (!content) return '';
  const stripped = content
    // Drop fenced code blocks entirely.
    .replace(/```[\s\S]*?```/g, ' ')
    // Strip inline code backticks but keep contents.
    .replace(/`([^`]*)`/g, '$1')
    // Strip bold/italic markers.
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    // Strip leading list/heading markers on each line.
    .replace(/^\s*[-*#>]+\s*/gm, '')
    // Collapse all whitespace (including newlines) to single spaces.
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length <= SYSTEM_GROUP_PREVIEW_MAX_LEN) return stripped;
  return stripped.slice(0, SYSTEM_GROUP_PREVIEW_MAX_LEN - 1).trimEnd() + '…';
}
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Run all existing tests for the file**

Run: `npx vitest run src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts`
Expected: PASS — no behaviour change yet.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/app/features/instance-detail/display-item-processor.service.ts
git commit -m "feat(transcript): add constants and label helper for system-event grouping"
```

---

## Task 3: TDD — group two consecutive `get_children` system messages

**Files:**
- Modify: `src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts`
- Modify: `src/renderer/app/features/instance-detail/display-item-processor.service.ts`

First behaviour change. The grouping logic is introduced in this task and refined in subsequent tasks.

- [ ] **Step 1: Add a helper for orchestration messages at the top of the spec file**

Open `src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts`. Just after the existing `makeMsg` helper (around line 13), add:

```typescript
function makeOrchMsg(
  action: string,
  content: string,
  overrides: Partial<OutputMessage> = {},
): OutputMessage {
  return {
    id: `orch-${Math.random().toString(36).slice(2)}`,
    type: 'system',
    content,
    timestamp: Date.now(),
    metadata: { source: 'orchestration', action, status: 'SUCCESS', rawData: {} },
    ...overrides,
  };
}
```

- [ ] **Step 2: Add the failing test**

Add inside the `describe('DisplayItemProcessor', …)` block (place after the existing system-message test around line 62):

```typescript
it('should group two consecutive orchestration messages with the same action', () => {
  const msgs = [
    makeOrchMsg('get_children', '**Active children:**\n- foo idle', {
      id: 'g1', timestamp: 1_000,
    }),
    makeOrchMsg('get_children', '**Active children:**\n- foo busy', {
      id: 'g2', timestamp: 2_000,
    }),
  ];
  const items = processor.process(msgs);
  expect(items.length).toBe(1);
  expect(items[0].type).toBe('system-event-group');
  expect(items[0].systemEvents?.length).toBe(2);
  expect(items[0].groupAction).toBe('get_children');
  expect(items[0].groupLabel).toBe('Active children polled');
  expect(items[0].groupPreview).toContain('foo busy');  // latest content
});
```

- [ ] **Step 3: Run the test to confirm it fails**

Run: `npx vitest run src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts -t "group two consecutive"`
Expected: FAIL — the items array currently contains 2 individual `'message'` items, not 1 `'system-event-group'`.

- [ ] **Step 4: Implement the grouping logic**

In `display-item-processor.service.ts`, locate the `mergeNewItems` method (around line 152). Find the system-message exclusion comment block (~line 189-204):

```typescript
      // Collapse consecutive identical messages — but never system messages.
      // System notices (restore warnings, compaction boundaries, etc.) should
      // always appear individually so they aren't mistaken for duplicated noise.
      if (
        item.type === 'message' &&
        last?.type === 'message' &&
        item.message &&
        last.message &&
        item.message.type !== 'system' &&
        item.message.type === last.message.type &&
        item.message.content === last.message.content
      ) {
        last.repeatCount = (last.repeatCount ?? 1) + 1;
        last.bufferIndex = item.bufferIndex;
        continue;
      }

      this.items.push(item);
    }
```

Insert a new block immediately above `this.items.push(item);` (still inside the `for` loop, after the repeat-collapse `if`):

```typescript
      // Orchestration system-event grouping — collapse runs of repetitive
      // orchestration messages with the same `metadata.action` into an
      // accordion display item. See SYSTEM_GROUP_* constants for thresholds.
      if (
        item.type === 'message' &&
        item.message?.type === 'system' &&
        this.isGroupableOrchestration(item.message)
      ) {
        const action = (item.message.metadata as { action: string }).action;
        const candidate = this.items[this.items.length - 1];

        if (
          candidate?.type === 'system-event-group' &&
          candidate.groupAction === action &&
          this.withinSystemGroupGap(candidate, item.message)
        ) {
          this.appendToSystemGroup(candidate, item.message);
          continue;
        }

        if (
          candidate?.type === 'message' &&
          candidate.message?.type === 'system' &&
          this.isGroupableOrchestration(candidate.message) &&
          (candidate.message.metadata as { action: string }).action === action &&
          item.message.timestamp - candidate.message.timestamp <= SYSTEM_GROUP_TIME_GAP_MS
        ) {
          this.promoteToSystemGroup(this.items.length - 1, candidate.message, item.message);
          continue;
        }
      }

      this.items.push(item);
    }
```

Then add these helper methods to the `DisplayItemProcessor` class (place them just below `mergeNewItems`):

```typescript
  private isGroupableOrchestration(msg: OutputMessage): boolean {
    const meta = msg.metadata as { source?: unknown; action?: unknown } | undefined;
    if (!meta || meta.source !== 'orchestration') return false;
    const action = meta.action;
    if (typeof action !== 'string' || !action) return false;
    return !ALWAYS_VISIBLE_SYSTEM_ACTIONS.has(action);
  }

  private withinSystemGroupGap(group: DisplayItem, next: OutputMessage): boolean {
    const events = group.systemEvents;
    if (!events || events.length === 0) return true;
    const last = events[events.length - 1];
    return next.timestamp - last.timestamp <= SYSTEM_GROUP_TIME_GAP_MS;
  }

  private appendToSystemGroup(group: DisplayItem, msg: OutputMessage): void {
    if (!group.systemEvents) group.systemEvents = [];
    group.systemEvents.push(msg);
    group.groupPreview = buildSystemGroupPreview(msg.content);
    group.timestamp = msg.timestamp;
    group.bufferIndex = (group.bufferIndex ?? 0) + 1;  // updated by caller-passed bufferIndex below
    // Note: bufferIndex tracking for groups is approximate; the latest non-empty
    // member's index is what we need for fork-from-here. Caller will overwrite.
  }

  private promoteToSystemGroup(
    indexToReplace: number,
    first: OutputMessage,
    second: OutputMessage,
  ): void {
    const action = (first.metadata as { action: string }).action;
    const group: DisplayItem = {
      id: `sysgrp-${first.id}`,
      type: 'system-event-group',
      systemEvents: [first, second],
      groupAction: action,
      groupLabel: resolveSystemActionLabel(action),
      groupPreview: buildSystemGroupPreview(second.content),
      timestamp: second.timestamp,
      bufferIndex: this.items[indexToReplace].bufferIndex,
    };
    this.items[indexToReplace] = group;
  }
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `npx vitest run src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts -t "group two consecutive"`
Expected: PASS.

Then run the full file to confirm no regressions:
Run: `npx vitest run src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts`
Expected: ALL PASS.

- [ ] **Step 6: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/app/features/instance-detail/display-item-processor.service.ts \
        src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts
git commit -m "feat(transcript): group consecutive orchestration system messages"
```

---

## Task 4: TDD — third matching message extends an existing group

**Files:**
- Modify: `src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts`

The append branch (`candidate.type === 'system-event-group'`) is already in the code from Task 3. This task adds a regression test confirming the count keeps growing across `process()` calls.

- [ ] **Step 1: Add the failing-then-passing test**

Add to the spec, after the Task 3 test:

```typescript
it('should extend an existing system-event-group across process() calls', () => {
  const m1 = makeOrchMsg('get_children', '**Active children:**\n- a idle', {
    id: 'g1', timestamp: 1_000,
  });
  const m2 = makeOrchMsg('get_children', '**Active children:**\n- a busy', {
    id: 'g2', timestamp: 2_000,
  });
  processor.process([m1, m2]);

  const m3 = makeOrchMsg('get_children', '**Active children:**\n- a done', {
    id: 'g3', timestamp: 3_000,
  });
  const items = processor.process([m1, m2, m3]);

  expect(items.length).toBe(1);
  expect(items[0].type).toBe('system-event-group');
  expect(items[0].systemEvents?.length).toBe(3);
  expect(items[0].groupPreview).toContain('a done');
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts -t "extend an existing"`
Expected: PASS — the append branch added in Task 3 already handles this.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts
git commit -m "test(transcript): cover system-event-group append across process() calls"
```

---

## Task 5: TDD — always-visible action breaks a run

**Files:**
- Modify: `src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts`

Verifies that `task_complete` (in `ALWAYS_VISIBLE_SYSTEM_ACTIONS`) interrupts grouping.

- [ ] **Step 1: Add the test**

```typescript
it('should not group across an always-visible action like task_complete', () => {
  const msgs = [
    makeOrchMsg('get_children', 'a', { id: 'g1', timestamp: 1_000 }),
    makeOrchMsg('get_children', 'b', { id: 'g2', timestamp: 2_000 }),
    makeOrchMsg('task_complete', 'done', { id: 'tc1', timestamp: 3_000 }),
    makeOrchMsg('get_children', 'c', { id: 'g3', timestamp: 4_000 }),
    makeOrchMsg('get_children', 'd', { id: 'g4', timestamp: 5_000 }),
  ];
  const items = processor.process(msgs);

  // Expect: [group(g1,g2), message(tc1), group(g3,g4)]
  expect(items.length).toBe(3);
  expect(items[0].type).toBe('system-event-group');
  expect(items[0].systemEvents?.length).toBe(2);
  expect(items[1].type).toBe('message');
  expect(items[1].message?.id).toBe('tc1');
  expect(items[2].type).toBe('system-event-group');
  expect(items[2].systemEvents?.length).toBe(2);
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts -t "always-visible action"`
Expected: PASS — `task_complete` falls through `isGroupableOrchestration` (it's in `ALWAYS_VISIBLE_SYSTEM_ACTIONS`) and is pushed as a normal message, breaking the run naturally.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts
git commit -m "test(transcript): always-visible action breaks system-event-group run"
```

---

## Task 6: TDD — single isolated orchestration message is NOT grouped

**Files:**
- Modify: `src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts`

Confirms the "≥ 2 members" minimum.

- [ ] **Step 1: Add the test**

```typescript
it('should leave a single orchestration message ungrouped', () => {
  const msgs = [
    makeOrchMsg('get_children', 'lone poll', { id: 'g1', timestamp: 1_000 }),
  ];
  const items = processor.process(msgs);
  expect(items.length).toBe(1);
  expect(items[0].type).toBe('message');
  expect(items[0].message?.id).toBe('g1');
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts -t "single orchestration message"`
Expected: PASS — there's no prior matching candidate so the message falls through to `this.items.push(item)`.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts
git commit -m "test(transcript): single orchestration message stays ungrouped"
```

---

## Task 7: TDD + impl — different action breaks the run

**Files:**
- Modify: `src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts`

Confirms that mixing `get_children` and `get_child_output` produces two separate groups (or two separate messages if neither side reaches 2).

- [ ] **Step 1: Add the test**

```typescript
it('should not merge orchestration messages with different actions', () => {
  const msgs = [
    makeOrchMsg('get_children', 'a', { id: 'g1', timestamp: 1_000 }),
    makeOrchMsg('get_children', 'b', { id: 'g2', timestamp: 2_000 }),
    makeOrchMsg('get_child_output', 'x', { id: 'o1', timestamp: 3_000 }),
    makeOrchMsg('get_child_output', 'y', { id: 'o2', timestamp: 4_000 }),
  ];
  const items = processor.process(msgs);

  expect(items.length).toBe(2);
  expect(items[0].type).toBe('system-event-group');
  expect(items[0].groupAction).toBe('get_children');
  expect(items[1].type).toBe('system-event-group');
  expect(items[1].groupAction).toBe('get_child_output');
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts -t "different actions"`
Expected: PASS — the action-equality check in both grouping branches prevents the cross-action merge; the second `get_child_output` then promotes itself with the first.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts
git commit -m "test(transcript): different orchestration actions form distinct groups"
```

---

## Task 8: TDD + impl — time-gap ceiling starts a new group

**Files:**
- Modify: `src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts`

Confirms the 5-minute ceiling.

- [ ] **Step 1: Add the test**

```typescript
it('should start a new system-event-group after the time-gap ceiling', () => {
  const start = 1_000_000;
  const sixMinutes = 6 * 60 * 1000;
  const msgs = [
    makeOrchMsg('get_children', 'a', { id: 'g1', timestamp: start }),
    makeOrchMsg('get_children', 'b', { id: 'g2', timestamp: start + 1_000 }),
    makeOrchMsg('get_children', 'c', { id: 'g3', timestamp: start + sixMinutes }),
    makeOrchMsg('get_children', 'd', { id: 'g4', timestamp: start + sixMinutes + 1_000 }),
  ];
  const items = processor.process(msgs);

  // First two form a group, then 6-min gap → new group of two.
  expect(items.length).toBe(2);
  expect(items[0].type).toBe('system-event-group');
  expect(items[0].systemEvents?.length).toBe(2);
  expect(items[1].type).toBe('system-event-group');
  expect(items[1].systemEvents?.length).toBe(2);
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts -t "time-gap ceiling"`
Expected: PASS — `withinSystemGroupGap` returns false for `g3`, so the append branch is skipped. The promote branch is also skipped because the candidate is the *group* not a single message; `g3` then falls through and pushes as a single message. `g4` then promotes with `g3` into a fresh group.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts
git commit -m "test(transcript): system-event-group respects 5-minute time-gap ceiling"
```

---

## Task 9: TDD + impl — empty assistant turns are absorbed into the run

**Files:**
- Modify: `src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts`
- Modify: `src/renderer/app/features/instance-detail/display-item-processor.service.ts`

This adds the "permissive" behaviour from the spec: empty/whitespace messages between two grouping-eligible messages do not break the run, and they are visually consumed by the group.

- [ ] **Step 1: Write the failing test**

Add to the spec:

```typescript
it('should absorb empty assistant turns between grouped orchestration messages', () => {
  const msgs = [
    makeOrchMsg('get_children', 'a', { id: 'g1', timestamp: 1_000 }),
    makeMsg({ type: 'assistant', content: '   ', id: 'a1', timestamp: 1_500 }),
    makeOrchMsg('get_children', 'b', { id: 'g2', timestamp: 2_000 }),
    makeMsg({ type: 'assistant', content: '\n\n', id: 'a2', timestamp: 2_500 }),
    makeOrchMsg('get_children', 'c', { id: 'g3', timestamp: 3_000 }),
  ];
  const items = processor.process(msgs);

  // Expect ONE group containing g1, g2, g3. The empty assistant items are gone.
  expect(items.length).toBe(1);
  expect(items[0].type).toBe('system-event-group');
  expect(items[0].systemEvents?.length).toBe(3);
  expect(items[0].systemEvents?.map(m => m.id)).toEqual(['g1', 'g2', 'g3']);
  expect(items[0].groupPreview).toContain('c');
});

it('should NOT absorb non-empty assistant turns between orchestration messages', () => {
  const msgs = [
    makeOrchMsg('get_children', 'a', { id: 'g1', timestamp: 1_000 }),
    makeMsg({ type: 'assistant', content: 'real reply', id: 'a1', timestamp: 1_500 }),
    makeOrchMsg('get_children', 'b', { id: 'g2', timestamp: 2_000 }),
  ];
  const items = processor.process(msgs);

  // Expect three items: message g1, message a1, message g2. No grouping.
  expect(items.length).toBe(3);
  expect(items.every(i => i.type === 'message')).toBe(true);
});
```

- [ ] **Step 2: Run the tests to confirm the absorption test fails**

Run: `npx vitest run src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts -t "absorb empty"`
Expected: FAIL — currently the empty assistant turn breaks the run, so two separate items remain.

Run: `npx vitest run src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts -t "NOT absorb non-empty"`
Expected: PASS — current code already handles this case correctly.

- [ ] **Step 3: Implement the absorption helper**

Add this helper method to the `DisplayItemProcessor` class (place it just below `promoteToSystemGroup`):

```typescript
  /**
   * Walk `this.items` backwards, returning the index of the last item that
   * either isn't a `'message'` display item or whose message has non-empty
   * trimmed content. Returns -1 if no such item exists.
   *
   * Used by the system-event grouping pass to look past empty assistant turns
   * (which are noise emitted between orchestration polls) when deciding
   * whether the new message extends an existing run.
   */
  private findLastNonEmptyItemIndex(): number {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.type !== 'message') return i;
      const content = it.message?.content ?? '';
      if (content.trim().length > 0) return i;
    }
    return -1;
  }

  /**
   * Remove any trailing empty `'message'` display items (assistant turns whose
   * content trims to nothing). Called when an orchestration message is about
   * to extend a group — those empties belong in the group, not floating
   * outside it.
   */
  private dropTrailingEmptyMessages(downToIndex: number): void {
    while (this.items.length - 1 > downToIndex) {
      const tail = this.items[this.items.length - 1];
      if (tail.type !== 'message') break;
      const content = tail.message?.content ?? '';
      if (content.trim().length > 0) break;
      this.items.pop();
    }
  }
```

- [ ] **Step 4: Wire the lookback into the grouping branch**

Replace the orchestration-grouping block from Task 3 with this version, which uses the lookback helper:

```typescript
      // Orchestration system-event grouping — collapse runs of repetitive
      // orchestration messages with the same `metadata.action` into an
      // accordion display item. Empty assistant turns between members are
      // absorbed (removed) so they don't break the run.
      if (
        item.type === 'message' &&
        item.message?.type === 'system' &&
        this.isGroupableOrchestration(item.message)
      ) {
        const action = (item.message.metadata as { action: string }).action;
        const candidateIdx = this.findLastNonEmptyItemIndex();
        const candidate = candidateIdx >= 0 ? this.items[candidateIdx] : undefined;

        if (
          candidate?.type === 'system-event-group' &&
          candidate.groupAction === action &&
          this.withinSystemGroupGap(candidate, item.message)
        ) {
          this.dropTrailingEmptyMessages(candidateIdx);
          this.appendToSystemGroup(candidate, item.message);
          continue;
        }

        if (
          candidate?.type === 'message' &&
          candidate.message?.type === 'system' &&
          this.isGroupableOrchestration(candidate.message) &&
          (candidate.message.metadata as { action: string }).action === action &&
          item.message.timestamp - candidate.message.timestamp <= SYSTEM_GROUP_TIME_GAP_MS
        ) {
          this.dropTrailingEmptyMessages(candidateIdx);
          this.promoteToSystemGroup(candidateIdx, candidate.message, item.message);
          continue;
        }
      }

      this.items.push(item);
    }
```

- [ ] **Step 5: Run both new tests and confirm they pass**

Run: `npx vitest run src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts -t "absorb empty"`
Expected: PASS.

Run: `npx vitest run src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts -t "NOT absorb non-empty"`
Expected: PASS.

Run the full file:
Run: `npx vitest run src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts`
Expected: ALL PASS.

- [ ] **Step 6: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/app/features/instance-detail/display-item-processor.service.ts \
        src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts
git commit -m "feat(transcript): absorb empty assistant turns into system-event-groups"
```

---

## Task 10: TDD — `resolveSystemActionLabel` and `buildSystemGroupPreview` unit tests

**Files:**
- Modify: `src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts`

Pure-function tests for the helpers exported in Task 2. These run independently of the grouping pass.

- [ ] **Step 1: Add the import and tests**

At the top of the spec file, extend the existing import line:

```typescript
import {
  DisplayItemProcessor,
  resolveSystemActionLabel,
  buildSystemGroupPreview,
} from './display-item-processor.service';
```

Then add a new `describe` block at the bottom of the file (after the existing `describe('DisplayItemProcessor', …)` closes):

```typescript
describe('resolveSystemActionLabel', () => {
  it('returns the mapped label for known actions', () => {
    expect(resolveSystemActionLabel('get_children')).toBe('Active children polled');
    expect(resolveSystemActionLabel('task_progress')).toBe('Task progress');
  });

  it('humanises unknown snake_case actions', () => {
    expect(resolveSystemActionLabel('some_new_action')).toBe('Some new action');
  });

  it('falls back to a placeholder for empty input', () => {
    expect(resolveSystemActionLabel('')).toBe('System event');
  });
});

describe('buildSystemGroupPreview', () => {
  it('strips markdown emphasis and collapses whitespace', () => {
    const out = buildSystemGroupPreview('**Active children:**\n- foo idle\n- bar busy');
    expect(out).toBe('Active children: foo idle bar busy');
  });

  it('drops fenced code blocks', () => {
    const out = buildSystemGroupPreview('Output:\n```\nbig blob\n```\nend');
    expect(out).toBe('Output: end');
  });

  it('truncates with an ellipsis when too long', () => {
    const long = 'word '.repeat(60).trim();          // 299 chars
    const out = buildSystemGroupPreview(long);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns an empty string for empty content', () => {
    expect(buildSystemGroupPreview('')).toBe('');
  });
});
```

- [ ] **Step 2: Run the new tests**

Run: `npx vitest run src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts -t "resolveSystemActionLabel"`
Expected: PASS.

Run: `npx vitest run src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts -t "buildSystemGroupPreview"`
Expected: PASS — values match the helper logic from Task 2.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts
git commit -m "test(transcript): cover resolveSystemActionLabel and buildSystemGroupPreview"
```

---

## Task 11: Create the `SystemEventGroupComponent`

**Files:**
- Create: `src/renderer/app/shared/components/system-event-group/system-event-group.component.ts`

Standalone Angular component, mirrors `app-thought-process` (`src/renderer/app/shared/components/thought-process/thought-process.component.ts`) for visual coherence. Uses `MarkdownService` to render each event's content when expanded.

- [ ] **Step 1: Create the component file**

Create `src/renderer/app/shared/components/system-event-group/system-event-group.component.ts`:

```typescript
/**
 * System Event Group Component — collapsible panel showing a run of
 * orchestration system messages (e.g. repeated `get_children` polls) under
 * one accordion. Mirrors the visual treatment of <app-thought-process>.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import type { OutputMessage } from '../../../core/state/instance/instance.types';
import { ExpansionStateService } from '../../../features/instance-detail/expansion-state.service';
import { MarkdownService } from '../../../core/services/markdown.service';

@Component({
  selector: 'app-system-event-group',
  standalone: true,
  imports: [DatePipe],
  template: `
    <div class="system-event-group" [class.expanded]="isExpanded()">
      <button class="seg-header" (click)="toggle()" type="button">
        <span class="seg-icon">{{ isExpanded() ? '▼' : '▶' }}</span>
        <span class="seg-label">{{ label() }}</span>
        <span class="seg-count">({{ events().length }}×)</span>
        @if (preview()) {
          <span class="seg-preview" [title]="preview()">— {{ preview() }}</span>
        }
        <span class="seg-chevron">{{ isExpanded() ? '−' : '+' }}</span>
      </button>
      @if (isExpanded()) {
        <div class="seg-content">
          @for (event of events(); track event.id) {
            <div class="seg-event">
              <span class="seg-event-time">{{ event.timestamp | date: 'HH:mm:ss' }}</span>
              <div class="seg-event-body markdown-content"
                [innerHTML]="renderEvent(event.content)"></div>
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .system-event-group {
      width: 100%;
      max-width: 100%;
      min-width: 0;
      box-sizing: border-box;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      overflow: hidden;
      margin: 4px auto;
    }

    .seg-header {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding: 10px 14px;
      background: transparent;
      border: none;
      cursor: pointer;
      font-size: 13px;
      color: var(--text-secondary);
      text-align: left;
      transition: all 0.15s ease;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }
    }

    .seg-icon {
      font-size: 10px;
      opacity: 0.6;
      width: 12px;
      flex-shrink: 0;
    }

    .seg-label {
      flex-shrink: 0;
      font-weight: 500;
    }

    .seg-count {
      flex-shrink: 0;
      font-size: 11px;
      color: var(--text-muted);
    }

    .seg-preview {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-muted);
      font-size: 12px;
    }

    .seg-chevron {
      flex-shrink: 0;
      font-size: 16px;
      opacity: 0.5;
      font-weight: 300;
    }

    .seg-content {
      min-width: 0;
      padding: 12px 14px 14px 34px;
      font-size: 12px;
      line-height: 1.5;
      color: var(--text-secondary);
      border-top: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .seg-event {
      display: flex;
      gap: 10px;
      align-items: flex-start;
    }

    .seg-event-time {
      flex-shrink: 0;
      font-family: var(--font-mono, monospace);
      font-size: 10px;
      color: var(--text-muted);
      padding-top: 2px;
      width: 64px;
    }

    .seg-event-body {
      flex: 1;
      min-width: 0;
      word-break: break-word;
    }

    .system-event-group.expanded .seg-header {
      color: var(--text-primary);
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SystemEventGroupComponent {
  events = input.required<OutputMessage[]>();
  label = input.required<string>();
  preview = input.required<string>();
  instanceId = input.required<string>();
  itemId = input.required<string>();

  private expansionState = inject(ExpansionStateService);
  private markdown = inject(MarkdownService);

  isExpanded = computed(() =>
    this.expansionState.isExpanded(this.instanceId(), this.itemId()),
  );

  toggle(): void {
    this.expansionState.toggleExpanded(this.instanceId(), this.itemId());
  }

  /**
   * Render an event's markdown content. Called from the template; the markdown
   * service applies its own caching, so calling per-event on each change
   * detection cycle is acceptable for the small N of typical groups.
   */
  renderEvent(content: string): unknown {
    return this.markdown.render(content);
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

Run: `npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS.

- [ ] **Step 3: Lint the new file**

Run: `npx eslint src/renderer/app/shared/components/system-event-group/system-event-group.component.ts`
Expected: PASS — no errors. (If ESLint reports the `unused` warning on `imports`, leave it; `DatePipe` is used in the template.)

- [ ] **Step 4: Commit**

```bash
git add src/renderer/app/shared/components/system-event-group/system-event-group.component.ts
git commit -m "feat(transcript): add SystemEventGroupComponent collapsible"
```

---

## Task 12: Wire `SystemEventGroupComponent` into `output-stream.component.ts`

**Files:**
- Modify: `src/renderer/app/features/instance-detail/output-stream.component.ts`

Adds the import, registers it in the component's `imports` array, and adds a template branch alongside `thought-group` / `tool-group`.

- [ ] **Step 1: Add the import**

Open `src/renderer/app/features/instance-detail/output-stream.component.ts`. Find the `MessageAttachmentsComponent` import on line 29. Just below it, add:

```typescript
import { SystemEventGroupComponent } from '../../shared/components/system-event-group/system-event-group.component';
```

- [ ] **Step 2: Register the component in `imports`**

Find the component decorator's `imports` array (search for `MessageAttachmentsComponent` again — it appears in `imports`). Add `SystemEventGroupComponent` to that array. Example, before:

```typescript
imports: [
  CommonModule,
  // ...
  MessageAttachmentsComponent,
],
```

After:

```typescript
imports: [
  CommonModule,
  // ...
  MessageAttachmentsComponent,
  SystemEventGroupComponent,
],
```

(Use whatever ordering matches the surrounding style.)

- [ ] **Step 3: Add the template branch**

Locate the existing `@for` block iterating `visibleItems()` (around line 71). Inside it, find the existing branch order:

```html
@if (item.type === 'thought-group') { … }
} @else if (item.message) { … }
```

Insert a new `@else if` branch for `'system-event-group'` *between* the `'thought-group'` branch and the `item.message` branch. The transcript-item wrapper and tracking remain consistent. The exact insertion (search for the closing `}` of the `'thought-group'` block at around line 117 — it's the line that reads `}` followed by `@else if (item.message)`):

Replace:

```html
          }
          } @else if (item.message) {
```

With:

```html
          }
          } @else if (item.type === 'system-event-group') {
            <app-system-event-group
              [events]="item.systemEvents!"
              [label]="item.groupLabel!"
              [preview]="item.groupPreview!"
              [instanceId]="instanceId()"
              [itemId]="item.id" />
          } @else if (item.message) {
```

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS — the new template binding resolves against the extended `DisplayItem` type from Task 1.

- [ ] **Step 5: Run the spec typecheck**

Run: `npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS.

- [ ] **Step 6: Lint**

Run: `npx eslint src/renderer/app/features/instance-detail/output-stream.component.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/app/features/instance-detail/output-stream.component.ts
git commit -m "feat(transcript): render system-event-group via SystemEventGroupComponent"
```

---

## Task 13: Full verification pass

**Files:** none (verification only)

Run the full battery of project quality checks per `AGENTS.md`. If any step fails, fix the issue and re-run before continuing.

- [ ] **Step 1: TypeScript main + spec compile**

Run: `npx tsc --noEmit`
Expected: PASS.

Run: `npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: PASS — no new errors introduced. (Pre-existing warnings unrelated to these files are acceptable.)

- [ ] **Step 3: Full test suite**

Run: `npm run test`
Expected: ALL PASS, including the 8 new tests added in Tasks 3–10.

- [ ] **Step 4: Production build smoke check**

Run: `npm run build`
Expected: PASS — bundle generated without errors. (Skip if the project's `npm run build` is heavy and reserved for CI; in that case run only the renderer build subset documented in AGENTS.md.)

- [ ] **Step 5: Manual UI verification (`npm run dev`)**

1. Run: `npm run dev`
2. In the running app, open or create a parent instance that spawns at least one child. Trigger several `get_children` polls (this happens automatically when the parent uses the orchestrator commands shown in `instance-orchestration.ts`).
3. Confirm in the transcript:
   - After ≥ 2 polls, the individual `SYSTEM Active children: …` cards collapse into a single row reading `▶ Active children polled (N×) — …latest preview…`.
   - Clicking the row expands a chronological list of every poll with `HH:mm:ss` timestamps.
   - Clicking the row again collapses it; expansion state survives switching to another instance and back.
   - Empty `CLAUDE` markers between polls are gone (absorbed).
   - A `task_complete` event between polls renders as its own normal system bubble and ends the current group; subsequent polls form a new group.
4. Confirm there is no visual regression on:
   - Thought-process accordions (`app-thought-process`) — they should look identical to before.
   - Tool groups (`tool-group`) — unchanged.
   - Single-occurrence orchestration messages (a lone `task_complete`) — unchanged.

- [ ] **Step 6: Stop the dev server, then commit any cosmetic fixes that came out of step 5**

If step 5 surfaced styling tweaks or copy changes, commit each as its own follow-up commit:

```bash
git add <changed files>
git commit -m "fix(transcript): <specific cosmetic fix from manual verification>"
```

If no fixes were needed, this step is a no-op.

- [ ] **Step 7: Final sanity log**

Confirm the branch contains exactly the commits introduced by Tasks 1–12 (plus any cosmetic follow-ups from step 6). Use `git log --oneline` and review.

---

## Self-Review (run after writing this plan)

**Spec coverage:**
- "Per-action grouping with always-visible exceptions" → Tasks 3, 5, 7
- "Permissive consecutiveness" (empty-message absorption) → Task 9
- "Time-gap ceiling" → Task 8
- "Minimum size" (≥ 2) → Task 6
- "Collapsed header content" (label + count + preview) → Tasks 2, 10, 11
- "Action label map" → Tasks 2, 10
- "Expanded view" with timestamps and markdown → Task 11
- "Default state" (collapsed, persisted via `ExpansionStateService`) → Task 11
- "`DisplayItem` extensions" → Task 1
- "Grouping pass" → Tasks 3, 9
- "`app-system-event-group` component" → Task 11
- "`output-stream.component.ts` template branch" → Task 12
- "Edge cases — `unknown` action stays visible" → Task 2 (constants)
- "Testing" enumerated cases — all covered in Tasks 3–10
- "Verification" — Task 13

No spec section is missing a corresponding task.

**Placeholder scan:** No "TBD", "TODO", "implement later", or vague instructions. Every code step contains the actual code; every command step contains the exact command and expected outcome.

**Type / name consistency:**
- `DisplayItem.systemEvents`, `groupAction`, `groupLabel`, `groupPreview` — same names used in Tasks 1, 3, 9, 11, 12.
- `SYSTEM_GROUP_TIME_GAP_MS`, `ALWAYS_VISIBLE_SYSTEM_ACTIONS`, `SYSTEM_ACTION_LABELS`, `SYSTEM_GROUP_PREVIEW_MAX_LEN` — defined in Task 2, referenced in Tasks 3, 8, 9.
- `resolveSystemActionLabel`, `buildSystemGroupPreview` — defined in Task 2, exported & tested in Task 10, used in Task 3.
- `isGroupableOrchestration`, `withinSystemGroupGap`, `appendToSystemGroup`, `promoteToSystemGroup`, `findLastNonEmptyItemIndex`, `dropTrailingEmptyMessages` — all method names consistent across the code blocks where they appear.
- `SystemEventGroupComponent` selector `app-system-event-group` and inputs `events`, `label`, `preview`, `instanceId`, `itemId` — consistent between Tasks 11 and 12.

No mismatches found.
