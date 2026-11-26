# Collapsible System Event Groups

**Date:** 2026-04-13
**Status:** Approved (brainstorming complete, awaiting plan)
**Area:** Renderer — instance detail / transcript

## Problem

Orchestration system messages flood the transcript when a parent instance polls its
children. The most visible offender is `get_children`: every poll renders a full
`SYSTEM` card with `**Active children:** ...`. In a session of any length these
cards stack to dozens of near-identical bubbles, with empty `CLAUDE` turn markers
between them, drowning out real conversation.

The renderer already has a polished collapsible pattern — `app-thought-process` —
that hides Claude's intermediate thinking behind a single one-line accordion. We
want the same treatment for repetitive orchestration system events.

## Goals

- Collapse runs of repetitive orchestration system messages into a single
  accordion item that shows the most recent state at a glance.
- Keep important state-changing events (task completion, errors, user prompts)
  visible and ungrouped.
- Visually and behaviourally consistent with `app-thought-process` (same
  expand/collapse affordance, same persisted-expansion service).
- Zero changes to message *production*. The fix is purely a renderer-side
  grouping pass.

## Non-Goals

- Investigating *why* empty/whitespace assistant turns are persisted between
  polls. That looks like a separate adapter bug; tracked as a follow-up.
- Server-side filtering or compaction of orchestration messages. We still want
  the raw history available for replay/export.
- Any changes to what orchestration emits. `instance-orchestration.ts` is left
  alone.

## Identification of Target Messages

Each orchestration message is produced at
`src/main/instance/instance-orchestration.ts:358-371` with the shape:

```ts
{
  id: `orch-${Date.now()}`,
  timestamp: Date.now(),
  type: 'system',
  content: friendlyContent,
  metadata: {
    source: 'orchestration',
    action,         // e.g. 'get_children', 'task_progress', 'task_complete'
    status,         // 'SUCCESS' | 'FAILURE' | 'unknown'
    rawData,        // parsed JSON payload
  },
}
```

Grouping is keyed on **`metadata.source === 'orchestration'`** and **`metadata.action`**.
We do **not** parse content; metadata is the contract.

## Design

### Per-action grouping with always-visible exceptions

Group consecutive runs of orchestration system messages with the same
`metadata.action` into a single `system-event-group` display item.

**Always-visible (never grouped) actions** — these stay rendered as individual
system bubbles even in a run:

- `task_complete`
- `task_error`
- `child_completed`
- `all_children_completed`
- `request_user_action`
- `user_action_response`
- `unknown` — the producer falls back to `'unknown'` when it can't parse an
  action (`instance-orchestration.ts:345`); we don't know what it represents
  so it's safer to keep visible than to silently bucket many disparate events
  under one accordion.

Everything else with `metadata.source === 'orchestration'` is groupable. The
list lives in one constant in `display-item-processor.service.ts`, easy to
extend.

### "Permissive" consecutiveness

Strict consecutiveness would fail for the screenshot case because empty
assistant turns appear between each system poll. The grouping pass therefore
**absorbs empty/whitespace messages** into an open run rather than breaking it.

Rule: when deciding whether to extend a run, look back past any item whose
`message.content.trim()` is empty. Those empty items become members of the
group (so they disappear when the group is collapsed). They are *not* shown in
the expanded list — they were noise to begin with.

Non-empty assistant/user/tool messages do break a run. A new run can start
immediately after.

### Time-gap ceiling

A single group cannot span more than **5 minutes** of wall-clock time
(`timestamp` delta between consecutive members). If a new orchestration message
arrives more than 5 min after the last member, a new accordion is started.
This prevents one accordion from accumulating an entire multi-hour session.

### Minimum size

A group is only formed when it would contain **≥ 2 non-empty orchestration
messages**. A single isolated `get_children` renders as a normal system message
— no accordion-of-one.

### Collapsed header content

```
▶ {actionLabel} ({nonEmptyCount}×) — {latestPreview}
```

- `actionLabel` is derived from `metadata.action` via a label map; unknown
  actions humanize the snake_case name (`task_complete` → `Task complete`).
- `nonEmptyCount` is the number of real orchestration messages in the group
  (empty assistant turns absorbed into the run are not counted).
