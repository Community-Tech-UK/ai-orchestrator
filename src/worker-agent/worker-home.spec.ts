import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureExtensionRelayDefaults, loadWorkerConfig } from './worker-config';
import { WorkerBrowserManager } from './worker-browser-manager';
import { resolveWorkerHome, workerProviderStateRoot, workerRelayHostName, workerRelaySocketPath } from './worker-home';

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach(folder => fs.rmSync(folder, { recursive: true, force: true })));
function checkout(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-home-'));
  folders.push(dir);
  return dir;
}
describe('worker home', () => {
  it('keeps existing installs in the user home', () => {
    expect(resolveWorkerHome(checkout())).toBe(path.join(os.homedir(), '.orchestrator'));
  });
  it('reads the checkout marker independent of the current directory', () => {
    const dir = checkout();
    const home = path.join(dir, 'separate worker');
    fs.writeFileSync(path.join(dir, '.aio-worker-home'), home + '\n');
    expect(resolveWorkerHome(dir)).toBe(home);
  });
  it('refuses an empty or relative installed path', () => {
    const dir = checkout();
    for (const value of ['', 'relative-home']) {
      fs.writeFileSync(path.join(dir, '.aio-worker-home'), value);
      expect(() => resolveWorkerHome(dir)).toThrow(/absolute/);
    }
  });
  it('keeps legacy relay registration enabled for the default installation', () => {
    expect(ensureExtensionRelayDefaults({ enabled: true }, () => 'placeholder-socket')?.legacyNameRegistration).toBe(true);
  });
  it('derives config-owned transfer, relay and managed-browser paths from the worker home', () => {
    const home = checkout();
    const configPath = path.join(home, 'worker-node.json');
    fs.writeFileSync(configPath, JSON.stringify({ extensionRelay: { enabled: true } }));
    const config = loadWorkerConfig(configPath);
    expect(config.extensionRelay?.socketPath).toBe(workerRelaySocketPath(home));
    expect(config.fileTransfer?.roots?.find(root => root.id === 'scratch')?.path).toBe(path.join(home, '_scratch', 'aio-transfers'));
    const browser = new WorkerBrowserManager({ config: { enabled: false }, homeDir: home });
    expect(browser.getSummary().profileDir).toBe(path.join(home, 'browser-automation-profile'));
  });
  it('separates browser relay names and Windows pipes while sharing provider sign-ins', () => {
    const first = path.join(os.homedir(), '.orchestrator');
    const second = path.join(os.homedir(), '.orchestrator-home-base');
    expect(workerRelayHostName(first)).toBe('com.ai_orchestrator.browser_gateway_relay');
    expect(workerRelayHostName(second)).toBe('com.ai_orchestrator.browser_gateway_relay_home_base');
    expect(workerRelaySocketPath(first, 'win32')).not.toBe(workerRelaySocketPath(second, 'win32'));
    expect(workerProviderStateRoot(second, false)).toBe(first);
    expect(workerProviderStateRoot('/service', true)).toBe('/service');
  });
});
