import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectAccessibilityTreeNodes } from './puppeteer-accessibility-tree';

describe('collectAccessibilityTreeNodes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it('walks child frames and de-duplicates nodes by backend id', async () => {
    const send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      // DOM.enable / Accessibility.enable are now issued inside the budgeted
      // walk, so ignore them here: they are not frame reads.
      if (method === 'DOM.enable' || method === 'Accessibility.enable') return undefined;
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            childFrames: [
              { frame: { id: 'child-1' }, childFrames: [] },
              { frame: { id: 'child-2' }, childFrames: [] },
            ],
          },
        };
      }
      if (method === 'Accessibility.getFullAXTree') {
        const frameId = params['frameId'];
        if (frameId === 'child-2') throw new Error('oopif refused');
        return {
          nodes: frameId === 'child-1'
            ? [{ backendDOMNodeId: 2 }, { backendDOMNodeId: 3 }]
            : [{ backendDOMNodeId: 1 }, { backendDOMNodeId: 2 }],
        };
      }
      throw new Error(`unexpected CDP method: ${method}`);
    });

    await expect(collectAccessibilityTreeNodes({ send })).resolves.toEqual([
      { backendDOMNodeId: 1 },
      { backendDOMNodeId: 2 },
      { backendDOMNodeId: 3 },
    ]);
    expect(send).toHaveBeenCalledWith('Accessibility.getFullAXTree', {});
    expect(send).toHaveBeenCalledWith('Accessibility.getFullAXTree', { frameId: 'child-1' });
  });

  it('still reads the main frame when frame discovery is unavailable', async () => {
    const send = vi.fn(async (method: string) => {
      // DOM.enable / Accessibility.enable are now issued inside the budgeted
      // walk, so ignore them here: they are not frame reads.
      if (method === 'DOM.enable' || method === 'Accessibility.enable') return undefined;
      if (method === 'Page.getFrameTree') throw new Error('unsupported');
      return { nodes: [{ backendDOMNodeId: 1 }] };
    });

    await expect(collectAccessibilityTreeNodes({ send })).resolves.toEqual([
      { backendDOMNodeId: 1 },
    ]);
  });

  it('walks exactly the frame cap on a frame-heavy page', async () => {
    const childFrames = Array.from({ length: 60 }, (_, i) => ({
      frame: { id: `frame-${i}` },
      childFrames: [],
    }));
    const requested: (string | undefined)[] = [];
    const send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      // DOM.enable / Accessibility.enable are now issued inside the budgeted
      // walk, so ignore them here: they are not frame reads.
      if (method === 'DOM.enable' || method === 'Accessibility.enable') return undefined;
      if (method === 'Page.getFrameTree') return { frameTree: { childFrames } };
      requested.push(params['frameId'] as string | undefined);
      return { nodes: [] };
    });

    await collectAccessibilityTreeNodes({ send });

    // Exact count, not "no more than": a `toBeLessThanOrEqual` here would also
    // pass if the walk regressed to main-frame-only, i.e. against total loss of
    // the feature under test.
    expect(requested).toHaveLength(25);
    expect(requested[0]).toBeUndefined();
    expect(requested.at(-1)).toBe('frame-23');
  });

  it('stops walking child frames once the wall-clock budget is spent', async () => {
    const childFrames = Array.from({ length: 20 }, (_, i) => ({
      frame: { id: `frame-${i}` },
      childFrames: [],
    }));
    let clock = 0;
    const requested: (string | undefined)[] = [];
    const send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      // DOM.enable / Accessibility.enable are now issued inside the budgeted
      // walk, so ignore them here: they are not frame reads.
      if (method === 'DOM.enable' || method === 'Accessibility.enable') return undefined;
      if (method === 'Page.getFrameTree') return { frameTree: { childFrames } };
      requested.push(params['frameId'] as string | undefined);
      clock += 9_000;
      return { nodes: [{ backendDOMNodeId: requested.length }] };
    });

    // The 25-frame cap bounds CDP calls but not time; without a budget a heavy
    // page turns one snapshot into 25 sequential trees.
    const nodes = await collectAccessibilityTreeNodes({ send }, () => clock);

    // Exact sequence. `toBeLessThan(n)` also passes at 1, i.e. against a
    // regression to main-frame-only -- the tautology the frame-cap test above
    // rejects. 20s whole-snapshot budget, 9s consumed per AX call: main,
    // frame 0, frame 1, then stop.
    expect(requested).toEqual([undefined, 'frame-0', 'frame-1']);
    // The main frame is still read, so this is a partial result and not an
    // empty one.
    expect(nodes).toHaveLength(3);
  });

  it('bounds a genuinely unresolved child-frame CDP request by the remaining budget', async () => {
    vi.useFakeTimers();
    const requested: (string | undefined)[] = [];
    const send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      // DOM.enable / Accessibility.enable are now issued inside the budgeted
      // walk, so ignore them here: they are not frame reads.
      if (method === 'DOM.enable' || method === 'Accessibility.enable') return undefined;
      if (method === 'Page.getFrameTree') {
        return { frameTree: { childFrames: [{ frame: { id: 'slow-child' } }] } };
      }
      const frameId = params['frameId'] as string | undefined;
      requested.push(frameId);
      if (frameId === 'slow-child') return new Promise<never>(() => undefined);
      return { nodes: [{ backendDOMNodeId: 1 }] };
    });

    const pending = collectAccessibilityTreeNodes({ send });
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(pending).resolves.toEqual([{ backendDOMNodeId: 1 }]);
    expect(requested).toEqual([undefined, 'slow-child']);
  });

  it('bounds a genuinely unresolved main-frame request by the whole-snapshot deadline', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async (method: string) => {
      if (method === 'DOM.enable' || method === 'Accessibility.enable') return undefined;
      if (method === 'Page.getFrameTree') return { frameTree: {} };
      return new Promise<never>(() => undefined);
    });

    const pending = collectAccessibilityTreeNodes({ send });
    const assertion = expect(pending).rejects.toThrow(
      'browser_cdp_timeout:Accessibility.getFullAXTree',
    );
    await vi.advanceTimersByTimeAsync(20_000);

    await assertion;
  });

  it('settles by the one whole-snapshot deadline when every phase is unresolved', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => new Promise<never>(() => undefined));
    let settled = false;
    const pending = collectAccessibilityTreeNodes({ send }).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(20_000);

    expect(settled).toBe(true);
    await expect(pending).rejects.toThrow(
      'browser_cdp_timeout:Accessibility.getFullAXTree',
    );
  });

  it('bounds unresolved frame discovery before falling back to the main frame', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async (method: string) => {
      // DOM.enable / Accessibility.enable are now issued inside the budgeted
      // walk, so ignore them here: they are not frame reads.
      if (method === 'DOM.enable' || method === 'Accessibility.enable') return undefined;
      if (method === 'Page.getFrameTree') return new Promise<never>(() => undefined);
      return { nodes: [{ backendDOMNodeId: 1 }] };
    });

    const pending = collectAccessibilityTreeNodes({ send });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).resolves.toEqual([{ backendDOMNodeId: 1 }]);
  });

  it('fails when the main accessibility tree cannot be read', async () => {
    const send = vi.fn(async (method: string) => {
      // DOM.enable / Accessibility.enable are now issued inside the budgeted
      // walk, so ignore them here: they are not frame reads.
      if (method === 'DOM.enable' || method === 'Accessibility.enable') return undefined;
      if (method === 'Page.getFrameTree') return { frameTree: {} };
      throw new Error('target closed');
    });

    await expect(collectAccessibilityTreeNodes({ send })).rejects.toThrow('target closed');
  });
});