- `latestPreview` is the most recent message's content reduced to a single
  line: strip markdown emphasis, collapse whitespace, truncate with ellipsis
  to fit the row.

Action label map (initial):

| `metadata.action`     | label                    |
|-----------------------|--------------------------|
| `get_children`        | Active children polled   |
| `get_child_output`    | Child output fetched     |
| `get_child_summary`   | Child summary fetched    |
| `get_child_artifacts` | Child artifacts fetched  |
| `get_child_section`   | Child section fetched    |
| `task_progress`       | Task progress            |
| `call_tool`           | Tool calls               |
| `message_child`       | Messages to children     |
| `spawn_child`         | Child spawned (grouped)  |
| `terminate_child`     | Children terminated      |
| *(fallback)*          | humanised action name    |

### Expanded view

When opened, the accordion renders each non-empty orchestration message as a
small system bubble in chronological order, each with its `HH:mm:ss` timestamp.
Same markdown rendering pipeline as today's individual system messages.

Empty assistant turns absorbed into the group are **not** rendered when
expanded — they were padding only.

### Default state

Collapsed by default. Open/closed state persists across re-renders via the
existing `ExpansionStateService`, keyed on
`(instanceId, displayItem.id)` — the same mechanism `app-thought-process` uses.

## Architecture

The change lives in two places in the renderer:

1. **`src/renderer/app/features/instance-detail/display-item-processor.service.ts`**
   — extend the `DisplayItem` union and the `mergeNewItems` pass.
2. **`src/renderer/app/shared/components/system-event-group/system-event-group.component.ts`**
   — new standalone component, mirrors `app-thought-process`.

Plus a small change to `output-stream.component.ts` to add the new render
branch.

### `DisplayItem` extensions

```ts
export interface DisplayItem {
  // ...existing fields unchanged
  type: 'message' | 'tool-group' | 'thought-group' | 'system-event-group';
  systemEvents?: OutputMessage[];   // non-empty members in chronological order
  groupAction?: string;             // e.g. 'get_children'
  groupLabel?: string;              // resolved via the label map
  groupPreview?: string;            // single-line truncated latest content
}
```

### Grouping pass (`mergeNewItems`)

Inserted after the existing tool-group and repeat-collapse blocks, before the
final `this.items.push(item)` fallback:

```
let last = this.items[this.items.length - 1];

const isGroupableOrchestration =
  item.type === 'message'
  && item.message?.type === 'system'
  && item.message.metadata?.source === 'orchestration'
  && !ALWAYS_VISIBLE_ACTIONS.has(item.message.metadata.action);

if (isGroupableOrchestration) {
  const action = item.message.metadata.action;

  // Look back past empty messages to find the candidate run head.
  const lookbackIdx = findLastNonEmptyIndex(this.items);
  const candidate = lookbackIdx >= 0 ? this.items[lookbackIdx] : undefined;

  if (
    candidate?.type === 'system-event-group'
    && candidate.groupAction === action
    && withinTimeGap(candidate, item.message, GROUP_TIME_GAP_MS)
  ) {
    appendToGroup(candidate, item.message);   // absorbs intervening empties
    continue;
  }

  if (
    candidate?.type === 'message'
    && candidate.message?.type === 'system'
    && candidate.message.metadata?.source === 'orchestration'
    && candidate.message.metadata.action === action
    && withinTimeGap(candidate, item.message, GROUP_TIME_GAP_MS)
  ) {
    promoteToGroup(this.items, lookbackIdx, candidate.message, item.message);
    continue;
  }
  // fall through to normal push
}

this.items.push(item);
```

Helper semantics:

- `findLastNonEmptyIndex` — walks `this.items` backwards skipping any
  `message`-typed item whose `content.trim()` is empty.
- `appendToGroup` — pushes the message onto `systemEvents`, refreshes
  `groupPreview` from the new latest, and recomputes `bufferIndex`. Any
  intervening empty items between the run head and the new message are
  *removed from `this.items`* (they're noise; collapsing the group should
  collapse them too).
- `promoteToGroup` — replaces the existing single-message item at index
  `lookbackIdx` with a new `system-event-group`, then strips intervening
  empties.

Constants live at the top of the file:

