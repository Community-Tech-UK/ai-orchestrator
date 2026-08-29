import { readFileSync } from 'node:fs';
// jsdom ships no type declarations and @types/jsdom is not installed; sibling
// specs already declare the ambient module, so import it untyped here too.
// @ts-expect-error No type declarations available for 'jsdom' in this repo.
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { extractFunctionSource } from './browser-extension-function-source.testutil';

// `captureAccessibilitySnapshot` and `uidTypeFn` run inside the extension
// service worker and cannot be imported. These tests extract the REAL source
// from background.js so a regression in the shipped file fails here rather than
// silently on a live portal.
//
// Regression origin (2026-08-28), two halves of one incident:
//  1. `Accessibility.getFullAXTree` was called with no `frameId`, which returns
//     the MAIN frame only, so iframe contents were invisible.
//  2. `uidTypeFn` fell through to `element.value = value` on an element with no
//     value property, creating an expando it then read back as success.
// Together: `type` against a rich-text editor reported success and wrote
// nothing, and an approved tender message would have gone out blank.

const background = readFileSync('resources/browser-extension/background.js', 'utf-8');

const maxFramesMatch = background.match(/const ACCESSIBILITY_MAX_FRAMES = (\d+);/);
const ACCESSIBILITY_MAX_FRAMES = Number(maxFramesMatch?.[1]);

const minSliceMatch = background.match(/const MIN_CDP_PAGE_WORK_TIMEOUT_MS = (\d+);/);
const MIN_CDP_PAGE_WORK_TIMEOUT_MS = Number(minSliceMatch?.[1]);

const PAGE_WORK_BUDGET_MS = 24_000;

interface SendCall { method: string; params: Record<string, unknown> }

interface Harness {
  capture: (tabId: number, options: Record<string, unknown>) => Promise<{ nodes: unknown[] }>;
  calls: SendCall[];
  /** timeoutMs handed to withCdpDeadline per getFullAXTree, in call order. */
  axTimeouts: number[];
  requestedFrameIds: (string | null)[];
}

function buildHarness(handlers: {
  frameTree?: unknown;
  frameTreeError?: Error;
  axTree: (frameId: string | null) => { nodes: unknown[] };
  /** Fake milliseconds consumed by each getFullAXTree call. */
  msPerFrame?: number;
  /** Fake ms already consumed before the first frame (slow debugger attach). */
  startElapsedMs?: number;
}): Harness {
  const calls: SendCall[] = [];
  const axTimeouts: number[] = [];
  const requestedFrameIds: (string | null)[] = [];
  let now = 1_000_000;

  const chromeStub = {
    debugger: {
      sendCommand: async (_debuggee: unknown, method: string, params: Record<string, unknown> = {}) => {
        calls.push({ method, params });
        if (method === 'Page.getFrameTree') {
          // The deadline is armed before the debugger attach, so time lost to
          // attach + keep-alive is already gone by the time the frame walk
          // starts. Model that here, before the first frame is requested.
          now += handlers.startElapsedMs ?? 0;
          if (handlers.frameTreeError) {
            throw handlers.frameTreeError;
          }
          return handlers.frameTree;
        }
        if (method === 'Accessibility.getFullAXTree') {
          const raw = params['frameId'];
          const frameId = typeof raw === 'string' ? raw : null;
          requestedFrameIds.push(frameId);
          now += handlers.msPerFrame ?? 0;
          return handlers.axTree(frameId);
        }
        return undefined;
      },
    },
  };

  const factory = new Function(
    'deps',
    `
    const chrome = deps.chrome;
    const withDebugger = deps.withDebugger;
    const withCdpDeadline = deps.withCdpDeadline;
    const cdpPageWorkTimeoutMs = deps.cdpPageWorkTimeoutMs;
    const CDP_CONTROL_TIMEOUT_MS = deps.CDP_CONTROL_TIMEOUT_MS;
    const ACCESSIBILITY_MAX_FRAMES = deps.ACCESSIBILITY_MAX_FRAMES;
    const MIN_CDP_PAGE_WORK_TIMEOUT_MS = deps.MIN_CDP_PAGE_WORK_TIMEOUT_MS;
    const Date = deps.Date;
    ${extractFunctionSource(background, 'collectAccessibilityFrameIds')}
    ${extractFunctionSource(background, 'captureAccessibilitySnapshot')}
    return captureAccessibilitySnapshot;
    `,
  ) as (deps: Record<string, unknown>) => Harness['capture'];

  const capture = factory({
    chrome: chromeStub,
    withDebugger: async (tabId: number, fn: (d: unknown) => unknown) => fn({ tabId }),
    withCdpDeadline: async (work: Promise<unknown>, label: string, timeoutMs: number) => {
      if (label === 'Accessibility.getFullAXTree') {
        axTimeouts.push(timeoutMs);
      }
      return work;
    },
    cdpPageWorkTimeoutMs: () => PAGE_WORK_BUDGET_MS,
    CDP_CONTROL_TIMEOUT_MS: 5_000,
    ACCESSIBILITY_MAX_FRAMES,
    MIN_CDP_PAGE_WORK_TIMEOUT_MS,
    Date: { now: () => now },
  });

  return { capture, calls, axTimeouts, requestedFrameIds };
}

function axNode(
  backendDOMNodeId: number,
  role: string,
  name: string,
  properties: { name: string; value: { value: unknown } }[] = [],
) {
  return {
    backendDOMNodeId,
    role: { value: role },
    name: { value: name },
    ignored: false,
    properties,
  };
}

/** Chrome exposes a contenteditable host this way: role generic + editable. */
function editableHostNode(backendDOMNodeId: number, name: string) {
  return axNode(backendDOMNodeId, 'generic', name, [
    { name: 'editable', value: { value: 'richtext' } },
    { name: 'focusable', value: { value: true } },
  ]);
}

const NESTED_FRAME_TREE = {
  frameTree: {
    frame: { id: 'main' },
    childFrames: [
      { frame: { id: 'editor-frame' }, childFrames: [] },
      { frame: { id: 'oopif-frame' }, childFrames: [] },
    ],
  },
};

