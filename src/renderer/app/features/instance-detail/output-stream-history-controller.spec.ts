/**
 * OutputStreamHistoryController + revealOlderHistory spec.
 *
 * Tests:
 *   1. revealOlderHistory reveals window-hidden items before loading pages,
 *      stops once done() holds, reports 'exhausted' at the session start, and
 *      stops ('stalled') when a step changes nothing instead of spinning.
 *   2. Disk pages are requested by stored-message offset: each request passes
 *      the previous page's oldestOffsetLoaded as beforeOffset.
 *   3. revealAll() walks a long stored history all the way to its first
 *      message; revealUntilMessage() stops as soon as the prompt renders.
 *   4. A second load while one is in flight joins it rather than no-op.
 *   5. A page that lands after an instance switch is dropped.
 *   6. Releasing loaded history the store trimmed restarts the disk cursor
 *      and re-enables loading — only once the viewport has settled at the
 *      live tail, not when a jump merely passes through it.
 */

import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutputMessage } from '../../core/state/instance.store';
import type { DisplayItem } from './display-item.types';
import { OutputStreamRenderWindow } from './output-stream-render-window';
import { OutputStreamHistoryController, type OutputStreamHistoryDeps } from './output-stream-history-controller';
import { revealOlderHistory, type RevealOlderHistoryOptions } from './output-stream-history-reveal';

function message(index: number, type: OutputMessage['type'] = 'assistant'): OutputMessage {
  return { id: `m${index}`, timestamp: index, type, content: `message ${index}` };
}

