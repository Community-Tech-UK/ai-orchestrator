/**
 * Real-browser guard for the status dock's Escape focus contract (C13.12).
 *
 * The step-16 guard (`session-status-dock.rules.spec.ts`) runs in jsdom, which
 * blanks component stylesheets: it can pin the focus ladder's wiring but not
 * what a real browser does with the dock's CSS. That blind spot let a ladder
 * rung target the `display: contents` host, which Chromium cannot focus, so
 * closing a cold Review dropped keyboard focus to <body>. This guard closes it:
 * it compiles the real `session-status-dock.component.scss` (the same `sass`
 * compiler the Angular build uses), applies it in Chromium with native `:host`
 * semantics (a shadow root), and pins the browser half of the contract.
 *
 * Slow tier (`npm run test:slow` — CI's `test-slow` job and windows-pc), not the
 * default suite. Project automated headless tests may run locally, including
 * on macOS; manual browser work still belongs on windows-pc.
 * The guard is never skipped on any platform: a
 * missing browser fails with a remediation message, matching the SEA-build
 * guard's policy.
 *
 * What it pins (the wiring half stays in the jsdom guard):
 * - the compiled stylesheet really applies in Chromium (host `display: contents`,
 *   anchor an off-flow box);
 * - the pre-fix rung's exact shape — a `display: contents` element with
 *   `tabindex="-1"` — cannot hold keyboard focus in Chromium, which is why the
 *   ladder's last rung is `DOCK_FOCUS_ANCHOR_CLASS` (imported from the rules
 *   module by both this fixture and the component);
 * - the anchor holds keyboard focus with the real stylesheet;
 * - the ladder tail (composer, then anchor) lands on the anchor when the
 *   composer is disabled — never on <body>.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOCK_FOCUS_ANCHOR_CLASS } from './session-status-dock.rules';

const specDirectory = dirname(fileURLToPath(import.meta.url));

interface FocusProbe {
  hostDisplay: string;
  anchorPosition: string;
  /** The legacy rung's exact shape: `display: contents` plus tabindex="-1". */
  legacyHostHoldsFocus: boolean;
  anchorHoldsFocus: boolean;
  composerHoldsFocus: boolean;
  /** Which rung a `tryFocus` chain of the ladder tail ends on. */
  tailRung: 'composer' | 'anchor' | 'body';
}

/**
 * Chrome/Chromium (or Edge) for the guard. `AIO_E2E_BROWSER` overrides, the way
 * `AIO_SEA_NODE` overrides the SEA toolchain; otherwise the platform candidates
 * of `resolveChromeExecutablePath` in `src/worker-agent/capability-reporter.ts`
 * are listed again, so this guard keeps no dependency on the worker-agent graph.
 */
function resolveGuardBrowser(): string | null {
  const override = process.env['AIO_E2E_BROWSER']?.trim();
  if (override && existsSync(override)) {
    return override;
  }
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          ]
        : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium',
        ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * The dock host plus its always-rendered focus anchor and a disabled composer,
 * inside the same flex parent shape as `instance-detail.component.scss` (gap,
 * positioned, overflow hidden). The compiled stylesheet is installed in a
 * shadow root so `:host` applies with native browser semantics, exactly as a
 * real browser resolves it.
 */
