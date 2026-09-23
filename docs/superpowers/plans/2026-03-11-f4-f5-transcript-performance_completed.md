# F4/F5: Transcript Performance Optimization Plan

> **Reconciled 2026-09-23 (outstanding-plans sweep, [plan](../../plans/2026-09-23-outstanding-plans-sweep_plan_completed.md)): COMPLETE; F5 spike superseded.** F4 shipped (`display-item-processor.service.ts`, incremental and reset on instance switch). F5 Tasks 4–6 were a CDK virtual-scroll spike; the transcript instead uses the custom `TranscriptVirtualizerController`. Tasks 7–8 (expansion state) shipped as `ExpansionStateService`.


> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce transcript rendering from 4-30x over budget to within targets: display-items compute <10ms (currently 246ms p99), scroll frame <16ms (currently 525ms p95), thread switch <120ms (currently 488ms p95).

**Architecture:** Two-phase approach: (1) Convert `displayItems()` from full-rebuild to incremental append-only processing, eliminating the 5-pass O(n) recomputation. (2) Spike CDK Virtual Scroll with variable-height rows to replace CSS `content-visibility` which can't handle 5k+ messages. Phase 1 is mandatory; Phase 2 depends on spike results.

**Tech Stack:** Angular 21 signals/computed, `@angular/cdk` v21.1.0 (installed, not used for transcript), `ResizeObserver`, `requestAnimationFrame`.

---

## Chunk 1: Incremental displayItems() — F4 Completion

### Task 1: Extract Display Item Processing Into a Dedicated Service

**Files:**
- Create: `src/renderer/app/features/instance-detail/display-item-processor.service.ts`
- Test: `src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts`

The current `displayItems()` computed signal in `output-stream.component.ts` (lines 639-788) runs 5 sequential O(n) passes on every state change. We extract the processing logic into a service that maintains incremental state.

- [ ] **Step 1: Write tests for the processor service**

```typescript
import { DisplayItemProcessor } from './display-item-processor.service';
import type { OutputMessage } from '../../core/state/instance/instance.types';

function makeMsg(overrides: Partial<OutputMessage> = {}): OutputMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    type: 'assistant',
    content: 'Hello',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('DisplayItemProcessor', () => {
  let processor: DisplayItemProcessor;

  beforeEach(() => {
    processor = new DisplayItemProcessor();
  });

  it('should process a single message into a display item', () => {
    const msg = makeMsg();
    const items = processor.process([msg]);
    expect(items.length).toBe(1);
    expect(items[0].type).toBe('message');
    expect(items[0].message?.id).toBe(msg.id);
  });

  it('should group consecutive tool messages into a tool-group', () => {
    const msgs = [
      makeMsg({ type: 'tool_use', id: 'tu1' }),
      makeMsg({ type: 'tool_result', id: 'tr1' }),
    ];
    const items = processor.process(msgs);
    expect(items.length).toBe(1);
    expect(items[0].type).toBe('tool-group');
    expect(items[0].toolMessages?.length).toBe(2);
  });

  it('should collapse repeated identical messages', () => {
    const msgs = [
      makeMsg({ content: 'Error', type: 'system', id: 'e1' }),
      makeMsg({ content: 'Error', type: 'system', id: 'e2' }),
      makeMsg({ content: 'Error', type: 'system', id: 'e3' }),
    ];
    const items = processor.process(msgs);
    expect(items.length).toBe(1);
    expect(items[0].repeatCount).toBe(3);
  });

  it('should create thought-group for messages with thinking', () => {
    const msg = makeMsg({
      type: 'assistant',
      thinking: [{ content: 'Let me think...', signature: '' }],
    });
    const items = processor.process(msg.thinking ? [msg] : []);
    expect(items.length).toBe(1);
    expect(items[0].type).toBe('thought-group');
  });

  it('should incrementally append new messages', () => {
    const msg1 = makeMsg({ timestamp: 1000 });
    processor.process([msg1]);

    // Add a second message — should not reprocess msg1
    const msg2 = makeMsg({ timestamp: 2000 });
    const items = processor.process([msg1, msg2]);
    expect(items.length).toBe(2);
  });

  it('should compute showHeader based on sender and time gap', () => {
    const now = Date.now();
    const msgs = [
      makeMsg({ type: 'assistant', timestamp: now, id: 'a1' }),
      makeMsg({ type: 'assistant', timestamp: now + 1000, id: 'a2' }), // same sender, <2min gap
      makeMsg({ type: 'assistant', timestamp: now + 200000, id: 'a3' }), // same sender, >2min gap
    ];
    const items = processor.process(msgs);
    expect(items[0].showHeader).toBe(true);
    expect(items[1].showHeader).toBe(false); // continuation
    expect(items[2].showHeader).toBe(true);  // time gap exceeded
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the DisplayItemProcessor**

```typescript
/**
 * Display Item Processor — incremental message-to-display-item transformation.
 *
 * Replaces the 5-pass O(n) recomputation in displayItems() with incremental
 * append-only processing. Only new messages (since last process call) are
 * transformed; previously computed items are reused.
 */

