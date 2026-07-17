/**
 * TranscriptJumpRailComponent spec
 *
 * Tests (class-level, inputs overridden as plain functions per house style):
 *   1. visible() is false below MIN_JUMP_TARGETS user messages, even when the
 *      transcript overflows — unless older messages exist to load, where a
 *      single prompt is enough.
 *   2. visible() is false when the transcript does not overflow.
 *   3. visible() is true with enough user messages and overflow.
 *   4. markers() bunches ticks in a fixed-spacing cluster centred in the rail
 *      and follows the target count directly when items change.
 *   5. jumpTo() smooth-scrolls the viewport to the row (minus margin) and
 *      applies the jump-flash class, removed on animationend.
 *   6. Hover shows the preview only after the delay; leaving the rail cancels
 *      a pending hover; file chips cap at the display limit with an overflow
 *      count.
 *   7. activeIndex() tracks scrollTop against anchor offsets.
 *   8. Session prompts beyond the loaded window render as stub ticks; clicking
 *      one requests older pages until the prompt arrives, then jumps; the
 *      request loop stops when no older messages remain.
 */

import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptJumpRailComponent } from './transcript-jump-rail.component';
import type { DisplayItem } from './display-item.types';
import type { OutputMessage } from '../../core/state/instance/instance.types';
import type { UserPromptRef } from '../../../../shared/types/prompt-index.types';

let nextId = 0;

function userItem(content: string): DisplayItem {
  nextId++;
  const message: OutputMessage = { id: `msg-${nextId}`, timestamp: nextId, type: 'user', content };
  return { id: `item-${nextId}`, type: 'message', message };
}

/** Real jsdom element tree with layout properties defined by hand. */
function makeViewport(options: {
  scrollHeight: number;
  clientHeight: number;
  scrollTop?: number;
  anchors: { itemId: string; offsetTop: number }[];
}): HTMLElement {
  const vp = document.createElement('div');
  Object.defineProperty(vp, 'scrollHeight', { value: options.scrollHeight, configurable: true });
  Object.defineProperty(vp, 'clientHeight', { value: options.clientHeight, configurable: true });
  vp.scrollTop = options.scrollTop ?? 0;
  vp.scrollTo = vi.fn();
  for (const anchor of options.anchors) {
    const row = document.createElement('div');
    row.setAttribute('data-item-id', anchor.itemId);
    Object.defineProperty(row, 'offsetTop', { value: anchor.offsetTop, configurable: true });
    vp.appendChild(row);
  }
  return vp;
}

// Signal-backed input overrides (vitest does not run the Angular compiler's
// input transform). Real signals keep the component's computeds reactive when
// a test swaps items after an initial read.
const itemsInput = signal<DisplayItem[]>([]);
const viewportInput = signal<HTMLElement | null>(null);
const hasOlderInput = signal(false);
const sessionPromptsInput = signal<UserPromptRef[]>([]);

function bindInputs(c: TranscriptJumpRailComponent): void {
  const w = c as unknown as Record<string, unknown>;
  w['items'] = itemsInput;
  w['viewport'] = viewportInput;
  w['hasOlderMessages'] = hasOlderInput;
  w['sessionPrompts'] = sessionPromptsInput;
}

interface RailInternals {
  measure(): void;
  visible(): boolean;
  markers(): { tick: { messageId: string; promptExcerpt: string }; top: number }[];
  activeIndex(): number;
  hoverPreview(): {
    tick: { promptExcerpt: string; target?: unknown };
    chips: string[];
    moreCount: number;
  } | null;
  jumpTo(index: number): void;
  onTickEnter(index: number): void;
  onRailLeave(): void;
}