function fixtureHtml(compiledCss: string): string {
  const safeCss = JSON.stringify(compiledCss).replace(/<\//g, '<\\/');
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><style>
  body { margin: 0; }
  .instance-detail { display: flex; flex-direction: column; gap: 10px; position: relative; overflow: hidden; height: 320px; }
  /* The pre-fix ladder rung's exact shape: display:contents plus tabindex="-1". */
  #legacy-host { display: contents; }
</style></head>
<body>
  <div class="instance-detail" id="detail">
    <button id="opener" type="button">outside control</button>
    <div id="legacy-host" tabindex="-1"></div>
    <app-session-status-dock id="dock"></app-session-status-dock>
    <app-input-panel><textarea id="composer" disabled></textarea></app-input-panel>
  </div>
  <script>
    const host = document.getElementById('dock');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<style>' + ${safeCss} + '</style>' +
      '<span class="${DOCK_FOCUS_ANCHOR_CLASS}" tabindex="-1"></span>';
  </script>
</body>
</html>`;
}

describe(
  'session-status-dock focus contract in a real browser (slow tier)',
  () => {
    let browser: import('puppeteer-core').Browser;
    let page: import('puppeteer-core').Page;

    beforeAll(async () => {
      const executablePath = resolveGuardBrowser();
      if (!executablePath) {
        throw new Error(
          'session-status-dock-focus.e2e.spec.ts needs a real Chrome/Chromium/Edge. ' +
            'Set AIO_E2E_BROWSER to the executable, or install Google Chrome. ' +
            'Run it through npm run test:slow with headless Chromium, including ' +
            'on macOS. AIO_E2E_BROWSER can select a different installed executable.',
        );
      }
      // Use the compiler owned by the declared Angular build toolchain, even
      // when npm nests @angular/build or Sass instead of hoisting them.
      const specRequire = createRequire(import.meta.url);
      const buildTools = createRequire(specRequire.resolve('@angular-devkit/build-angular/package.json'));
      const angularBuild = createRequire(buildTools.resolve('@angular/build/package.json'));
      const { compileString } = angularBuild('sass') as {
        compileString(source: string, options: { url: URL }): { css: string };
      };
      const scssPath = resolve(specDirectory, './session-status-dock.component.scss');
      const compiledCss = compileString(readFileSync(scssPath, 'utf8'), {
        url: pathToFileURL(scssPath),
      }).css;
      browser = await puppeteer.launch({
        executablePath,
        headless: true,
        dumpio: true,
        args: ['--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage'],
        defaultViewport: { width: 800, height: 320 },
      });
      const browserProcess = browser.process();
      browserProcess?.once('exit', (code, signal) => {
        process.stdout.write(`${JSON.stringify({ event: 'focus-browser-exit', code, signal })}\n`);
      });
      browserProcess?.once('error', (error) => {
        console.error('Focus guard browser process error', error);
      });
      process.stdout.write(`${JSON.stringify({
        event: 'focus-runtime',
        node: process.version,
        platform: process.platform,
        browser: await browser.version(),
      })}\n`);
      page = await browser.newPage();
      await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(fixtureHtml(compiledCss))}`, {
        waitUntil: 'domcontentloaded',
      });
    });

    afterAll(async () => {
      await browser?.close();
    });

    async function probe(): Promise<FocusProbe> {
      return page.evaluate(() => {
        // The anchor lives in the fixture host's shadow root (so the compiled
        // stylesheet's `:host` rule resolves natively); inside a shadow tree
        // `document.activeElement` reports the shadow host, so the deepest
        // actually-focused element must be chased through open shadow roots.
        const deepestActive = (): Element | null => {
          let node: Element | null = document.activeElement;
          while (node && node.shadowRoot && node.shadowRoot.activeElement) {
            node = node.shadowRoot.activeElement;
          }
          return node;
        };
        const host = document.getElementById('dock') as HTMLElement;
        const shadow = host.shadowRoot as ShadowRoot;
        const anchor = shadow.querySelector('[tabindex="-1"]') as HTMLElement;
        const legacyHost = document.getElementById('legacy-host') as HTMLElement;
        const composer = document.getElementById('composer') as HTMLTextAreaElement;
        const tryFocus = (target: HTMLElement): boolean => {
          target.focus();
          return deepestActive() === target;
        };
        (deepestActive() as HTMLElement | null)?.blur();
        legacyHost.focus();
        const legacyHostHoldsFocus = deepestActive() === legacyHost;
        (deepestActive() as HTMLElement | null)?.blur();
        const anchorHoldsFocus = tryFocus(anchor);
        (deepestActive() as HTMLElement | null)?.blur();
        const composerHoldsFocus = tryFocus(composer);
        const tailRung = composerHoldsFocus ? 'composer' : tryFocus(anchor) ? 'anchor' : 'body';
        return {
          hostDisplay: getComputedStyle(host).display,
          anchorPosition: getComputedStyle(anchor).position,
          legacyHostHoldsFocus,
          anchorHoldsFocus,
          composerHoldsFocus,
          tailRung: tailRung as 'composer' | 'anchor' | 'body',
        };
      });
    }

    it('really applies the compiled dock stylesheet: the host is display:contents and the anchor is an off-flow box', async () => {
      const result = await probe();
      expect(result.hostDisplay).toBe('contents');
      expect(result.anchorPosition).toBe('absolute');
    });

    it('cannot focus the pre-fix rung — a display:contents element with tabindex="-1" — why the ladder moved to the anchor', async () => {
      const result = await probe();
      expect(result.legacyHostHoldsFocus).toBe(false);
    });

    it('keeps keyboard focus on the focus anchor with the real stylesheet', async () => {
      const result = await probe();
      expect(result.anchorHoldsFocus).toBe(true);
    });

    it('lands the ladder tail on the anchor when the composer is disabled — never on <body>', async () => {
      const result = await probe();
      expect(result.composerHoldsFocus).toBe(false);
      expect(result.tailRung).toBe('anchor');
    });
  },
);
