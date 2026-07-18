// jsdom ships no type declarations and @types/jsdom is not installed in this
// repository. Keep the shim local instead of widening the project's ambient
// types for one production-asset test.
// @ts-expect-error -- no bundled or installed declarations for jsdom
import { JSDOM as UntypedJSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import type { RemoteObserverSnapshot } from '../../shared/types/remote-observer.types';
import { OBSERVER_CLIENT_SCRIPT } from './observer-client-script';
import { buildObserverPageResponse } from './observer-page';

interface JSDOMOptions {
  runScripts?: 'dangerously' | 'outside-only';
  url?: string;
}

interface DOMWindow extends Window {
  eval(code: string): unknown;
}

interface JSDOMConstructor {
  new (html?: string, options?: JSDOMOptions): { window: DOMWindow };
}

const JSDOM = UntypedJSDOM as unknown as JSDOMConstructor;
const ATTACK = '<img id="xss-marker" src=x onerror="window.__xss=1">';

function hostileSnapshot(): RemoteObserverSnapshot {
  return {
    status: {
      running: true,
      mode: 'read-only',
      host: '127.0.0.1',
      port: 4877,
      token: 'observer-test-token',
      observerUrls: [
        'javascript:window.__urlXss=1',
        'https://safe.example/observer?token=observer-test-token',
      ],
      instanceCount: 1,
      jobCount: 1,
      pendingPromptCount: 1,
    },
    instances: [{
      id: 'instance-1',
      displayName: ATTACK,
      status: 'running',
      provider: ATTACK,
      model: ATTACK,
      createdAt: 1,
      lastActivity: 2,
      workingDirectoryLabel: ATTACK,
    }],
    jobs: [{
      id: 'job-1',
      taskId: 'task-1',
      name: ATTACK,
      type: 'repo-health-audit',
      status: 'running',
      workingDirectory: ATTACK,
      workflowTemplateId: 'template-1',
      useWorktree: false,
      progress: 50,
      progressMessage: ATTACK,
      createdAt: 3,
      repoContext: {
        gitAvailable: true,
        isRepo: true,
        changedFiles: [],
      },
      result: {
        summary: ATTACK,
        repoContext: {
          gitAvailable: true,
          isRepo: true,
          changedFiles: [],
        },
      },
      submission: {
        type: 'repo-health-audit',
        workingDirectory: '/workspace',
      },
    }],
    pendingPrompts: [{
      id: 'prompt-1',
      promptType: 'input-required',
      instanceId: 'instance-1',
      createdAt: 4,
      title: ATTACK,
      message: ATTACK,
    }],
  };
}

function installBrowserBoundary(window: DOMWindow, snapshot: RemoteObserverSnapshot): void {
  const fetchStub = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    const payload = url.includes('/api/snapshot')
      ? snapshot
      : [{ type: ATTACK, content: ATTACK, timestamp: 5 }];
    return { ok: true, json: async () => payload } as Response;
  });
  class FakeEventSource {
    onmessage: ((event: MessageEvent) => void) | null = null;
    addEventListener(): void {}
    close(): void {}
  }

  Object.defineProperty(window, 'fetch', { configurable: true, value: fetchStub });
  Object.defineProperty(window, 'EventSource', {
    configurable: true,
    value: FakeEventSource as unknown as typeof EventSource,
  });
  Object.defineProperty(window, 'open', { configurable: true, value: vi.fn() });
}

describe('remote observer page', () => {
  it('renders hostile snapshot and message fields as literal text without executable DOM', async () => {
    const page = buildObserverPageResponse();
    const dom = new JSDOM(page.html, {
      url: 'http://127.0.0.1:4877/?token=observer-test-token',
      runScripts: 'outside-only',
    });
    installBrowserBoundary(dom.window, hostileSnapshot());

    dom.window.eval(OBSERVER_CLIENT_SCRIPT);

    await vi.waitFor(() => {
      expect(dom.window.document.querySelector('#instance-list')?.textContent).toContain(ATTACK);
      expect(dom.window.document.querySelector('#message-list')?.textContent).toContain(ATTACK);
    });
    expect(dom.window.document.querySelector('#xss-marker')).toBeNull();
    expect(Reflect.get(dom.window, '__xss')).toBeUndefined();

    const links = Array.from(dom.window.document.querySelectorAll<HTMLAnchorElement>('#observer-urls a'));
    expect(links).toHaveLength(1);
    expect(links[0]?.protocol).toBe('https:');
    expect(links[0]?.rel).toBe('noreferrer');
  });

  it('contains no dynamic HTML parsing sink in the production browser client', () => {
    expect(OBSERVER_CLIENT_SCRIPT).not.toMatch(/\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/);
  });

  it('serves an external-only page under a strict browser policy', () => {
    const page = buildObserverPageResponse();
    const csp = page.headers['Content-Security-Policy'];

    expect(page.html).toContain('<link rel="stylesheet" href="/observer.css">');
    expect(page.html).toContain('<script src="/observer-client.js" defer></script>');
    expect(page.html).not.toMatch(/<script(?:\s|>)(?![^>]*\bsrc=)/i);
    expect(page.html).not.toContain('<style');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(page.headers).toMatchObject({
      'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
  });
});