describe('revealOlderHistory', () => {
  function harness(overrides: Partial<RevealOlderHistoryOptions> & { hidden?: number; pages?: number }) {
    let hidden = overrides.hidden ?? 0;
    let pages = overrides.pages ?? 0;
    const steps: string[] = [];
    const options: RevealOlderHistoryOptions = {
      done: () => false,
      isStale: () => false,
      hiddenRenderedCount: () => hidden,
      revealAllRendered: () => { steps.push('reveal'); hidden = 0; },
      hasOlderMessages: () => pages > 0,
      loadOlderMessages: async () => { steps.push('load'); pages--; },
      progressKey: () => `${hidden}|${pages}`,
      afterStep: async () => undefined,
      ...overrides,
    };
    return { options, steps };
  }

  it('reveals hidden items first, then loads pages until the start', async () => {
    const { options, steps } = harness({ hidden: 30, pages: 2 });
    await expect(revealOlderHistory(options)).resolves.toBe('exhausted');
    expect(steps).toEqual(['reveal', 'load', 'load']);
  });

  it('stops as soon as done() holds', async () => {
    let loads = 0;
    const { options } = harness({
      pages: 10,
      done: () => loads >= 2,
      loadOlderMessages: async () => { loads++; },
      progressKey: () => String(loads),
    });
    await expect(revealOlderHistory(options)).resolves.toBe('done');
    expect(loads).toBe(2);
  });

  it('stops instead of spinning when a step changes nothing', async () => {
    const load = vi.fn(async () => undefined);
    const { options } = harness({ pages: 1, loadOlderMessages: load, progressKey: () => 'same' });
    await expect(revealOlderHistory(options)).resolves.toBe('stalled');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('stops when the transcript switched sessions', async () => {
    const { options } = harness({ pages: 3, isStale: () => true });
    await expect(revealOlderHistory(options)).resolves.toBe('stale');
  });
});

describe('OutputStreamHistoryController', () => {
  const STORED = 1_200;
  let stored: OutputMessage[];
  let messages: ReturnType<typeof signal<OutputMessage[]>>;
  let instanceId: ReturnType<typeof signal<string>>;
  let loadOlder: ReturnType<typeof vi.fn>;
  let release: ReturnType<typeof vi.fn>;
  let viewport: { scrollHeight: number; scrollTop: number; clientHeight: number } | null;
  let controller: OutputStreamHistoryController;

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));

    // Stored history: a user prompt first, the rest assistant output. The
    // live window already holds the newest 20 stored messages plus 5 more.
    stored = Array.from({ length: STORED }, (_, i) => message(i, i === 0 ? 'user' : 'assistant'));
    messages = signal([...stored.slice(-20), ...Array.from({ length: 5 }, (_, i) => message(STORED + i))]);
    instanceId = signal('inst-1');

    loadOlder = vi.fn(async (_id: string, options?: { beforeOffset?: number; limit?: number }) => {
      const end = options?.beforeOffset ?? stored.length;
      const start = Math.max(0, end - (options?.limit ?? 200));
      return {
        success: true,
        data: {
          messages: stored.slice(start, end),
          hasMore: start > 0,
          oldestOffsetLoaded: start,
          totalStored: stored.length,
        },
      };
    });
    release = vi.fn(() => 0);
    viewport = null;

    const renderWindow = new OutputStreamRenderWindow<DisplayItem>(
      () => instanceId(),
      () => messages().map((m) => ({ id: `item-${m.id}`, type: 'message' as const, message: m })),
    );
    const deps: OutputStreamHistoryDeps = {
      getInstanceId: () => instanceId(),
      getMessages: () => messages(),
      getOlderMessagesLoader: () => null,
      getOlderMessagesProbe: () => null,
      getViewportElement: () => viewport as unknown as HTMLElement | null,
      hiddenRenderedCount: () => renderWindow.hiddenCount(),
      windowedItems: () => renderWindow.items(),
      growRenderWindow: (id, by) => renderWindow.grow(id, by),
      resetRenderWindow: (id) => renderWindow.reset(id),
      instanceIpc: { loadOlderMessages: loadOlder } as unknown as OutputStreamHistoryDeps['instanceIpc'],
      outputStore: {
        prependOlderMessages: (_id: string, older: OutputMessage[]) => {
          const existing = new Set(messages().map((m) => m.id));
          messages.set([...older.filter((m) => !existing.has(m.id)), ...messages()]);
        },
        releaseLoadedHistory: release,
      } as unknown as OutputStreamHistoryDeps['outputStore'],
    };
    controller = new OutputStreamHistoryController(deps);
    controller.hasOlderMessages.set(true);
  });

  afterEach(() => {
    controller.destroy();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('pages disk history by stored-message offset', async () => {
    await controller.loadOlderMessages();
    await controller.loadOlderMessages();

    expect(loadOlder.mock.calls.map(([, options]) => options)).toEqual([
      { beforeOffset: undefined, limit: 200 },
      { beforeOffset: STORED - 200, limit: 200 },
    ]);
  });

  it('walks all the way back to the first stored message for scroll-to-top', async () => {
    await controller.revealAll();

    expect(messages()[0].id).toBe('m0');
    expect(messages()).toHaveLength(STORED + 5);
    expect(controller.hasOlderMessages()).toBe(false);
    // The whole walk is rendered, not just loaded.
    expect(controller['deps'].hiddenRenderedCount()).toBe(0);
  });

  it('stops revealing once the requested prompt renders', async () => {
    await controller.revealUntilMessage('m0');

    expect(controller['deps'].windowedItems()[0].message?.id).toBe('m0');
    // 1,200 stored at 500 per walk page: three pages reach offset 0.
    expect(loadOlder).toHaveBeenCalledTimes(3);
  });

  it('joins a load already in flight instead of returning early', async () => {
    const first = controller.loadOlderMessages();
    const second = controller.loadOlderMessages();

    expect(second).toBe(first);
    await second;
    expect(loadOlder).toHaveBeenCalledTimes(1);
    expect(messages().length).toBeGreaterThan(25);
  });

  it('drops a page that lands after the transcript switched sessions', async () => {
    const pending = controller.loadOlderMessages();
    instanceId.set('inst-2');
    await pending;

    expect(messages()).toHaveLength(25);
  });

  it('restarts the disk cursor when released history was trimmed away', async () => {
    await controller.loadOlderMessages();
    controller.hasOlderMessages.set(false);
    release.mockReturnValueOnce(200);
    viewport = { scrollHeight: 5_000, scrollTop: 4_400, clientHeight: 600 }; // at the live tail

    vi.useFakeTimers();
    controller.onViewportAtBottom();
    expect(release).not.toHaveBeenCalled(); // not before the viewport settles
    vi.advanceTimersByTime(1_000);
    vi.useRealTimers();

    expect(release).toHaveBeenCalledWith('inst-1');
    expect(controller.hasOlderMessages()).toBe(true);
    await controller.loadOlderMessages();
    expect(loadOlder.mock.calls[1][1]).toEqual({ beforeOffset: undefined, limit: 200 });
  });

  it('keeps loaded history when a jump only passed through the live tail', () => {
    viewport = { scrollHeight: 5_000, scrollTop: 4_400, clientHeight: 600 };
    vi.useFakeTimers();
    controller.onViewportAtBottom();
    viewport.scrollTop = 0; // the jump landed at the top before the tail settled
    vi.advanceTimersByTime(1_000);

    expect(release).not.toHaveBeenCalled();
  });
});