describe('captureAccessibilitySnapshot frame traversal', () => {
  it('reads the main frame with no frameId, preserving single-frame behaviour', async () => {
    const harness = buildHarness({
      frameTree: { frameTree: { frame: { id: 'main' }, childFrames: [] } },
      axTree: () => ({ nodes: [axNode(1, 'textbox', 'Subject')] }),
    });

    const result = await harness.capture(1, {});

    expect(harness.requestedFrameIds).toEqual([null]);
    expect(harness.calls.filter((c) => c.method === 'Accessibility.getFullAXTree')[0].params)
      .toEqual({});
    expect(harness.calls.some((c) => c.method === 'Page.enable')).toBe(false);
    expect(result.nodes).toHaveLength(1);
  });

  it('merges nodes from a same-origin child frame so in-iframe controls are addressable', async () => {
    const harness = buildHarness({
      frameTree: NESTED_FRAME_TREE,
      axTree: (frameId) => {
        if (frameId === null) {
          return { nodes: [axNode(1, 'textbox', 'Subject'), axNode(2, 'Iframe', 'Rich Text Area')] };
        }
        if (frameId === 'editor-frame') {
          return { nodes: [axNode(3, 'textbox', 'Rich Text Area. Press ALT-0 for help.')] };
        }
        return { nodes: [] };
      },
    });

    const result = await harness.capture(1, {});

    expect(harness.requestedFrameIds).toEqual([null, 'editor-frame', 'oopif-frame']);
    // uid 3 lives inside the iframe and was unreachable before this fix.
    expect((result.nodes as { uid: string }[]).map((n) => n.uid)).toEqual(['1', '2', '3']);
  });

  it('keeps frames that answered when a cross-origin OOPIF refuses', async () => {
    const harness = buildHarness({
      frameTree: NESTED_FRAME_TREE,
      axTree: (frameId) => {
        if (frameId === 'oopif-frame') {
          throw new Error('Not allowed');
        }
        if (frameId === 'editor-frame') {
          return { nodes: [axNode(3, 'textbox', 'In iframe')] };
        }
        return { nodes: [axNode(1, 'textbox', 'Subject')] };
      },
    });

    const result = await harness.capture(1, {});

    expect((result.nodes as { uid: string }[]).map((n) => n.uid)).toEqual(['1', '3']);
  });

  it('fails loudly when the MAIN frame tree cannot be read', async () => {
    const harness = buildHarness({
      frameTree: NESTED_FRAME_TREE,
      axTree: (frameId) => {
        if (frameId === null) {
          throw new Error('Target closed');
        }
        return { nodes: [] };
      },
    });

    // A confidently empty tree would be worse than an error: the caller cannot
    // tell "no controls" from "could not look".
    await expect(harness.capture(1, {})).rejects.toThrow('Target closed');
  });

  it('de-duplicates a node reported by both the main and child frame trees', async () => {
    const harness = buildHarness({
      frameTree: NESTED_FRAME_TREE,
      axTree: () => ({ nodes: [axNode(7, 'textbox', 'Shared')] }),
    });

    const result = await harness.capture(1, {});

    expect(harness.requestedFrameIds).toHaveLength(3);
    expect(result.nodes).toHaveLength(1);
  });

  it('degrades to the main frame when the frame tree is unavailable', async () => {
    const harness = buildHarness({
      frameTreeError: new Error('Page domain unavailable'),
      axTree: () => ({ nodes: [axNode(1, 'textbox', 'Subject')] }),
    });

    const result = await harness.capture(1, {});

    expect(harness.requestedFrameIds).toEqual([null]);
    expect(result.nodes).toHaveLength(1);
  });

  it('walks exactly the frame cap, not merely "no more than" it', async () => {
    const childFrames = Array.from({ length: 60 }, (_, i) => ({
      frame: { id: `frame-${i}` },
      childFrames: [],
    }));
    const harness = buildHarness({
      frameTree: { frameTree: { frame: { id: 'main' }, childFrames } },
      axTree: () => ({ nodes: [] }),
    });

    await harness.capture(1, {});

    // Asserting an exact count and the exact ids: `toBeLessThanOrEqual` would
    // also pass if frame traversal regressed to main-frame-only, i.e. it would
    // pass against total loss of the feature under test.
    expect(harness.requestedFrameIds).toHaveLength(ACCESSIBILITY_MAX_FRAMES);
    expect(harness.requestedFrameIds[0]).toBeNull();
    expect(harness.requestedFrameIds[1]).toBe('frame-0');
    expect(harness.requestedFrameIds.at(-1)).toBe(`frame-${ACCESSIBILITY_MAX_FRAMES - 2}`);
  });

  it('spends ONE budget across all frames instead of re-arming it per frame', async () => {
    const childFrames = Array.from({ length: 5 }, (_, i) => ({
      frame: { id: `frame-${i}` },
      childFrames: [],
    }));
    const harness = buildHarness({
      frameTree: { frameTree: { frame: { id: 'main' }, childFrames } },
      axTree: () => ({ nodes: [] }),
      msPerFrame: 1_000,
    });

    await harness.capture(1, {});

    // Re-arming per frame would make every timeout identical. A shared deadline
    // makes each successive frame get strictly less of the budget.
    expect(harness.axTimeouts[0]).toBe(PAGE_WORK_BUDGET_MS);
    for (let i = 1; i < harness.axTimeouts.length; i++) {
      expect(harness.axTimeouts[i]).toBeLessThan(harness.axTimeouts[i - 1]);
    }
    expect(harness.axTimeouts.at(-1)).toBeLessThanOrEqual(PAGE_WORK_BUDGET_MS - 5_000);
  });

  it('stops walking frames once the shared budget is exhausted', async () => {
    const childFrames = Array.from({ length: 20 }, (_, i) => ({
      frame: { id: `frame-${i}` },
      childFrames: [],
    }));
    const harness = buildHarness({
      frameTree: { frameTree: { frame: { id: 'main' }, childFrames } },
      axTree: (frameId) => ({
        nodes: frameId === null ? [axNode(1, 'textbox', 'Subject')] : [],
      }),
      msPerFrame: 10_000,
    });

    const result = await harness.capture(1, {});

    // 24s budget at 10s per frame: three calls, then the budget is gone. The
    // partial result is still returned rather than failing the snapshot.
    expect(harness.requestedFrameIds).toHaveLength(3);
    expect(result.nodes).toHaveLength(1);
  });

  it('keeps a contenteditable host even though Chrome types it as role generic', async () => {
    const harness = buildHarness({
      frameTree: NESTED_FRAME_TREE,
      axTree: (frameId) => {
        if (frameId === 'editor-frame') {
          return {
            nodes: [
              editableHostNode(3, 'Rich Text Area. Press ALT-0 for help.'),
              axNode(4, 'generic', 'just a wrapper'),
            ],
          };
        }
        return { nodes: [axNode(1, 'textbox', 'Subject')] };
      },
    });

    const result = await harness.capture(1, {});
    const nodes = result.nodes as { uid: string; editable?: string }[];

    // Without the editable exemption the merge is pointless: the body is fetched
    // and then filtered straight back out, and the caller sees no typeable
    // control inside the editor frame -- the original bug, unchanged.
    const editable = nodes.find((n) => n.uid === '3');
    expect(editable).toBeDefined();
    expect(editable?.editable).toBe('richtext');
    // A plain generic wrapper is still dropped.
    expect(nodes.map((n) => n.uid)).not.toContain('4');
  });

  it('drops editable DESCENDANTS, keeping only the focusable editable host', async () => {
    const harness = buildHarness({
      frameTree: NESTED_FRAME_TREE,
      axTree: (frameId) => {
        if (frameId === 'editor-frame') {
          return {
            nodes: [
              editableHostNode(3, ''),
              // Live Chrome stamps `editable` on every node inside an editable
              // region -- paragraphs, wrapper divs, text runs -- but only the
              // host is focusable. Without that second condition one editor
              // floods the caller's limit with unusable nodes.
              axNode(6, 'generic', '', [{ name: 'editable', value: { value: 'richtext' } }]),
              axNode(7, 'InlineTextBox', 'hello', [
                { name: 'editable', value: { value: 'richtext' } },
              ]),
              axNode(8, 'StaticText', 'hello', [
                { name: 'editable', value: { value: 'richtext' } },
              ]),
            ],
          };
        }
        return { nodes: [axNode(1, 'textbox', 'Subject')] };
      },
    });

    const result = await harness.capture(1, {});
    const uids = (result.nodes as { uid: string }[]).map((n) => n.uid);

    // The focusable host survives.
    expect(uids).toContain('3');
    // Editable-but-not-focusable generic/InlineTextBox descendants do not: this
    // is the whole point of the second condition.
    expect(uids).not.toContain('6');
    expect(uids).not.toContain('7');
    // StaticText is retained by the pre-existing role rules, not by the editable
    // exemption -- it carries the visible label and always was kept.
    expect(uids).toContain('8');
  });

  it('marks ONLY the editable host, never the document, paragraphs or text', async () => {
    const harness = buildHarness({
      frameTree: NESTED_FRAME_TREE,
      axTree: (frameId) => {
        if (frameId === 'editor-frame') {
          return {
            nodes: [
              // The frame document reports editable AND focusable, but it is a
              // #document and cannot accept a write.
              axNode(10, 'RootWebArea', '', [
                { name: 'editable', value: { value: 'richtext' } },
                { name: 'focusable', value: { value: true } },
              ]),
              editableHostNode(11, ''),
              // A paragraph inside a contenteditable ACCEPTS a write and reports
              // success, so marking it points an agent at overwriting one
              // paragraph of the editor and being told it worked.
              axNode(12, 'paragraph', '', [{ name: 'editable', value: { value: 'richtext' } }]),
              axNode(13, 'StaticText', 'hello', [
                { name: 'editable', value: { value: 'richtext' } },
              ]),
            ],
          };
        }
        return { nodes: [axNode(1, 'textbox', 'Subject')] };
      },
    });

    const result = await harness.capture(1, {});
    const byUid = new Map(
      (result.nodes as { uid: string; editable?: string }[]).map((n) => [n.uid, n]),
    );

    expect(byUid.get('11')?.editable).toBe('richtext');
    expect(byUid.get('10')?.editable).toBeUndefined();
    expect(byUid.get('12')?.editable).toBeUndefined();
    expect(byUid.get('13')?.editable).toBeUndefined();
  });

  it('never skips the MAIN frame for time, even with the budget already spent', async () => {
    const harness = buildHarness({
      frameTree: NESTED_FRAME_TREE,
      axTree: () => ({ nodes: [axNode(1, 'textbox', 'Subject')] }),
      msPerFrame: 0,
      startElapsedMs: 999_000,
    });

    const result = await harness.capture(1, {});

    // A slow debugger attach can burn the whole budget before the first frame.
    // Returning a confidently EMPTY tree there is worse than any error, so the
    // main frame always gets at least the minimum slice.
    expect(harness.requestedFrameIds[0]).toBeNull();
    expect(harness.axTimeouts[0]).toBeGreaterThan(0);
    expect(result.nodes).toHaveLength(1);
  });

  it('fills the node limit from the main frame first (documented ordering hazard)', async () => {
    const harness = buildHarness({
      frameTree: NESTED_FRAME_TREE,
      axTree: (frameId) => ({
        nodes: frameId === null
          ? [axNode(1, 'textbox', 'a'), axNode(2, 'textbox', 'b')]
          : [axNode(3, 'textbox', 'c')],
      }),
    });

    const result = await harness.capture(1, { limit: 2 });

    // Child frames ARE read (so this cannot pass with traversal removed), but
    // main-frame nodes are emitted first, so a tight limit hides in-iframe
    // content. browser.accessibility_snapshot's description states this so an
    // agent raises the limit or uses a query_elements selector instead of
    // concluding the control does not exist.
    expect(harness.requestedFrameIds).toEqual([null, 'editor-frame', 'oopif-frame']);
    expect((result.nodes as { uid: string }[]).map((n) => n.uid)).toEqual(['1', '2']);
  });
});