import type { OutputMessage } from '../../core/state/instance/instance.types';
import type { ThinkingContent } from '../../../../shared/types/instance.types';

type RenderedMarkdown = string; // Matches MarkdownService.render() return type

/**
 * Must match the existing DisplayItem interface in output-stream.component.ts.
 * Includes renderedMessage/renderedResponse for markdown pre-rendering.
 */
export interface DisplayItem {
  id: string;
  type: 'message' | 'tool-group' | 'thought-group';
  message?: OutputMessage;
  renderedMessage?: RenderedMarkdown;
  toolMessages?: OutputMessage[];
  thinking?: ThinkingContent[];
  thoughts?: string[];  // Legacy compat
  response?: OutputMessage;
  renderedResponse?: RenderedMarkdown;
  timestamp?: number;
  repeatCount?: number;
  showHeader?: boolean;
}

const TIME_GAP_THRESHOLD = 2 * 60 * 1000; // 2 minutes

export class DisplayItemProcessor {
  private lastProcessedCount = 0;
  private items: DisplayItem[] = [];
  private lastInstanceId: string | null = null;
  private seenStreamingIds = new Set<string>(); // Persists across process() calls for cross-batch dedup

  /**
   * Process messages into display items.
   * On first call or after reset, processes all messages.
   * On subsequent calls, only processes new messages appended since last call.
   * If the message array shrunk (instance switch or trim), does a full rebuild.
   */
  process(messages: readonly OutputMessage[], instanceId?: string): DisplayItem[] {
    // Full rebuild if instance changed or messages were trimmed/reset
    if (instanceId !== this.lastInstanceId || messages.length < this.lastProcessedCount) {
      this.reset();
      this.lastInstanceId = instanceId ?? null;
    }

    // Nothing new to process
    if (messages.length === this.lastProcessedCount) {
      return this.items;
    }

    const newMessages = messages.slice(this.lastProcessedCount);
    this.lastProcessedCount = messages.length;

    // Pass 1: Convert new messages to raw display items
    const rawItems = this.convertToItems(newMessages);

    // Pass 2: Merge with existing items (tool grouping + dedup at boundary)
    const prevLength = this.items.length;
    this.mergeNewItems(rawItems);
    this._newItemCount = this.items.length - prevLength;

    // Pass 3: Recompute showHeader for affected items (only tail needs update)
    this.computeHeaders();

    return this.items;
  }

  reset(): void {
    this.items = [];
    this.lastProcessedCount = 0;
    this.seenStreamingIds.clear();
  }

  /** Returns count of newly added items (for incremental markdown rendering) */
  get newItemCount(): number {
    return this._newItemCount;
  }
  private _newItemCount = 0;

