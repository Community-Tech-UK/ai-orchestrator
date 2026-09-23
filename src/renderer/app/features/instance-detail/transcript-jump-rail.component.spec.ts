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
 *      one asks the host to reveal history until the prompt renders, then
 *      jumps. A prompt no page holds lands at the top (opening prompt) or the
 *      next loaded prompt; a newer click supersedes an older one in flight.
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
const revealInput = signal<((messageId: string) => Promise<void>) | null>(null);

function bindInputs(c: TranscriptJumpRailComponent): void {
  const w = c as unknown as Record<string, unknown>;
  w['items'] = itemsInput;
  w['viewport'] = viewportInput;
  w['hasOlderMessages'] = hasOlderInput;
  w['sessionPrompts'] = sessionPromptsInput;
  w['revealUntilMessage'] = revealInput;
}

/** A host reveal hook whose calls the test resolves by hand. */
function deferredReveal(): {
  calls: string[];
  resolveLast: () => Promise<void>;
  hook: (messageId: string) => Promise<void>;
} {
  const calls: string[] = [];
  const resolvers: (() => void)[] = [];
  return {
    calls,
    hook: (messageId) => {
      calls.push(messageId);
      return new Promise<void>((resolve) => resolvers.push(resolve));
    },
    resolveLast: async () => {
      resolvers[resolvers.length - 1]?.();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
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
    revealInput.set(null);
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

  it('clicking an unloaded tick reveals history until the prompt renders, then jumps', async () => {
    const loaded = userItem('current question');
    sessionPromptsInput.set([{ id: 'old-1', timestamp: 0.1, excerpt: 'first ever prompt' }]);
    hasOlderInput.set(true);
    const reveal = deferredReveal();
    revealInput.set(reveal.hook);
    setup(
      [loaded],
      makeViewport({
        scrollHeight: 2000,
        clientHeight: 500,
        anchors: [{ itemId: loaded.id, offsetTop: 1500 }],
      }),
    );

    internals.jumpTo(0); // stub tick — not loaded yet
    expect(reveal.calls).toEqual(['old-1']);

    // The host's reveal renders the wanted prompt, then settles.
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
        { itemId: loaded.id, offsetTop: 2100 },
      ],
    });
    itemsInput.set([wanted, loaded]);
    viewportInput.set(viewport);
    await reveal.resolveLast();
    TestBed.tick();

    expect(viewport.scrollTo).toHaveBeenCalledWith({ top: 28, behavior: 'auto' });
  });

  it('lands at the top when the opening prompt is in no loadable page', async () => {
    const loaded = userItem('current question');
    sessionPromptsInput.set([{ id: 'compacted-away', timestamp: 0.1, excerpt: 'opening prompt' }]);
    const reveal = deferredReveal();
    revealInput.set(reveal.hook);
    const viewport = makeViewport({
      scrollHeight: 2000,
      clientHeight: 500,
      scrollTop: 1200,
      anchors: [{ itemId: loaded.id, offsetTop: 1500 }],
    });
    setup([loaded], viewport);

    internals.jumpTo(0);
    await reveal.resolveLast();
    TestBed.tick();

    expect(viewport.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
  });

  it('lands at the next loaded prompt when a middle prompt is in no loadable page', async () => {
    const first = userItem('first');
    const later = userItem('later');
    // Between first (ts 1) and later (ts 2) in the conversation.
    sessionPromptsInput.set([{ id: 'lost-middle', timestamp: first.message!.timestamp + 0.5, excerpt: 'lost' }]);
    const reveal = deferredReveal();
    revealInput.set(reveal.hook);
    const viewport = makeViewport({
      scrollHeight: 3000,
      clientHeight: 500,
      anchors: [
        { itemId: first.id, offsetTop: 100 },
        { itemId: later.id, offsetTop: 1800 },
      ],
    });
    setup([first, later], viewport);

    internals.jumpTo(1); // ticks: first, lost-middle, later
    await reveal.resolveLast();
    TestBed.tick();

    expect(viewport.scrollTo).toHaveBeenCalledWith({ top: 1788, behavior: 'auto' });
  });

  it('lets a newer stub click supersede one still revealing', async () => {
    const loaded = userItem('current question');
    sessionPromptsInput.set([
      { id: 'old-1', timestamp: 0.1, excerpt: 'first' },
      { id: 'old-2', timestamp: 0.2, excerpt: 'second' },
    ]);
    const calls: string[] = [];
    const resolvers = new Map<string, () => void>();
    revealInput.set((messageId) => {
      calls.push(messageId);
      return new Promise<void>((resolve) => resolvers.set(messageId, resolve));
    });
    const viewport = makeViewport({
      scrollHeight: 2000,
      clientHeight: 500,
      anchors: [{ itemId: loaded.id, offsetTop: 1500 }],
    });
    setup([loaded], viewport);

    internals.jumpTo(0);
    internals.jumpTo(1);
    // The superseded reveal settling first must not move the viewport.
    resolvers.get('old-1')!();
    await Promise.resolve();
    await Promise.resolve();
    TestBed.tick();
    expect(viewport.scrollTo).not.toHaveBeenCalled();

    resolvers.get('old-2')!();
    await Promise.resolve();
    await Promise.resolve();
    TestBed.tick();
    expect(calls).toEqual(['old-1', 'old-2']);
    expect(viewport.scrollTo).toHaveBeenCalledTimes(1);
  });

  it('falls back to a single load request when the host has no reveal hook', () => {
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
        anchors: [{ itemId: loaded.id, offsetTop: 100 }],
      }),
    );

    internals.jumpTo(0);
    TestBed.tick();
    expect(emitted.length).toBe(1);
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