describe('uidTypeFn refuses targets that cannot hold a value', () => {
  function buildTypeFn() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    // jsdom implements no layout, so scrollIntoView is absent. Chrome has it.
    dom.window.Element.prototype.scrollIntoView = () => {};
    const run = new Function(
      'window',
      'document',
      'HTMLInputElement',
      'HTMLTextAreaElement',
      'HTMLSelectElement',
      'InputEvent',
      'Event',
      `${extractFunctionSource(background, 'uidTypeFn')}; return uidTypeFn;`,
    );
    const fn = run(
      dom.window,
      dom.window.document,
      dom.window.HTMLInputElement,
      dom.window.HTMLTextAreaElement,
      dom.window.HTMLSelectElement,
      dom.window.InputEvent,
      dom.window.Event,
    );
    return { fn, document: dom.window.document };
  }

  it('still types into a real input and reports it applied', () => {
    const { fn, document } = buildTypeFn();
    const input = document.createElement('input');
    document.body.appendChild(input);

    const result = fn.call(input, 'DN827315');

    expect(result.valueApplied).toBe(true);
    expect(input.value).toBe('DN827315');
  });

  it('throws instead of reporting success when the uid points at an iframe', () => {
    const { fn, document } = buildTypeFn();
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);

    // Before the fix this returned { valueApplied: true } having set an expando:
    // a confident success for typing nothing a human could see.
    expect(() => fn.call(iframe, 'Hello,')).toThrow(/cannot accept typed text/);
    expect(() => fn.call(iframe, 'Hello,')).toThrow(/query_elements/);
  });

  it('throws for a plain div that is not contenteditable', () => {
    const { fn, document } = buildTypeFn();
    const div = document.createElement('div');
    document.body.appendChild(div);

    expect(() => fn.call(div, 'text')).toThrow(/cannot accept typed text/);
  });

  it('names the real problem when the uid resolves to a frame document', () => {
    const { fn, document } = buildTypeFn();

    // Every merged frame contributes a RootWebArea node whose uid resolves to a
    // #document. Before the guard this died on scrollIntoView with an opaque
    // "not a function" TypeError instead of saying what was wrong.
    expect(() => fn.call(document, 'text')).toThrow(/not an element/);
    expect(() => fn.call(document, 'text')).toThrow(/query_elements/);
  });

  it('refuses a <button>, which carries a value nobody can see change', () => {
    const { fn, document } = buildTypeFn();
    const button = document.createElement('button');
    document.body.appendChild(button);

    // `'value' in button` is true, so a value-property check alone still
    // reported success here while changing nothing visible.
    expect(() => fn.call(button, 'text')).toThrow(/cannot accept typed text/);
  });

  it('still types into a custom element exposing its own value accessor', () => {
    const { fn, document } = buildTypeFn();
    const custom = document.createElement('my-input');
    let stored = '';
    Object.defineProperty(custom, 'value', {
      get: () => stored,
      set: (next: string) => { stored = next; },
      configurable: true,
    });
    document.body.appendChild(custom);

    const result = fn.call(custom, 'DN827315');

    expect(result.valueApplied).toBe(true);
    expect(stored).toBe('DN827315');
  });

  it('guards uidSelectFn too, the third uid entry point', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    dom.window.Element.prototype.scrollIntoView = () => {};
    const run = new Function(
      'window', 'document', 'HTMLSelectElement',
      `${extractFunctionSource(background, 'uidSelectFn')}; return uidSelectFn;`,
    );
    const uidSelectFn = run(dom.window, dom.window.document, dom.window.HTMLSelectElement);

    expect(() => uidSelectFn.call(dom.window.document, 'x')).toThrow(/not an element/);
  });

  it('still writes into a contenteditable host', () => {
    const { fn, document } = buildTypeFn();
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    document.body.appendChild(editable);

    const result = fn.call(editable, 'Kind regards,');

    expect(result.valueAfter).toBe('Kind regards,');
  });
});