describe('TranscriptJumpRailComponent', () => {
  let component: TranscriptJumpRailComponent;
  let internals: RailInternals;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TranscriptJumpRailComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(TranscriptJumpRailComponent);
    component = fixture.componentInstance;
    internals = component as unknown as RailInternals;
    Object.defineProperty(fixture.nativeElement, 'clientHeight', {
      value: 400,
      configurable: true,
    });
    itemsInput.set([]);
    viewportInput.set(null);
    hasOlderInput.set(false);
    sessionPromptsInput.set([]);
    bindInputs(component);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(items: DisplayItem[], viewport: HTMLElement | null): void {
    itemsInput.set(items);
    viewportInput.set(viewport);
    internals.measure();
  }

  function threeQuestionSetup(scrollTop = 0): { items: DisplayItem[]; viewport: HTMLElement } {
    const items = [userItem('one'), userItem('two'), userItem('three')];
    const viewport = makeViewport({
      scrollHeight: 2000,
      clientHeight: 500,
      scrollTop,
      anchors: items.map((item, i) => ({ itemId: item.id, offsetTop: i * 800 })),
    });
    setup(items, viewport);
    return { items, viewport };
  }

  // ── Visibility ─────────────────────────────────────────────────────────────

  it('stays hidden below the minimum user-message count even when scrollable', () => {
    const items = [userItem('one')];
    setup(
      items,
      makeViewport({
        scrollHeight: 2000,
        clientHeight: 500,
        anchors: items.map((item, i) => ({ itemId: item.id, offsetTop: i * 900 })),
      }),
    );
    expect(internals.visible()).toBe(false);
  });

  it('shows at two user messages when the transcript overflows', () => {
    const items = [userItem('one'), userItem('two')];
    setup(
      items,
      makeViewport({
        scrollHeight: 2000,
        clientHeight: 500,
        anchors: items.map((item, i) => ({ itemId: item.id, offsetTop: i * 900 })),
      }),
    );
    expect(internals.visible()).toBe(true);
  });

  it('shows with a single prompt when older messages exist to load', () => {
    const items = [userItem('one')];
    setup(
      items,
      makeViewport({
        scrollHeight: 2000,
        clientHeight: 500,
        anchors: items.map((item, i) => ({ itemId: item.id, offsetTop: i * 900 })),
      }),
    );
    expect(internals.visible()).toBe(false);

    hasOlderInput.set(true);
    expect(internals.visible()).toBe(true);
  });

  it('stays hidden when the transcript does not overflow', () => {
    const items = [userItem('one'), userItem('two'), userItem('three')];
    setup(
      items,
      makeViewport({
        scrollHeight: 500,
        clientHeight: 500,
        anchors: items.map((item, i) => ({ itemId: item.id, offsetTop: i * 100 })),
      }),
    );
    expect(internals.visible()).toBe(false);
  });

  it('shows with enough user messages and overflow', () => {
    threeQuestionSetup();
    expect(internals.visible()).toBe(true);
  });

  // ── Markers ────────────────────────────────────────────────────────────────

  it('bunches ticks in a fixed-spacing cluster centred in the rail', () => {
    const { items } = threeQuestionSetup();
    const markers = internals.markers();
    expect(markers.map((m) => m.tick.messageId)).toEqual(items.map((i) => i.message!.id));
    // 3 ticks, 12px spacing → 24px cluster centred in the 400px rail
    expect(markers.map((m) => m.top)).toEqual([188, 200, 212]);
  });

  it('tracks the target count immediately when items change (no anchor alignment)', () => {
    threeQuestionSetup();
    expect(internals.markers()).toHaveLength(3);

    const grown = [userItem('one'), userItem('two'), userItem('three'), userItem('four')];
    itemsInput.set(grown); // re-measure still pending — cluster layout only needs the count
    expect(internals.markers()).toHaveLength(4);
  });

  // ── Jump behaviour ─────────────────────────────────────────────────────────

  it('jumpTo scrolls to the row minus the margin and flashes it', () => {
    const { items, viewport } = threeQuestionSetup();
    internals.jumpTo(1);

    expect(viewport.scrollTo).toHaveBeenCalledWith({ top: 788, behavior: 'smooth' });
    const row = viewport.querySelector(`[data-item-id="${items[1].id}"]`) as HTMLElement;
    expect(row.classList.contains('jump-flash')).toBe(true);

    row.dispatchEvent(new Event('animationend'));
    expect(row.classList.contains('jump-flash')).toBe(false);
  });

  it('jumpTo clamps the first row to scroll offset 0', () => {
    const { viewport } = threeQuestionSetup();
    internals.jumpTo(0);
    expect(viewport.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });

  // ── Hover preview ──────────────────────────────────────────────────────────

  it('shows the preview only after the hover delay', () => {
    vi.useFakeTimers();
    threeQuestionSetup();

    internals.onTickEnter(1);
    expect(internals.hoverPreview()).toBeNull();

    vi.advanceTimersByTime(150);
    expect(internals.hoverPreview()?.tick.promptExcerpt).toBe('two');
  });

  it('cancels a pending hover when leaving the rail', () => {
    vi.useFakeTimers();
    threeQuestionSetup();

    internals.onTickEnter(1);
    internals.onRailLeave();
    vi.advanceTimersByTime(150);
    expect(internals.hoverPreview()).toBeNull();
  });

  it('caps preview file chips and reports the overflow count', () => {
    vi.useFakeTimers();
    const first = userItem('one');
    const edits: DisplayItem = {
      id: 'item-edits',
      type: 'tool-group',
      toolMessages: ['a.ts', 'b.ts', 'c.ts'].map((name, i) => ({
        id: `tool-${i}`,
        timestamp: i,
        type: 'tool_use',
        content: '',
        metadata: { name: 'Edit', input: { file_path: `/repo/${name}` } },
      })),
    };
    const items = [first, edits, userItem('two'), userItem('three')];
    const anchors = items
      .filter((item) => item.type === 'message')
      .map((item, i) => ({ itemId: item.id, offsetTop: i * 800 }));
    setup(items, makeViewport({ scrollHeight: 2000, clientHeight: 500, anchors }));

    internals.onTickEnter(0);
    vi.advanceTimersByTime(150);
    expect(internals.hoverPreview()?.chips).toEqual(['a.ts', 'b.ts']);
    expect(internals.hoverPreview()?.moreCount).toBe(1);
  });

  // ── Session prompts (full tally beyond the loaded window) ──────────────────

  it('renders ticks for session prompts outside the loaded window', () => {
    const loaded = userItem('current question');
    sessionPromptsInput.set([
      { id: 'old-1', timestamp: 0.1, excerpt: 'first ever prompt' },
      { id: 'old-2', timestamp: 0.2, excerpt: 'second prompt' },
    ]);
    setup(
      [loaded],
      makeViewport({
        scrollHeight: 2000,
        clientHeight: 500,
        anchors: [{ itemId: loaded.id, offsetTop: 100 }],
      }),
    );

    expect(internals.visible()).toBe(true);
    expect(internals.markers().map((m) => m.tick.messageId)).toEqual([
      'old-1',
      'old-2',
      loaded.message!.id,
    ]);
  });

  it('clicking an unloaded tick keeps requesting older pages until the prompt arrives, then jumps', () => {
    const loaded = userItem('current question');
    sessionPromptsInput.set([{ id: 'old-1', timestamp: 0.1, excerpt: 'first ever prompt' }]);
    hasOlderInput.set(true);
    const emitted: number[] = [];
    component.loadOlder.subscribe(() => emitted.push(1));
    setup(
      [loaded],
      makeViewport({
        scrollHeight: 2000,
        clientHeight: 500,
        anchors: [{ itemId: loaded.id, offsetTop: 1500 }],
      }),
    );

    internals.jumpTo(0); // stub tick — not loaded yet
    TestBed.tick();
    expect(emitted.length).toBe(1);

    // An older page arrives without the wanted prompt → another request.
    const filler = userItem('irrelevant');
    itemsInput.set([filler, loaded]);
    TestBed.tick();
    expect(emitted.length).toBe(2);

    // The wanted prompt arrives → jump to its row, no further requests.
    const wanted: DisplayItem = {
      id: 'item-old-1',
      type: 'message',
      message: { id: 'old-1', timestamp: 0.1, type: 'user', content: 'first ever prompt' },
    };
    const viewport = makeViewport({
      scrollHeight: 2600,
      clientHeight: 500,
      anchors: [
        { itemId: wanted.id, offsetTop: 40 },
        { itemId: filler.id, offsetTop: 700 },
        { itemId: loaded.id, offsetTop: 2100 },
      ],
    });
    itemsInput.set([wanted, filler, loaded]);
    viewportInput.set(viewport);
    TestBed.tick();

    expect(viewport.scrollTo).toHaveBeenCalledWith({ top: 28, behavior: 'smooth' });
    expect(emitted.length).toBe(2);
  });

  it('gives up a stub jump when no older messages remain', () => {
    const loaded = userItem('current question');
    sessionPromptsInput.set([{ id: 'old-1', timestamp: 0.1, excerpt: 'gone prompt' }]);
    hasOlderInput.set(false);
    const emitted: number[] = [];
    component.loadOlder.subscribe(() => emitted.push(1));
    setup(
      [loaded],
      makeViewport({
        scrollHeight: 2000,
        clientHeight: 500,
        anchors: [{ itemId: loaded.id, offsetTop: 100 }],
      }),
    );

    internals.jumpTo(0);
    TestBed.tick();
    expect(emitted.length).toBe(0);
  });

  // ── Active tick ────────────────────────────────────────────────────────────

  it('tracks the active tick from scrollTop', () => {
    threeQuestionSetup(0);
    expect(internals.activeIndex()).toBe(0);

    const { viewport } = threeQuestionSetup(1500);
    expect(viewport).toBeTruthy();
    expect(internals.activeIndex()).toBe(2);
  });
});
