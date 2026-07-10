/**
 * TranscriptJumpRailComponent spec
 *
 * Tests (class-level, inputs overridden as plain functions per house style):
 *   1. visible() is false below MIN_JUMP_TARGETS user messages, even when the
 *      transcript overflows.
 *   2. visible() is false when the transcript does not overflow.
 *   3. visible() is true with enough user messages and overflow.
 *   4. markers() positions ticks proportionally within the rail and stays
 *      empty while geometry is stale (target/anchor length mismatch).
 *   5. jumpTo() smooth-scrolls the viewport to the row (minus margin) and
 *      applies the jump-flash class, removed on animationend.
 *   6. Hover shows the preview only after the delay; leaving the rail cancels
 *      a pending hover.
 *   7. activeIndex() tracks scrollTop against anchor offsets.
 */

import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptJumpRailComponent } from './transcript-jump-rail.component';
import type { DisplayItem } from './display-item.types';
import type { OutputMessage } from '../../core/state/instance/instance.types';

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

function bindInputs(c: TranscriptJumpRailComponent): void {
  const w = c as unknown as Record<string, unknown>;
  w['items'] = itemsInput;
  w['viewport'] = viewportInput;
}

interface RailInternals {
  measure(): void;
  visible(): boolean;
  markers(): { target: { itemId: string }; top: number }[];
  activeIndex(): number;
  hoverPreview(): { target: { promptExcerpt: string } } | null;
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
    const items = [userItem('one'), userItem('two')];
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

  it('positions ticks proportionally within the rail height', () => {
    const { items } = threeQuestionSetup();
    const markers = internals.markers();
    expect(markers.map((m) => m.target.itemId)).toEqual(items.map((i) => i.id));
    // anchors at 0/800/1600 of scrollHeight 2000, rail 400px → 0/160/320
    expect(markers.map((m) => m.top)).toEqual([0, 160, 320]);
  });

  it('renders no markers while measurement is stale after items changed', () => {
    threeQuestionSetup();
    expect(internals.markers()).toHaveLength(3);

    const grown = [userItem('one'), userItem('two'), userItem('three'), userItem('four')];
    itemsInput.set(grown); // no re-measure yet — anchor count no longer matches
    expect(internals.markers()).toEqual([]);
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
    expect(internals.hoverPreview()?.target.promptExcerpt).toBe('two');
  });

  it('cancels a pending hover when leaving the rail', () => {
    vi.useFakeTimers();
    threeQuestionSetup();

    internals.onTickEnter(1);
    internals.onRailLeave();
    vi.advanceTimersByTime(150);
    expect(internals.hoverPreview()).toBeNull();
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