describe('browser.accessibility_snapshot description states what it withholds', () => {
  it('names every way iframe content can be missing', async () => {
    const { createBrowserMcpTools } = await import('./browser-mcp-tools');
    const tool = createBrowserMcpTools({ call: async () => undefined } as never)
      .find((t) => t.name === 'browser.accessibility_snapshot');
    const description = JSON.stringify(tool?.inputSchema ?? {});

    // The defect this whole change set exists to fix was documentation that
    // promised iframe coverage the code withheld. Every withholding path must
    // be stated, or an agent concludes a control does not exist.
    expect(description).toContain('cross-origin OOPIFs are skipped');
    expect(description).toContain('25 frames');
    expect(description).toContain('time budget expires');
    expect(description).toContain('main-frame nodes come FIRST');
    expect(description).toContain('editable');
  });
});

describe('the editable marker survives the coordinator, not just the extension', () => {
  it('passes `editable` through the normalizer and the strict contract schema', async () => {
    const { normalizeAccessibilityNodes } = await import('./browser-gateway-normalizers');
    const { BrowserAccessibilityNodeSchema } = await import(
      '@contracts/schemas/browser-interaction.schemas'
    );

    // Exactly what live Chrome reports for a TinyMCE body: role generic, EMPTY
    // name, identifiable only by `editable`.
    const nodes = normalizeAccessibilityNodes(
      [{ uid: '43', role: 'generic', name: '', editable: 'richtext' }],
      50,
    );

    // The normalizer is an allowlist and the schema is .strict(): if either one
    // is missed, the extension's fix dies at the process boundary and the agent
    // receives a bare { uid, role: 'generic' } it cannot tell from any other
    // unnamed wrapper.
    expect(nodes[0]?.editable).toBe('richtext');
    expect(() => BrowserAccessibilityNodeSchema.parse(nodes[0])).not.toThrow();
  });
});

describe('selector type path refuses what the uid path refuses', () => {
  function buildApplyType() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    dom.window.Element.prototype.scrollIntoView = () => {};
    const run = new Function(
      'window', 'document', 'HTMLInputElement', 'HTMLTextAreaElement',
      'HTMLSelectElement', 'InputEvent', 'Event',
      [
        extractFunctionSource(background, 'setNativeValue'),
        extractFunctionSource(background, 'fillContentEditable'),
        extractFunctionSource(background, 'describeElement'),
        extractFunctionSource(background, 'applyType'),
        'return applyType;',
      ].join('\n'),
    );
    const applyType = run(
      dom.window, dom.window.document, dom.window.HTMLInputElement,
      dom.window.HTMLTextAreaElement, dom.window.HTMLSelectElement,
      dom.window.InputEvent, dom.window.Event,
    );
    return { applyType, document: dom.window.document };
  }

  it('refuses an iframe selector, the remedy the uid error recommends', () => {
    const { applyType, document } = buildApplyType();
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);

    // The uid refusal tells callers to retry with a CSS selector. Before this
    // guard that advice led straight into the SAME expando false-success, so a
    // blank tender message was still reachable via the fix's own remedy.
    expect(() => applyType(iframe, 'Hello,')).toThrow(/cannot accept typed text/);
  });

  it('refuses a plain div selector', () => {
    const { applyType, document } = buildApplyType();
    const div = document.createElement('div');
    document.body.appendChild(div);

    expect(() => applyType(div, 'text')).toThrow(/cannot accept typed text/);
  });

  it('still types into a real input by selector', () => {
    const { applyType, document } = buildApplyType();
    const input = document.createElement('input');
    document.body.appendChild(input);

    const result = applyType(input, 'DN827315');

    expect(result.valueApplied).toBe(true);
    expect(input.value).toBe('DN827315');
  });
});