  private convertToItems(messages: readonly OutputMessage[]): DisplayItem[] {
    const items: DisplayItem[] = [];

    for (const msg of messages) {
      const isStreaming = msg.metadata && 'streaming' in msg.metadata && msg.metadata['streaming'] === true;

      if (isStreaming) {
        if (this.seenStreamingIds.has(msg.id)) {
          // Check both new items AND existing items for the streaming message
          const existingIdx = items.findIndex(item => item.type === 'message' && item.message?.id === msg.id);
          const target = existingIdx >= 0 ? items : this.items;
          const targetIdx = existingIdx >= 0 ? existingIdx : this.items.findIndex(item => item.type === 'message' && item.message?.id === msg.id);
          if (targetIdx >= 0 && target[targetIdx]?.message) {
            const accumulatedContent = msg.metadata && 'accumulatedContent' in msg.metadata
              ? String(msg.metadata['accumulatedContent'])
              : msg.content;
            target[targetIdx].message = { ...target[targetIdx].message!, content: accumulatedContent };
          }
          continue;
        }
        this.seenStreamingIds.add(msg.id);
        const displayContent = msg.metadata && 'accumulatedContent' in msg.metadata
          ? String(msg.metadata['accumulatedContent'])
          : msg.content;
        items.push({ id: `stream-${msg.id}`, type: 'message', message: { ...msg, content: displayContent } });
      } else if (msg.thinking && msg.thinking.length > 0 && msg.type === 'assistant') {
        items.push({
          id: `thought-${msg.id}`,
          type: 'thought-group',
          thinking: msg.thinking,
          thoughts: msg.thinking.map(t => t.content),
          response: msg,
          timestamp: msg.timestamp,
        });
      } else {
        items.push({ id: `msg-${msg.id}`, type: 'message', message: msg });
      }
    }

    return items;
  }

  private mergeNewItems(newItems: DisplayItem[]): void {
    for (const item of newItems) {
      const last = this.items[this.items.length - 1];

      // Tool grouping: if both current and last are tool messages, merge into group
      if (item.type === 'message' && item.message &&
          (item.message.type === 'tool_use' || item.message.type === 'tool_result')) {
        if (last?.type === 'tool-group' && last.toolMessages) {
          last.toolMessages.push(item.message);
          continue;
        }
        if (last?.type === 'message' && last.message &&
            (last.message.type === 'tool_use' || last.message.type === 'tool_result')) {
          // Convert previous single tool message into a tool group
          const group: DisplayItem = {
            id: `tools-${last.message.id}`,
            type: 'tool-group',
            toolMessages: [last.message, item.message],
            timestamp: last.message.timestamp,
          };
          this.items[this.items.length - 1] = group;
          continue;
        }
      }

      // Dedup: collapse repeated identical messages
      if (item.type === 'message' && last?.type === 'message' &&
          item.message && last.message &&
          item.message.type === last.message.type &&
          item.message.content === last.message.content) {
        last.repeatCount = (last.repeatCount ?? 1) + 1;
        continue;
      }

      this.items.push(item);
    }
  }

  private computeHeaders(): void {
    // Only recompute headers for the last few items (boundary effect)
    const startIdx = Math.max(0, this.items.length - 20);
    for (let i = startIdx; i < this.items.length; i++) {
      const item = this.items[i];
      const prev = i > 0 ? this.items[i - 1] : undefined;

      item.showHeader = true;
      if (!prev) continue;

      const curSender = this.getItemSenderType(item);
      const prevSender = this.getItemSenderType(prev);

      if (curSender && prevSender && curSender === prevSender) {
        const curTime = this.getItemTimestamp(item);
        const prevTime = this.getItemTimestamp(prev);
        if (curTime && prevTime && (curTime - prevTime) < TIME_GAP_THRESHOLD) {
          item.showHeader = false;
        }
      }
    }
  }

  private getItemSenderType(item: DisplayItem): string | null {
    if (item.type === 'message' && item.message) return item.message.type;
    if (item.type === 'thought-group') return 'assistant';
    if (item.type === 'tool-group') return 'tool';
    return null;
  }

