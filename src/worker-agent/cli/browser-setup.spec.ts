import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setUpBrowserFeatures } from './browser-setup';

describe('setUpBrowserFeatures', () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-browser-setup-'));
    configPath = path.join(tempDir, 'worker-node.json');
    fs.writeFileSync(configPath, JSON.stringify({ nodeId: 'node-1', name: 'ct-test-mac' }));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function persisted(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  }

  it('turns on a visible browser and the extension link when Chrome is installed', () => {
    const installRelay = vi.fn(() => ({ manifestPath: '/tmp/manifest.json' }));

    const lines = setUpBrowserFeatures(configPath, {
      resolveChromePath: () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      installRelay,
    });

    expect(persisted()['browserAutomation']).toEqual({ enabled: true, headless: false });
    expect(installRelay).toHaveBeenCalledWith(configPath);
    expect(lines[0]).toContain('Browser features turned on');
    expect(lines.join('\n')).toMatch(/Load (unpacked|the Chrome extension)/);
  });

  it('leaves everything off when Chrome is not installed', () => {
    const installRelay = vi.fn();

    const lines = setUpBrowserFeatures(configPath, { resolveChromePath: () => null, installRelay });

    expect(persisted()['browserAutomation']).toBeUndefined();
    expect(installRelay).not.toHaveBeenCalled();
    expect(lines).toEqual(['Chrome is not installed here, so browser features stay off.']);
  });

  it('keeps browser automation on and says how to finish when the extension link cannot be set up', () => {
    const lines = setUpBrowserFeatures(configPath, {
      resolveChromePath: () => 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      installRelay: () => { throw new Error('Another program owns the native host.'); },
    });

    expect(persisted()['browserAutomation']).toEqual({ enabled: true, headless: false });
    expect(lines.join('\n')).toContain('aio-worker install-browser-extension --force');
  });
});