describe('a refusal reaches the caller instead of becoming "no element"', () => {
  function buildMerge() {
    const run = new Function(
      `${extractFunctionSource(background, 'mergeFrameResults')}; return mergeFrameResults;`,
    );
    return run();
  }

  it('surfaces a type refusal rather than reporting the selector did not match', () => {
    const mergeFrameResults = buildMerge();

    // The refusal happens INSIDE the injected page function. A frame that throws
    // contributes no result, and the merge then reports "No element matches
    // selector" -- false, because the element matched and was refused, and it
    // sends an unattended agent hunting the wrong problem.
    expect(() => mergeFrameResults(
      'type',
      [{ __found: true, __refusal: 'type target cannot accept typed text: <iframe>' }],
      ['iframe#body_ifr', 'Hello,'],
    )).toThrow(/cannot accept typed text/);

    expect(() => mergeFrameResults(
      'type',
      [{ __found: true, __refusal: 'type target cannot accept typed text: <iframe>' }],
      ['iframe#body_ifr', 'Hello,'],
    )).not.toThrow(/No element matches/);
  });

  it('names the failing field and what already landed on a partial fill_form', () => {
    const mergeFrameResults = buildMerge();
    const fields = [{ selector: '#a' }, { selector: '#b' }, { selector: '#c' }];

    // A partial write on a live portal form with no list of which fields
    // changed is unauditable; the old behaviour named field 1 regardless.
    expect(() => mergeFrameResults(
      'fill_form',
      [{
        __fields: [
          { __found: true, selector: '#a', valueApplied: true },
          { __found: true, selector: '#b', __refusal: 'cannot accept typed text: <div>', __applied: ['#a'] },
        ],
      }],
      [fields],
    )).toThrow(
      /stopped at field 2 of 3 in this frame; fields already applied across all frames: #a/,
    );
  });

  it('still returns a normal type result when nothing was refused', () => {
    const mergeFrameResults = buildMerge();

    const merged = mergeFrameResults(
      'type',
      [{ __found: true, valueApplied: true, tagName: 'INPUT' }],
      ['#subject', 'DN827315'],
    );

    expect(merged).toEqual({ valueApplied: true, tagName: 'INPUT' });
  });
});

describe('page bridge join: a refusal becomes a sentinel, not a thrown frame', () => {
  function buildBridge() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    dom.window.Element.prototype.scrollIntoView = () => {};
    const run = new Function(
      'window', 'document', 'HTMLInputElement', 'HTMLTextAreaElement',
      'HTMLSelectElement', 'InputEvent', 'Event', 'Node',
      `${extractFunctionSource(background, 'pageBridgeScript')}; return pageBridgeScript;`,
    );
    const pageBridgeScript = run(
      dom.window, dom.window.document, dom.window.HTMLInputElement,
      dom.window.HTMLTextAreaElement, dom.window.HTMLSelectElement,
      dom.window.InputEvent, dom.window.Event, dom.window.Node,
    );
    return { pageBridgeScript, document: dom.window.document };
  }

  // The two ends were tested separately (applyType throws; mergeFrameResults
  // rethrows a hand-built sentinel) but never the join -- which is the only path
  // a real caller uses, and where the cross-frame defect actually lived.

  it('returns __found with a __refusal instead of throwing out of the frame', () => {
    const { pageBridgeScript, document } = buildBridge();
    document.body.innerHTML = '<iframe id="ed"></iframe>';

    const result = pageBridgeScript('type', ['#ed', 'Hello,']);

    // Throwing here loses the frame's result entirely and the merge then reports
    // "No element matches selector" -- false, since the element matched.
    expect(result.__found).toBe(true);
    expect(result.__refusal).toMatch(/cannot accept typed text/);
  });

  it('still returns a clean success for a real input', () => {
    const { pageBridgeScript, document } = buildBridge();
    document.body.innerHTML = '<input id="a">';

    const result = pageBridgeScript('type', ['#a', 'DN827315']);

    expect(result.__found).toBe(true);
    expect(result.__refusal).toBeUndefined();
    expect(result.valueApplied).toBe(true);
  });

  it('stops the field loop at the refusal and lists what that frame applied', () => {
    const { pageBridgeScript, document } = buildBridge();
    document.body.innerHTML = '<input id="a"><iframe id="b"></iframe><input id="c">';

    const result = pageBridgeScript('fill_form', [[
      { selector: '#a', value: '1' },
      { selector: '#b', value: '2' },
      { selector: '#c', value: '3' },
    ]]);

    expect(result.__fields).toHaveLength(2);
    expect(result.__fields[0]).toMatchObject({ selector: '#a', valueApplied: true });
    expect(result.__fields[1].__refusal).toMatch(/cannot accept typed text/);
    expect(result.__fields[1].__applied).toEqual(['#a']);
    // Field 3 must not be written after a refusal in the same frame.
    expect(document.querySelector('#c').value).toBe('');
  });

  it('reports writes from OTHER frames, which a refusal cannot stop', () => {
    const mergeFrameResults = new Function(
      `${extractFunctionSource(background, 'mergeFrameResults')}; return mergeFrameResults;`,
    )();
    const fields = [{ selector: '#a' }, { selector: '#b' }, { selector: '#c' }];

    // Injection is per-frame and frames run concurrently, so a sibling frame can
    // already have written a LATER field by the time the merge runs. Reporting
    // only the refusing frame's list hides a real write -- on the target page,
    // an overwrite of the tender response body.
    const frameA = { __fields: [
      { __found: true, selector: '#a', valueApplied: true },
      { __found: true, selector: '#b', __refusal: 'cannot accept typed text: <iframe>', __applied: ['#a'] },
    ] };
    const frameB = { __fields: [
      undefined,
      undefined,
      { __found: true, selector: '#c', valueApplied: true },
    ] };

    expect(() => mergeFrameResults('fill_form', [frameA, frameB], [fields]))
      .toThrow(/already applied across all frames: #a, #c/);
  });
});

