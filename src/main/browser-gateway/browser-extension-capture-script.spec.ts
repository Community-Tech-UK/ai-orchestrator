import { readFileSync } from 'node:fs';
// jsdom ships no type declarations and @types/jsdom is not installed; a sibling
// spec already declares the ambient module, so import it untyped here too.
// @ts-expect-error No type declarations available for 'jsdom' in this repo.
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it } from 'vitest';

// The console/network capture buffer is injected into the page's MAIN world as
// a serialized function (chrome.scripting.executeScript { world: 'MAIN', func }).
// These tests re-inject the exact same functions into a real jsdom window — the
// faithful equivalent of how Chrome runs them — and assert the observable
// capture behavior the console-read prompt requires (structured output +
// preservation across in-page navigations).

/**
 * Extract a top-level `function name() { … }` verbatim from the extension source
 * by brace-matching. The two capture functions contain no braces inside string
 * or template literals, so a plain depth counter is exact for them.
 */
function extractFunctionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) {
    throw new Error(`function ${name} not found in background.js`);
  }
  let depth = 0;
  let seenBrace = false;
  let i = source.indexOf('{', start);
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') {
      depth++;
      seenBrace = true;
    } else if (ch === '}') {
      depth--;
      if (seenBrace && depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new Error(`Unbalanced braces extracting ${name}`);
}

const background = readFileSync('resources/browser-extension/background.js', 'utf-8');
const installSource = extractFunctionSource(background, 'installCaptureScript');
const readSource = extractFunctionSource(background, 'readCaptureScript');

interface CaptureWindow {
  __install: () => { installed: boolean; already: boolean };
  __read: (
    kind: 'console' | 'network',
    sinceSeq: number | null,
    level: string | null,
  ) => { installed: boolean; entries: Array<Record<string, unknown>> };
  console: Console;
  fetch: (input: unknown, init?: unknown) => Promise<unknown>;
  history: History;
  eval: (code: string) => unknown;
  dispatchEvent: (event: Event) => boolean;
  ErrorEvent: typeof ErrorEvent;
  PromiseRejectionEvent: typeof PromiseRejectionEvent;
}

function makeCaptureWindow(): { dom: JSDOM; win: CaptureWindow } {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://app.example.com/dashboard',
    runScripts: 'dangerously',
  });
  const win = dom.window as unknown as CaptureWindow;
  win.eval(`window.__install = ${installSource}; window.__read = ${readSource};`);
  return { dom, win };
}

