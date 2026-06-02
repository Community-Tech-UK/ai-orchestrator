import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('browser extension assets', () => {
  it('ships a live authenticated-tab bridge with command polling and page access', () => {
    const background = readFileSync('resources/browser-extension/background.js', 'utf-8');
    const manifest = JSON.parse(
      readFileSync('resources/browser-extension/manifest.json', 'utf-8'),
    ) as { permissions?: string[]; host_permissions?: string[] };
    const popup = readFileSync('resources/browser-extension/popup.js', 'utf-8');

    expect(popup).toContain("addEventListener('click'");
    expect(background).toContain("type: 'attach_tab'");
    expect(background).toContain('chrome.runtime.connectNative(HOST_NAME)');
    expect(background).toContain('chrome.runtime.lastError?.message');
    expect(background).toContain('chrome.tabs.onUpdated');
    expect(background).toContain('chrome.tabs.onRemoved');
    expect(background).toContain("type: 'tab_inventory'");
    expect(background).toContain("type: 'poll_command'");
    expect(background).toContain("type: 'command_result'");
    expect(background).toContain('executeBrowserCommand');
    expect(background).toContain('findActiveWebTabForSharing');
    expect(background).toContain('lastFocusedWindow: true');
    expect(background).toContain('chrome.tabs.query({})');
    expect(manifest.permissions).toContain('alarms');
    expect(manifest.permissions).toContain('tabGroups');
    expect(manifest.host_permissions).toEqual(['http://*/*', 'https://*/*']);
  });

  it('marks actively controlled tabs with a blue group and page glow', () => {
    const background = readFileSync('resources/browser-extension/background.js', 'utf-8');

    expect(background).toContain('AI Orchestrator');
    expect(background).toContain('chrome.tabs.group');
    expect(background).toContain('chrome.tabGroups.update');
    expect(background).toContain("color: 'blue'");
    expect(background).toContain('installControlGlowScript');
    expect(background).toContain('removeControlGlowScript');
    expect(background).toContain('aio-browser-control-glow');
  });

  it('uses open-shadow traversal for snapshots and selector actions', () => {
    const background = readFileSync('resources/browser-extension/background.js', 'utf-8');

    expect(background).toContain('function deepQuerySelector');
    expect(background).toContain('function collectVisibleText');
    expect(background).toContain('node.shadowRoot');
    expect(background).toContain('const element = deepQuerySelector(selector)');
    expect(background).toContain('text: collectVisibleText().slice(0, 120000)');
  });

  it('captures screenshots over the DevTools protocol instead of the focused visible tab', () => {
    const background = readFileSync('resources/browser-extension/background.js', 'utf-8');

    expect(background).toContain('captureTabScreenshot');
    expect(background).toContain("'Page.captureScreenshot'");
    // The focus-dependent path must be gone.
    expect(background).not.toContain('captureVisibleTab');
    expect(background).not.toContain('async function focusTab');
    // Downscaled JPEG by default to stay within the inline token budget (#6).
    expect(background).toContain('SCREENSHOT_DEFAULT_MAX_WIDTH');
    expect(background).toContain("format === 'png' ? 'png' : 'jpeg'");
  });

  it('drives real pointer/mouse input and the native value setter', () => {
    const background = readFileSync('resources/browser-extension/background.js', 'utf-8');

    expect(background).toContain('function dispatchRealClick');
    expect(background).toContain("'pointerdown'");
    expect(background).toContain("'mousedown'");
    expect(background).toContain("'mouseup'");
    // Synthetic element.click() must no longer be the click mechanism.
    expect(background).not.toContain('element.click();');
    expect(background).toContain('function setNativeValue');
    expect(background).toContain("Object.getOwnPropertyDescriptor(prototype, 'value')");
  });

  it('runs selector actions across all frames and fails on no-match', () => {
    const background = readFileSync('resources/browser-extension/background.js', 'utf-8');

    expect(background).toContain('allFrames: true');
    expect(background).toContain('function mergeFrameResults');
    expect(background).toContain('waitForSelectorAcrossFrames');
    // Missing selectors surface as command failures (#10) rather than silent success.
    expect(background).toContain('No element matches selector:');
    expect(background).toContain('__found');
  });

  it('supports custom (non-native) select dropdowns', () => {
    const background = readFileSync('resources/browser-extension/background.js', 'utf-8');

    expect(background).toContain('function selectValue');
    expect(background).toContain('function findOptionByText');
    expect(background).toContain("element.tagName === 'SELECT'");
    expect(background).toContain('custom_select_option_not_found');
  });

  it('buffers native-host messages and backs off reconnects', () => {
    const background = readFileSync('resources/browser-extension/background.js', 'utf-8');

    expect(background).toContain('function enqueueOutbox');
    expect(background).toContain('function flushOutbox');
    expect(background).toContain('function scheduleReconnect');
    expect(background).toContain('RECONNECT_MAX_MS');
    expect(background).toContain("message?.type === 'poll_command'");
  });

  it('pierces closed shadow roots via a MAIN-world document_start content script', () => {
    const manifest = JSON.parse(
      readFileSync('resources/browser-extension/manifest.json', 'utf-8'),
    ) as { content_scripts?: Record<string, unknown>[] };
    const openShadow = readFileSync('resources/browser-extension/open-shadow-roots.js', 'utf-8');

    const contentScript = manifest.content_scripts?.[0];
    expect(contentScript).toMatchObject({
      js: ['open-shadow-roots.js'],
      run_at: 'document_start',
      all_frames: true,
      world: 'MAIN',
    });
    expect(openShadow).toContain('attachShadow');
    expect(openShadow).toContain("mode: 'open'");
  });

  it('shows a dev-only extension reload action in the popup', () => {
    const popupHtml = readFileSync('resources/browser-extension/popup.html', 'utf-8');
    const popup = readFileSync('resources/browser-extension/popup.js', 'utf-8');

    expect(popupHtml).toContain('id="reload"');
    expect(popupHtml).toContain('Reload Extension');
    expect(popup).toContain('isDevExtension');
    expect(popup).toContain('getManifest().update_url');
    expect(popup).toContain('chrome.runtime.reload()');
  });
});