describe('a write that happened is never reported as not having happened', () => {
  function buildBridge() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    dom.window.Element.prototype.scrollIntoView = () => {};
    const run = new Function(
      'window', 'document', 'HTMLInputElement', 'HTMLTextAreaElement',
      'HTMLSelectElement', 'InputEvent', 'Event', 'Node',
      `${extractFunctionSource(background, 'pageBridgeScript')}; return pageBridgeScript;`,
    );
    return {
      pageBridgeScript: run(
        dom.window, dom.window.document, dom.window.HTMLInputElement,
        dom.window.HTMLTextAreaElement, dom.window.HTMLSelectElement,
        dom.window.InputEvent, dom.window.Event, dom.window.Node,
      ),
      document: dom.window.document,
    };
  }

  const merge = () => new Function(
    `${extractFunctionSource(background, 'mergeFrameResults')}; return mergeFrameResults;`,
  )();

  it('survives an invalid CSS selector instead of discarding the whole frame', () => {
    const { pageBridgeScript, document } = buildBridge();
    document.body.innerHTML = '<input id="a"><input id="c">';

    // querySelector THROWS on an invalid selector. Uncaught, the frame returns
    // nothing and the merge blames field 1 -- which was written. `a[` throws in
    // both jsdom and Chrome. Real Chrome also throws on `div:contains(x)` -- the
    // textbook unattended-agent mistake -- but jsdom's nwsapi tolerates that one,
    // so this selector is chosen to throw in both engines.
    const result = pageBridgeScript('fill_form', [[
      { selector: '#a', value: 'ONE' },
      { selector: 'a[', value: 'TWO' },
      { selector: '#c', value: 'THREE' },
    ]]);

    expect(result.__fields[0]).toMatchObject({ selector: '#a', valueApplied: true });
    expect(result.__fields[1].__refusal).toMatch(/invalid CSS selector/);
    expect(result.__fields[1].__applied).toEqual(['#a']);
    expect(document.querySelector('#c').value).toBe('');
  });

  it('reports an invalid selector as invalid on a single-element action', () => {
    const { pageBridgeScript, document } = buildBridge();
    document.body.innerHTML = '<input id="a">';

    // Previously the throw discarded the frame and the merge said the element
    // did not match -- telling an unattended agent to wait for a page state
    // that will never arrive instead of that its selector is malformed.
    const result = pageBridgeScript('type', ['a[', 'x']);

    // Reported as a DISTINCT sentinel, not `__found: true`: the wait_for poll
    // selects purely on `__found` and would otherwise report that the awaited
    // element had appeared.
    expect(result.__found).toBeUndefined();
    expect(result.__invalidSelector).toMatch(/invalid CSS selector/);
  });

  it('stops and reports on a field with no selector at all', () => {
    const { pageBridgeScript, document } = buildBridge();
    document.body.innerHTML = '<input id="a"><input id="c">';

    // selector and uid are both optional in the published tool schema, so an
    // agent omitting one is reachable input, not a contract violation.
    const result = pageBridgeScript('fill_form', [[
      { selector: '#a', value: 'ONE' },
      { value: 'TWO' },
      { selector: '#c', value: 'THREE' },
    ]]);

    expect(result.__fields[1]).toMatchObject({ invalid: true, __applied: ['#a'] });
    expect(document.querySelector('#c').value).toBe('');
  });

  it('names the field index and the applied list for a missing selector', () => {
    const mergeFrameResults = merge();

    expect(() => mergeFrameResults(
      'fill_form',
      [{ __fields: [
        { __found: true, selector: '#a', valueApplied: true },
        { invalid: true, __applied: ['#a'] },
      ] }],
      [[{ selector: '#a' }, { value: 'x' }, { selector: '#c' }]],
    )).toThrow(/stopped at field 2 of 3.*already applied across all frames: #a/s);
  });

  it('raises a no-retry error when one frame refused and another wrote', () => {
    const mergeFrameResults = merge();

    // Chrome returns the main frame first. A selector matching a wrapper <div>
    // there and the real editable body in the editor frame produces BOTH a
    // refusal and a completed write. Throwing the refusal alone says nothing
    // happened; returning success says nothing was ambiguous -- and the gateway
    // DISCARDS a mutation's payload, so success can carry no warning at all.
    // Only the thrown message reaches the caller, so it must state that the
    // write landed and must not be repeated.
    let thrown: Error | undefined;
    try {
      mergeFrameResults(
        'type',
        [
          { __found: true, __refusal: 'type target cannot accept typed text: <div>' },
          { __found: true, valueApplied: true, valueAfter: 'THE TENDER BODY' },
        ],
        ['.editor', 'THE TENDER BODY'],
      );
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).toMatch(/Ambiguous selector/);
    expect(thrown?.message).toMatch(/WAS applied in 1 of them/);
    expect(thrown?.message).toMatch(/DO NOT retry/);
    expect(thrown?.message).toMatch(/cannot accept typed text: <div>/);
  });

  it('raises the same no-retry error when TWO frames both wrote', () => {
    const mergeFrameResults = merge();

    // A generic selector like textarea[name="response"] can exist in the page
    // AND in an editor iframe. Both get written; returning one result reports a
    // single write and silently hides the second.
    expect(() => mergeFrameResults(
      'type',
      [
        { __found: true, valueApplied: true },
        { __found: true, valueApplied: true },
      ],
      ['textarea[name="response"]', 'x'],
    )).toThrow(/matched in 2 frames.*WAS applied in 2 of them/s);
  });

  it('returns plainly when exactly one frame matched', () => {
    const mergeFrameResults = merge();

    expect(mergeFrameResults(
      'type',
      [{ __found: true, valueApplied: true, tagName: 'INPUT' }],
      ['#subject', 'x'],
    )).toEqual({ valueApplied: true, tagName: 'INPUT' });
  });

  it('prefers a frame that applied a fill_form field over one that refused it', () => {
    const mergeFrameResults = merge();

    // `type` was taught this; fill_form was not, so a wrapper refusing field 2
    // in the main frame reported a FAILED fill for a form whose every field
    // landed -- and an unattended retry then writes the whole form twice.
    const merged = mergeFrameResults(
      'fill_form',
      [
        { __fields: [
          { __found: true, selector: '#a', valueApplied: true },
          { __found: true, selector: '#b', __refusal: 'cannot accept typed text: <div>', __applied: ['#a'] },
        ] },
        { __fields: [
          undefined,
          { __found: true, selector: '#b', valueApplied: true },
        ] },
      ],
      [[{ selector: '#a' }, { selector: '#b' }]],
    );

    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({ selector: '#b', valueApplied: true });
  });

  it('still throws when every matching frame refused', () => {
    const mergeFrameResults = merge();

    expect(() => mergeFrameResults(
      'type',
      [{ __found: true, __refusal: 'type target cannot accept typed text: <iframe>' }],
      ['#ed', 'x'],
    )).toThrow(/cannot accept typed text/);
  });
});