describe('extension MAIN-world capture script', () => {
  let win: CaptureWindow;

  beforeEach(() => {
    win = makeCaptureWindow().win;
  });

  it('buffers console.error and console.warn but not console.log', () => {
    win.__install();
    win.console.error('boom', { detail: 1 });
    win.console.warn('careful');
    win.console.log('ignored');

    const { installed, entries } = win.__read('console', null, null);
    expect(installed).toBe(true);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ type: 'error' });
    expect(String(entries[0]['text'])).toContain('boom');
    expect(entries[1]).toMatchObject({ type: 'warn', text: 'careful' });
    expect(entries.every((entry) => typeof entry['seq'] === 'number')).toBe(true);
  });

  it('is idempotent — a second install does not double-wrap console', () => {
    expect(win.__install()).toMatchObject({ installed: true, already: false });
    expect(win.__install()).toMatchObject({ installed: true, already: true });
    win.console.error('once');
    expect(win.__read('console', null, null).entries).toHaveLength(1);
  });

  it('reports not-installed before install runs', () => {
    expect(win.__read('console', null, null)).toEqual({ installed: false, entries: [] });
  });

  it('captures an uncaught error with location and stack', () => {
    win.__install();
    const error = new Error('kaboom');
    error.stack = 'Error: kaboom\n    at render (https://app.example.com/main.js:12:5)';
    const event = new win.ErrorEvent('error', {
      message: 'Uncaught Error: kaboom',
      filename: 'https://app.example.com/main.js',
      lineno: 12,
      colno: 5,
      error,
    });
    win.dispatchEvent(event as unknown as Event);

    const [entry] = win.__read('console', null, null).entries;
    expect(entry).toMatchObject({
      type: 'error',
      location: { url: 'https://app.example.com/main.js', lineNumber: 12, columnNumber: 5 },
    });
    expect(String(entry['stack'])).toContain('render');
  });

  it('captures fetch responses and failures with status + failure text', async () => {
    win.fetch = async (input: unknown) => {
      const url = typeof input === 'string' ? input : (input as { url: string }).url;
      if (url.includes('/fail')) {
        throw new Error('NetworkError when attempting to fetch resource');
      }
      return { status: 404, statusText: 'Not Found', ok: false };
    };
    win.__install();

    await (win.eval('window.fetch("https://api.example.com/orders", { method: "GET" })') as Promise<unknown>);
    await (win.eval('window.fetch("https://api.example.com/fail")') as Promise<unknown>)
      .catch(() => undefined);
    // Let the wrapper's .then/.catch microtasks flush before reading.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const entries = win.__read('network', null, null).entries;
    const ok = entries.find((entry) => String(entry['url']).includes('/orders'));
    const failed = entries.find((entry) => String(entry['url']).includes('/fail'));
    expect(ok).toMatchObject({ method: 'GET', resourceType: 'fetch', status: 404, ok: false });
    expect(failed).toMatchObject({ resourceType: 'fetch', status: 0 });
    expect(String(failed?.['failureText'])).toContain('NetworkError');
  });

  it('preserves the buffer across an in-page (SPA history) navigation', () => {
    win.__install();
    win.console.error('before route change');
    // SPA route change: same document, history API only — must NOT wipe the buffer.
    win.history.pushState({}, '', '/dashboard/settings');
    win.console.error('after route change');

    const entries = win.__read('console', null, null).entries;
    expect(entries.map((entry) => entry['text'])).toEqual([
      'before route change',
      'after route change',
    ]);
  });

  it('supports sinceSeq polling for only-new entries', () => {
    win.__install();
    win.console.error('first');
    const firstSeq = win.__read('console', null, null).entries[0]['seq'] as number;
    win.console.error('second');

    const fresh = win.__read('console', firstSeq, null).entries;
    expect(fresh).toHaveLength(1);
    expect(fresh[0]['text']).toBe('second');
  });

  it('captures status for non-fetch/xhr resources via PerformanceObserver (all resource types)', () => {
    // Stub PerformanceObserver before install so the capture script wires onto it.
    win.eval(`
      window.__perfObservers = [];
      window.PerformanceObserver = class {
        constructor(cb) { this.cb = cb; window.__perfObservers.push(this); }
        observe(opts) { this.observeOpts = opts; }
        disconnect() {}
      };
    `);
    win.__install();

    const observer = (win as unknown as { __perfObservers: Array<{
      cb: (list: { getEntries: () => unknown[] }) => void;
      observeOpts: unknown;
    }> }).__perfObservers[0];
    // Must subscribe with buffered:true so pre-install resources backfill.
    expect(observer.observeOpts).toEqual({ type: 'resource', buffered: true });

    const entries = [
      { initiatorType: 'img', name: 'https://app.example.com/logo.png', responseStatus: 404, startTime: 1, duration: 12 },
      { initiatorType: 'script', name: 'https://app.example.com/main.js', responseStatus: 200, startTime: 2, duration: 8 },
      { initiatorType: 'fetch', name: 'https://api.example.com/data', responseStatus: 500, startTime: 3, duration: 4 },
      { initiatorType: 'css', name: 'https://cdn.other.com/x.css', responseStatus: 0, startTime: 4, duration: 3 },
    ];
    observer.cb({ getEntries: () => entries });
    // Fire the img entry again — the buffered flush + live callbacks can repeat;
    // dedupe must keep it single.
    observer.cb({ getEntries: () => [entries[0]] });

    const net = win.__read('network', null, null).entries;
    const img = net.find((entry) => String(entry['url']).includes('logo.png'));
    const script = net.find((entry) => String(entry['url']).includes('main.js'));
    const css = net.find((entry) => String(entry['url']).includes('x.css'));

    expect(net.filter((entry) => String(entry['url']).includes('logo.png'))).toHaveLength(1);
    expect(img).toMatchObject({ resourceType: 'img', status: 404, ok: false });
    expect(String(img?.['failureText'])).toContain('error status');
    expect(script).toMatchObject({ resourceType: 'script', status: 200, ok: true });
    // fetch is left to the wrapper (richer detail) — not double-counted here.
    expect(net.find((entry) => String(entry['url']).includes('/data'))).toBeUndefined();
    // Cross-origin without Timing-Allow-Origin → responseStatus 0 → unknown, not a failure.
    expect(css?.['status']).toBeUndefined();
    expect(css?.['failureText']).toBeUndefined();
  });

  it('filters console entries by level when requested', () => {
    win.__install();
    win.console.error('an error');
    win.console.warn('a warning');
    expect(win.__read('console', null, 'warn').entries.map((entry) => entry['text'])).toEqual([
      'a warning',
    ]);
  });
});