  private getItemTimestamp(item: DisplayItem): number | null {
    if (item.type === 'message' && item.message) return item.message.timestamp;
    if (item.timestamp) return item.timestamp;
    if (item.type === 'tool-group' && item.toolMessages?.[0]) return item.toolMessages[0].timestamp;
    return null;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/app/features/instance-detail/display-item-processor.service.ts \
       src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts
git commit -m "feat(f4): add incremental DisplayItemProcessor with tests"
```

---

### Task 2: Integrate DisplayItemProcessor Into output-stream.component.ts

**Files:**
- Modify: `src/renderer/app/features/instance-detail/output-stream.component.ts` (lines 639-788)

- [ ] **Step 1: Import and instantiate the processor**

Add import at the top:
```typescript
import { DisplayItemProcessor } from './display-item-processor.service';
```

Add as a class field (alongside other private fields, ~line 630):
```typescript
private displayItemProcessor = new DisplayItemProcessor();
```

- [ ] **Step 2: Replace the displayItems() computed signal body**

Replace the entire body of `displayItems = computed<DisplayItem[]>(() => { ... })` (lines 639-788) with:

```typescript
displayItems = computed<DisplayItem[]>(() => {
  const startTime = performance.now();
  const messages = this.messages();
  const instanceId = this.instanceId();

  const items = this.displayItemProcessor.process(messages, instanceId);

  // Incremental markdown rendering: only render new items, not the entire array.
  // Previously-rendered items already have renderedMessage/renderedResponse set.
  const newCount = this.displayItemProcessor.newItemCount;
  if (newCount > 0) {
    const startIdx = items.length - newCount;
    for (let i = startIdx; i < items.length; i++) {
      this.renderItemMarkdown(items[i]);
    }
  }

  const duration = performance.now() - startTime;
  this.perf.recordDisplayItemsCompute(messages.length, items.length, duration);

  return items;
});
```

Also add a helper method `renderItemMarkdown()` that replaces the old `populateRenderedMarkdown()` O(n) loop. This renders markdown for a single item:

```typescript
private renderItemMarkdown(item: DisplayItem): void {
  item.renderedMessage = undefined;
  item.renderedResponse = undefined;

  if (item.type === 'message' && item.message) {
    const isToolMessage = item.message.type === 'tool_use' || item.message.type === 'tool_result';
    if (!isToolMessage && !this.isCompactionBoundary(item.message) && this.hasContent(item.message)) {
      item.renderedMessage = this.renderMarkdownContent(item.message.content, item.message.id);
    }
  }

  if (item.type === 'thought-group' && item.response && this.hasContent(item.response)) {
    item.renderedResponse = this.renderMarkdownContent(item.response.content, item.response.id);
  }
}
```

The old `populateRenderedMarkdown()` method can be removed.

- [ ] **Step 3: Update the DisplayItem type import**

Ensure `output-stream.component.ts` imports `DisplayItem` from the processor service instead of defining it locally. If `DisplayItem` is defined locally, remove the local definition and import from the processor.

- [ ] **Step 4: Remove now-unused helper methods**

Remove `getItemSenderType()` and `getItemTimestamp()` from the component if they were only used by the old `displayItems()` logic and are now in the processor.

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Run tests**

Run: `npm run test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/renderer/app/features/instance-detail/output-stream.component.ts
git commit -m "feat(f4): integrate incremental DisplayItemProcessor into output stream"
```

---

### Task 3: Reset Processor on Instance Switch

**Files:**
- Modify: `src/renderer/app/features/instance-detail/output-stream.component.ts` (instance change effect, ~line 792)

The processor auto-detects instance changes via the `instanceId` parameter, but we should also reset when the component is explicitly told to switch. The `process()` method already handles this — if `instanceId` changes, it calls `reset()` internally. No additional code needed unless there are edge cases.

- [ ] **Step 1: Verify instance switch behavior**

Read the instance-change effect (lines 792-830) and confirm that `displayItems()` will recompute when `instanceId()` changes (it does, because `this.instanceId()` is a signal dependency). The processor's `process()` method detects the instanceId change and does a full rebuild.

- [ ] **Step 2: Run the app in dev mode and switch between instances**

Run: `npm run dev`
Expected: Switching instances shows correct transcript for each. No stale data from previous instance.

- [ ] **Step 3: Commit if any fixes needed**

```bash
git add src/renderer/app/features/instance-detail/output-stream.component.ts
git commit -m "fix(f4): verify instance switch resets display item processor"
```

---

## Chunk 2: CDK Virtual Scroll Spike — F5

> **NOTE:** This chunk is a spike/prototype. The plan explicitly requires prototyping before committing to CDK virtual scroll (see codex_final_unified_plan.md line 587). The spike should be done in a branch and validated in the actual Electron shell.

### Task 4: Create CDK Virtual Scroll Spike Branch

- [ ] **Step 1: Create spike branch**

```bash
git checkout -b spike/f5-cdk-virtual-scroll
```

- [ ] **Step 2: Document spike goals**

Create `docs/spikes/f5-cdk-virtual-scroll-spike.md`:

```markdown
# F5 CDK Virtual Scroll Spike

## Goals
1. Test CdkVirtualScrollViewport with variable-height transcript rows
2. Validate scroll anchoring with streaming append (stick-to-bottom)
3. Prototype ResizeObserver integration for dynamic content (expand/collapse, image load)
4. Test with 500+ message stress fixture
5. Validate in Electron shell, not just browser harness

## Success Criteria
- Scroll frame time < 16ms at 1000+ messages
- Thread switch < 120ms
- Stick-to-bottom works during streaming
- Expand/collapse doesn't break scroll position

## Approach
Use CdkVirtualScrollViewport with a custom VirtualScrollStrategy that supports variable item heights.
```

- [ ] **Step 3: Commit**

```bash
git add docs/spikes/f5-cdk-virtual-scroll-spike.md
git commit -m "docs(f5): document CDK virtual scroll spike goals"
```

---

### Task 5: Implement Custom Virtual Scroll Strategy

**Files:**
- Create: `src/renderer/app/features/instance-detail/transcript-scroll-strategy.ts`

The transcript has variable-height rows (messages ~80px, thought groups ~120-400px, tool groups ~45-800px). CDK's built-in `FixedSizeVirtualScrollStrategy` won't work. We need a custom strategy that tracks measured heights.

- [ ] **Step 1: Implement the custom strategy**

```typescript
/**
 * Variable-height virtual scroll strategy for the transcript.
 *
 * Maintains a height cache per item, defaulting to estimated heights
 * per item type. Heights are updated via ResizeObserver after render.
 */

import { Injectable } from '@angular/core';
import { distinctUntilChanged, Observable, Subject } from 'rxjs';
import type { VirtualScrollStrategy, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';

const DEFAULT_HEIGHTS: Record<string, number> = {
  message: 80,
  'tool-group': 120,
  'thought-group': 200,
};

@Injectable()
export class TranscriptScrollStrategy implements VirtualScrollStrategy {
  private viewport: CdkVirtualScrollViewport | null = null;
  private heightCache = new Map<number, number>();
  private scrolledIndexChange$ = new Subject<number>();

  scrolledIndexChange: Observable<number> = this.scrolledIndexChange$.pipe(distinctUntilChanged());

  attach(viewport: CdkVirtualScrollViewport): void {
    this.viewport = viewport;
    this.updateTotalContentSize();
    this.updateRenderedRange();
  }

  detach(): void {
    this.viewport = null;
  }

  scrollToIndex(index: number, behavior: ScrollBehavior = 'auto'): void {
    if (!this.viewport) return;
    const offset = this.getOffsetForIndex(index);
    this.viewport.scrollToOffset(offset, behavior === 'smooth' ? 'smooth' : undefined);
  }

  onContentScrolled(): void {
    if (!this.viewport) return;
    this.updateRenderedRange();
  }

  onDataLengthChanged(): void {
    this.updateTotalContentSize();
    this.updateRenderedRange();
  }

  onContentRendered(): void {
    // No-op; heights updated via setItemHeight()
  }

  onRenderedOffsetChanged(): void {
    // No-op
  }

  /** Called by the component when ResizeObserver measures an item's actual height */
  setItemHeight(index: number, height: number): void {
    if (this.heightCache.get(index) !== height) {
      this.heightCache.set(index, height);
      this.updateTotalContentSize();
    }
  }

  /** Get total data length (set by the component) */
  private dataLength = 0;

  setDataLength(length: number): void {
    this.dataLength = length;
    this.onDataLengthChanged();
  }

  private getItemHeight(index: number): number {
    return this.heightCache.get(index) ?? DEFAULT_HEIGHTS['message'];
  }

  private getOffsetForIndex(index: number): number {
    let offset = 0;
    for (let i = 0; i < index; i++) {
      offset += this.getItemHeight(i);
    }
    return offset;
  }

  private getIndexForOffset(offset: number): number {
    let accumulated = 0;
    for (let i = 0; i < this.dataLength; i++) {
      accumulated += this.getItemHeight(i);
      if (accumulated > offset) return i;
    }
    return Math.max(0, this.dataLength - 1);
  }

  private updateTotalContentSize(): void {
    if (!this.viewport) return;
    let totalSize = 0;
    for (let i = 0; i < this.dataLength; i++) {
      totalSize += this.getItemHeight(i);
    }
    this.viewport.setTotalContentSize(totalSize);
  }

  private updateRenderedRange(): void {
    if (!this.viewport) return;

    const scrollOffset = this.viewport.measureScrollOffset();
    const viewportSize = this.viewport.getViewportSize();
    const buffer = viewportSize; // Render one viewport of buffer above and below

    const startOffset = Math.max(0, scrollOffset - buffer);
    const endOffset = scrollOffset + viewportSize + buffer;

    const startIndex = this.getIndexForOffset(startOffset);
    const endIndex = Math.min(this.dataLength, this.getIndexForOffset(endOffset) + 1);

    this.viewport.setRenderedRange({ start: startIndex, end: endIndex });
    this.viewport.setRenderedContentOffset(this.getOffsetForIndex(startIndex));
    this.scrolledIndexChange$.next(startIndex);
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/app/features/instance-detail/transcript-scroll-strategy.ts
git commit -m "feat(f5): implement custom variable-height virtual scroll strategy"
```

---

### Task 6: Spike — Integrate Virtual Scroll Into Output Stream

**Files:**
- Modify: `src/renderer/app/features/instance-detail/output-stream.component.ts` (template + imports)

This is the spike integration. Replace the `@for` loop with `cdk-virtual-scroll-viewport`.

- [ ] **Step 1: Add CDK ScrollingModule import**

Add to the component's `imports` array:
```typescript
import { ScrollingModule, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
```

Add `ScrollingModule` to the `imports` array in `@Component()`.

- [ ] **Step 2: Replace the template's scroll container**

Replace the transcript `@for` loop with:
```html
<cdk-virtual-scroll-viewport
  class="transcript-viewport"
  [style.height]="'100%'"
>
  <div *cdkVirtualFor="let item of displayItems(); trackBy: trackItem"
       class="transcript-item">
    <!-- existing item rendering template -->
  </div>
</cdk-virtual-scroll-viewport>
```

Note: This requires converting `@for` to `*cdkVirtualFor`. The `trackBy` function already exists.

- [ ] **Step 3: Provide the custom scroll strategy**

In the component's `providers`:
```typescript
providers: [
  {
    provide: VIRTUAL_SCROLL_STRATEGY,
    useClass: TranscriptScrollStrategy,
  },
],
```

- [ ] **Step 4: Wire ResizeObserver for dynamic height measurement**

Add to the component class:
```typescript
private resizeObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const el = entry.target as HTMLElement;
    const index = parseInt(el.dataset['itemIndex'] ?? '-1', 10);
    if (index >= 0) {
      this.scrollStrategy.setItemHeight(index, entry.contentRect.height);
    }
  }
});
```

- [ ] **Step 5: Test with 500+ messages**

Create a stress test: open the app, connect to a running instance, and generate 500+ messages. Measure scroll frame time using DevTools Performance tab.

- [ ] **Step 6: Document spike results**

Update `docs/spikes/f5-cdk-virtual-scroll-spike.md` with measured results:
- Scroll frame time at 500 messages
- Thread switch time
- Stick-to-bottom behavior
- Any issues found

- [ ] **Step 7: Commit spike**

```bash
git add -A
git commit -m "spike(f5): integrate CDK virtual scroll with variable-height strategy"
```

---

### Task 7: Expand/Collapse State Persistence

**Files:**
- Create: `src/renderer/app/features/instance-detail/expansion-state.service.ts`

Tool group and thought process expansion state is lost on instance switch. Create a service that persists expansion state per instance.

- [ ] **Step 1: Create the expansion state service**

```typescript
/**
 * Tracks expand/collapse state for tool groups and thought processes
 * per instance, so state persists across instance switches.
 *
 * Uses a signal-based version counter so Angular's change detection
 * picks up mutations to the underlying Map/Set data.
 */

import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ExpansionStateService {
  // instanceId -> Set of expanded item IDs
  private expandedItems = new Map<string, Set<string>>();

  // Signal version counter — bumped on every mutation so computed() consumers re-evaluate
  private version = signal(0);

  isExpanded(instanceId: string, itemId: string): boolean {
    // Read the version signal to create a reactive dependency
    this.version();
    return this.expandedItems.get(instanceId)?.has(itemId) ?? false;
  }

  setExpanded(instanceId: string, itemId: string, expanded: boolean): void {
    let set = this.expandedItems.get(instanceId);
    if (!set) {
      set = new Set();
      this.expandedItems.set(instanceId, set);
    }
    if (expanded) {
      set.add(itemId);
    } else {
      set.delete(itemId);
    }
    // Bump version to notify signal consumers
    this.version.update(v => v + 1);
  }

  toggleExpanded(instanceId: string, itemId: string): boolean {
    const current = this.expandedItems.get(instanceId)?.has(itemId) ?? false;
    this.setExpanded(instanceId, itemId, !current);
    return !current;
  }

  clearInstance(instanceId: string): void {
    this.expandedItems.delete(instanceId);
    this.version.update(v => v + 1);
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/app/features/instance-detail/expansion-state.service.ts
git commit -m "feat(f5): add expansion state service for cross-instance persistence"
```

---

### Task 8: Wire Expansion State Into Tool Group and Thought Process Components

**Files:**
- Modify: `src/renderer/app/shared/components/tool-group/tool-group.component.ts` (line ~173)
- Modify: `src/renderer/app/shared/components/thought-process/thought-process.component.ts` (line ~164)

- [ ] **Step 1: Add instanceId and itemId inputs to tool-group**

```typescript
instanceId = input<string>('');
itemId = input<string>('');
```

Replace the local `isExpanded = signal(false)` with:
```typescript
private expansionState = inject(ExpansionStateService);

isExpanded = computed(() => this.expansionState.isExpanded(this.instanceId(), this.itemId()));
```

Update the toggle method to use the service:
```typescript
toggle(): void {
  this.expansionState.toggleExpanded(this.instanceId(), this.itemId());
}
```

- [ ] **Step 2: Same changes for thought-process component**

Add `instanceId` and `itemId` inputs. Replace `isExpanded` signal with computed from `ExpansionStateService`. Update toggle to use service.

- [ ] **Step 3: Pass instanceId and itemId from output-stream template**

In the output-stream template, pass `[instanceId]="instanceId()"` and `[itemId]="item.id"` to `<app-tool-group>` and `<app-thought-process>` elements.

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Run tests**

Run: `npm run test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/app/shared/components/tool-group/tool-group.component.ts \
       src/renderer/app/shared/components/thought-process/thought-process.component.ts \
       src/renderer/app/features/instance-detail/output-stream.component.ts
git commit -m "feat(f5): persist expand/collapse state across instance switches"
```