describe('a custom dropdown that selected nothing does not report success', () => {
  it('rejects instead of resolving with a note nobody sees', async () => {
    vi.useFakeTimers();
    try {
      const dom = new JSDOM('<!doctype html><html><body><div id="dd">Choose</div></body></html>');
      dom.window.Element.prototype.scrollIntoView = () => {};
      const run = new Function(
        'window', 'document', 'HTMLInputElement', 'HTMLTextAreaElement',
        'HTMLSelectElement', 'InputEvent', 'Event', 'Node', 'MouseEvent',
        `${extractFunctionSource(background, 'pageBridgeScript')}; return pageBridgeScript;`,
      );
      const pageBridgeScript = run(
        dom.window, dom.window.document, dom.window.HTMLInputElement,
        dom.window.HTMLTextAreaElement, dom.window.HTMLSelectElement,
        dom.window.InputEvent, dom.window.Event, dom.window.Node, dom.window.MouseEvent,
      );

      // The original code RESOLVED with { note: 'custom_select_option_not_found' }
      // and the gateway discards a mutation's payload, so the agent was told the
      // option was chosen while the dropdown sat open with nothing selected.
      // selectValue now rejects -- but that rejection must NOT escape the
      // injected function, or the frame contributes no result and the merge
      // reports "No element matches selector" instead. It comes back as a
      // refusal sentinel that the merge rethrows verbatim.
      const pending = pageBridgeScript('select', ['#dd', 'Option that does not exist']);
      await vi.advanceTimersByTimeAsync(2_500);
      const result = await pending;

      expect(result.__found).toBe(true);
      expect(result.__refusal).toMatch(/nothing was selected/);

      const mergeFrameResults = new Function(
        `${extractFunctionSource(background, 'mergeFrameResults')}; return mergeFrameResults;`,
      )();
      expect(() => mergeFrameResults('select', [result], ['#dd', 'x']))
        .toThrow(/nothing was selected/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('round 8: the fixes must not create the defect they remove', () => {
  function buildBridge() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    dom.window.Element.prototype.scrollIntoView = () => {};
    const run = new Function(
      'window', 'document', 'HTMLInputElement', 'HTMLTextAreaElement',
      'HTMLSelectElement', 'InputEvent', 'Event', 'Node', 'MouseEvent',
      `${extractFunctionSource(background, 'pageBridgeScript')}; return pageBridgeScript;`,
    );
    return {
      pageBridgeScript: run(
        dom.window, dom.window.document, dom.window.HTMLInputElement,
        dom.window.HTMLTextAreaElement, dom.window.HTMLSelectElement,
        dom.window.InputEvent, dom.window.Event, dom.window.Node, dom.window.MouseEvent,
      ),
      document: dom.window.document,
    };
  }

  const merge = () => new Function(
    `${extractFunctionSource(background, 'mergeFrameResults')}; return mergeFrameResults;`,
  )();

  it('does not report a wait_for hit for a malformed selector', () => {
    const { pageBridgeScript } = buildBridge();

    // The `find` probe feeds the wait_for poll, which selects purely on
    // `__found`. Returning `{__found: true, __refusal}` made an invalid selector
    // report that the awaited element had appeared -- a non-event reported as
    // having happened, on the tool an agent uses to gate a submission.
    const probe = pageBridgeScript('find', ['a[']);

    expect(probe.__found).toBeUndefined();
    expect(probe.__invalidSelector).toMatch(/invalid CSS selector/);
  });

  it('raises the malformed selector for every action, reads included', () => {
    const mergeFrameResults = merge();

    for (const action of ['find', 'read_control', 'click', 'type']) {
      expect(() => mergeFrameResults(
        action,
        [{ __invalidSelector: 'invalid CSS selector: bad' }],
        ['a[', 'x'],
      )).toThrow(/invalid CSS selector/);
    }
  });

  it('never claims a write for read_control, which writes nothing', () => {
    const mergeFrameResults = merge();

    // read_control routes through the same merge branch as type/select. Raising
    // "the value WAS applied" there broke assert_persisted and made a `type`
    // that genuinely landed report as FAILED whenever its independent verify
    // selector matched in two frames.
    const merged = mergeFrameResults(
      'read_control',
      [{ __found: true, value: 'a' }, { __found: true, value: 'b' }],
      ['.field'],
    );

    expect(merged).toEqual({ value: 'a' });
  });

  it('lets a generic click match every frame, as it always did', () => {
    const mergeFrameResults = merge();

    // `browser.click('body')` matches in every injected frame including
    // about:blank children. A click carries no value that can overwrite content,
    // so hard-failing here would be a pure regression.
    expect(() => mergeFrameResults(
      'click',
      [{ __found: true }, { __found: true }],
      ['body'],
    )).not.toThrow();
  });

  it('carries a select rejection back instead of losing the frame', async () => {
    const { pageBridgeScript, document } = buildBridge();
    document.body.innerHTML = '<select id="s"><option value="a">Alpha</option></select>';

    // A rejection escaping the injected function makes the frame contribute no
    // result, and the merge then says "No element matches selector" -- telling
    // the caller the control does not exist.
    const result = await pageBridgeScript('select', ['#s', 'Not An Option']);

    expect(result.__found).toBe(true);
    expect(result.__refusal).toMatch(/no option matching/);
    // And crucially the control was NOT cleared.
    expect((document.querySelector('#s') as HTMLSelectElement).value).toBe('a');
  });

  it('raises a fill_form field written in two frames', () => {
    const mergeFrameResults = merge();

    expect(() => mergeFrameResults(
      'fill_form',
      [
        { __fields: [{ __found: true, selector: '#r', valueApplied: true }] },
        { __fields: [{ __found: true, selector: '#r', valueApplied: true }] },
      ],
      [[{ selector: '#r' }]],
    )).toThrow(/written in 2 frames.*DO NOT retry/s);
  });
});

describe('round 9: nothing may blank a native <select> and call it success', () => {
  function buildBridge() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    dom.window.Element.prototype.scrollIntoView = () => {};
    const run = new Function(
      'window', 'document', 'HTMLInputElement', 'HTMLTextAreaElement',
      'HTMLSelectElement', 'InputEvent', 'Event', 'Node', 'MouseEvent',
      `${extractFunctionSource(background, 'pageBridgeScript')}; return pageBridgeScript;`,
    );
    return {
      pageBridgeScript: run(
        dom.window, dom.window.document, dom.window.HTMLInputElement,
        dom.window.HTMLTextAreaElement, dom.window.HTMLSelectElement,
        dom.window.InputEvent, dom.window.Event, dom.window.Node, dom.window.MouseEvent,
      ),
      window: dom.window,
      document: dom.window.document,
    };
  }

  function buildUidFn(name: string, dom: { window: Window & typeof globalThis }) {
    const run = new Function(
      'window', 'document', 'HTMLInputElement', 'HTMLTextAreaElement',
      'HTMLSelectElement', 'InputEvent', 'Event',
      `${extractFunctionSource(background, name)}; return ${name};`,
    );
    const w = dom.window as unknown as Record<string, never>;
    return run(
      w, (w as never as { document: unknown }).document,
      (w as never as { HTMLInputElement: unknown }).HTMLInputElement,
      (w as never as { HTMLTextAreaElement: unknown }).HTMLTextAreaElement,
      (w as never as { HTMLSelectElement: unknown }).HTMLSelectElement,
      (w as never as { InputEvent: unknown }).InputEvent,
      (w as never as { Event: unknown }).Event,
    );
  }

  const SELECT_HTML = '<select id="s">'
    + '<option value="1">Yes</option><option value="2" selected>No</option></select>';

  it('uid select: refuses an unmatched value instead of clearing the control', () => {
    const bridge = buildBridge();
    bridge.document.body.innerHTML = SELECT_HTML;
    const uidSelectFn = buildUidFn('uidSelectFn', bridge as never);
    const select = bridge.document.querySelector('#s') as HTMLSelectElement;

    // The accessibility-snapshot work exists so agents address controls BY UID,
    // so this is the promoted path. Assigning an unmatched value sets
    // selectedIndex to -1 and blanks a mandatory dropdown, and the gateway
    // discards the payload so it was reported as success.
    expect(() => uidSelectFn.call(select, 'Maybe')).toThrow(/no <select> option matches/);
    expect(select.value).toBe('2');
  });

  it('uid select: still selects a real option by visible label', () => {
    const bridge = buildBridge();
    bridge.document.body.innerHTML = SELECT_HTML;
    const uidSelectFn = buildUidFn('uidSelectFn', bridge as never);
    const select = bridge.document.querySelector('#s') as HTMLSelectElement;

    const result = uidSelectFn.call(select, 'Yes');

    expect(select.value).toBe('1');
    expect(result.matchedOption).toBe('Yes');
  });

  it('uid type: refuses a <select> rather than blanking it', () => {
    const bridge = buildBridge();
    bridge.document.body.innerHTML = SELECT_HTML;
    const uidTypeFn = buildUidFn('uidTypeFn', bridge as never);
    const select = bridge.document.querySelector('#s') as HTMLSelectElement;

    expect(() => uidTypeFn.call(select, 'Maybe')).toThrow(/no <select> option matches/);
    expect(select.value).toBe('2');
  });

  it('fill_form via selector: a correct label selects, a wrong one refuses', () => {
    const bridge = buildBridge();
    bridge.document.body.innerHTML = SELECT_HTML;

    // applyType did NO option matching, so even the CORRECT visible label "Yes"
    // (option value "1") cleared the control. fill_form's flat {selector, value}
    // schema gives an agent no reason to use browser.select for a dropdown.
    const ok = bridge.pageBridgeScript('fill_form', [[{ selector: '#s', value: 'Yes' }]]);
    expect(ok.__fields[0].__refusal).toBeUndefined();
    expect((bridge.document.querySelector('#s') as HTMLSelectElement).value).toBe('1');

    const bad = bridge.pageBridgeScript('fill_form', [[{ selector: '#s', value: 'Maybe' }]]);
    expect(bad.__fields[0].__refusal).toMatch(/no <select> option matches/);
    expect((bridge.document.querySelector('#s') as HTMLSelectElement).value).toBe('1');
  });

  it('raises a duplicate click on an activating control, not on body', () => {
    const mergeFrameResults = new Function(
      `${extractFunctionSource(background, 'mergeFrameResults')}; return mergeFrameResults;`,
    )();

    // Every matching frame has ALREADY dispatched a real click by the time the
    // merge runs, so a submit button in a same-origin iframed form submits twice.
    expect(() => mergeFrameResults(
      'click',
      [{ __found: true, tagName: 'BUTTON' }, { __found: true, tagName: 'BUTTON' }],
      ['button[type=submit]'],
    )).toThrow(/ALREADY clicked.*DO NOT retry/s);

    // A generic document-level click legitimately matches every frame.
    expect(() => mergeFrameResults(
      'click',
      [{ __found: true, tagName: 'BODY' }, { __found: true, tagName: 'BODY' }],
      ['body'],
    )).not.toThrow();
  });
});

describe('round 10: a multi-select must not lose its other choices', () => {
  function bridgeAndUid() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    dom.window.Element.prototype.scrollIntoView = () => {};
    const mk = (name: string) => new Function(
      'window', 'document', 'HTMLInputElement', 'HTMLTextAreaElement',
      'HTMLSelectElement', 'InputEvent', 'Event', 'Node', 'MouseEvent',
      `${extractFunctionSource(background, name)}; return ${name};`,
    )(
      dom.window, dom.window.document, dom.window.HTMLInputElement,
      dom.window.HTMLTextAreaElement, dom.window.HTMLSelectElement,
      dom.window.InputEvent, dom.window.Event, dom.window.Node, dom.window.MouseEvent,
    );
    return { document: dom.window.document, mk };
  }

  const MULTI = '<select id="m" multiple>'
    + '<option value="a" selected>Lot A</option>'
    + '<option value="b" selected>Lot B</option>'
    + '<option value="c">Lot C</option></select>';

  it('adds to a multi-select instead of replacing everything', () => {
    const { document, mk } = bridgeAndUid();
    document.body.innerHTML = MULTI;
    const uidSelectFn = mk('uidSelectFn');
    const select = document.querySelector('#m') as HTMLSelectElement;

    // The `value` setter deselects EVERY option first, so picking Lot C used to
    // silently drop Lots A and B and report success -- a ProContract lot or
    // region multi-select would lose its existing ticks.
    uidSelectFn.call(select, 'Lot C');

    const selected = Array.from(select.selectedOptions).map((option) => option.value);
    expect(selected.sort()).toEqual(['a', 'b', 'c']);
  });

  it('leaves a single-select as a replacement, not an addition', () => {
    const { document, mk } = bridgeAndUid();
    document.body.innerHTML = '<select id="s">'
      + '<option value="1">Yes</option><option value="2" selected>No</option></select>';
    const uidSelectFn = mk('uidSelectFn');
    const select = document.querySelector('#s') as HTMLSelectElement;

    uidSelectFn.call(select, 'Yes');

    expect(Array.from(select.selectedOptions).map((option) => option.value)).toEqual(['1']);
  });

  it('matches a label broken across lines by indented markup', () => {
    const { document, mk } = bridgeAndUid();
    document.body.innerHTML = '<select id="s"><option value="1">Yes,\n      please</option></select>';
    const uidSelectFn = mk('uidSelectFn');
    const select = document.querySelector('#s') as HTMLSelectElement;

    // `.trim()` only strips the ends, so ordinary indented markup was refused on
    // the shared tab while the managed profile accepted it -- the two drivers
    // disagreeing about the same page.
    uidSelectFn.call(select, 'Yes, please');

    expect(select.value).toBe('1');
  });

  it('refuses a disabled option rather than submitting an unpickable value', () => {
    const { document, mk } = bridgeAndUid();
    document.body.innerHTML = '<select id="s">'
      + '<option value="1" selected>Yes</option>'
      + '<option value="2" disabled>Withdrawn</option></select>';
    const uidSelectFn = mk('uidSelectFn');
    const select = document.querySelector('#s') as HTMLSelectElement;

    expect(() => uidSelectFn.call(select, 'Withdrawn')).toThrow(/no <select> option matches/);
    expect(select.value).toBe('1');
  });
});