```ts
const GROUP_TIME_GAP_MS = 5 * 60 * 1000;
const ALWAYS_VISIBLE_ACTIONS = new Set([
  'task_complete', 'task_error', 'child_completed',
  'all_children_completed', 'request_user_action', 'user_action_response',
  'unknown',
]);
```

### `app-system-event-group` component

Standalone, OnPush, mirrors `app-thought-process`:

```ts
@Component({
  selector: 'app-system-event-group',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  // template: header row with chevron + label + count + preview;
  // expanded body: chronological list of <system message> bubbles.
})
export class SystemEventGroupComponent {
  events = input.required<OutputMessage[]>();
  label = input.required<string>();
  preview = input.required<string>();
  instanceId = input.required<string>();
  itemId = input.required<string>();

  private expansionState = inject(ExpansionStateService);
  isExpanded = computed(() =>
    this.expansionState.isExpanded(this.instanceId(), this.itemId()),
  );
  toggle = () =>
    this.expansionState.toggleExpanded(this.instanceId(), this.itemId());
}
```

Uses the shared markdown rendering for individual events (same pipeline as
`message-system` today). Visual treatment: same border / radius / hover as
`app-thought-process` — keeps the transcript visually coherent.

### `output-stream.component.ts` template branch

Add alongside the existing `thought-group` / `tool-group` cases:

```html
@else if (item.type === 'system-event-group') {
  <app-system-event-group
    [events]="item.systemEvents!"
    [label]="item.groupLabel!"
    [preview]="item.groupPreview!"
    [instanceId]="instanceId()"
    [itemId]="item.id" />
}
```

## Edge Cases & Decisions

- **Streaming / partial messages** — orchestration messages aren't streamed
  (they're pushed atomically by `instance-orchestration.ts:367`). No streaming
  merge needed.
- **History pagination / instance switch** — `DisplayItemProcessor.reset()`
  already wipes state on these transitions, so groups rebuild from scratch.
- **Repeat-count interplay** — the existing `repeatCount` collapse explicitly
  excluded `system` messages. That exclusion stays — the new grouping replaces
  what `repeatCount` would have done for orchestration messages.
- **Always-visible action mid-run** — if a `task_complete` arrives mid `get_children`
  poll storm, it ends the current group and renders normally. A subsequent
  `get_children` starts a fresh group.
- **Different `status` in same `action`** — `SUCCESS` and `FAILURE` of the same
  action are still grouped together (the action is what the user is conceptually
  tracking). The preview will reflect whichever was latest.
- **Performance** — grouping is O(1) per new message in the common case; the
  empty-skip lookback is bounded by the number of intervening empty messages
  (in practice 0–1). No full re-scans introduced.

## Testing

- Add to `display-item-processor.service.spec.ts`:
  - Two consecutive `get_children` messages → one `system-event-group` with
    count 2 and the latest preview.
  - One `get_children`, then an empty assistant turn, then another
    `get_children` → one group with count 2 (the empty turn is absorbed).
  - One `get_children`, then a non-empty assistant message, then another
    `get_children` → two separate single-message items (no group of one).
  - `task_complete` between two `get_children` polls → group · task_complete ·
    new group.
  - Two `get_children` polls 6 minutes apart → two separate single-message
    items (time-gap exceeded).
  - Mixed `get_children` + `task_progress` interleaved → two distinct groups.
- Smoke check on `output-stream.component.ts` rendering — existing tests should
  not regress; add one that asserts the new branch renders an
  `<app-system-event-group>` when given a `system-event-group` display item.

## Verification (per project rules)

After implementation:

```
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run test
npm run dev   # manual: trigger get_children polling, confirm collapse
```

Manual UI verification: spawn ≥ 1 child, observe transcript stays clean as the
parent polls `get_children` repeatedly; confirm the accordion shows the latest
state in the header; confirm expanding shows the full chronological list.

## Follow-ups (out of scope)

- Empty assistant turns being persisted at all — likely an adapter bug; absorbing
  them visually here is a workaround, not a fix.
- Optional future enhancement: tiny dot indicator or relative-time tag on the
  collapsed header (e.g. "12× · last 4s ago") to show recency without expanding.
- Consider extending the same grouping pattern to non-orchestration system
  messages (e.g. compaction notices) if similar noise patterns emerge.
