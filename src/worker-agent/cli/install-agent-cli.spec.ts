import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerNodeHostReadiness } from '../../shared/types/worker-node.types';
import { parseInstallAgentArgs, runInstallAgent, runUninstallAgent } from './install-agent-cli';

describe('install-agent', () => {
  let tempDir: string;
  let configPath: string;
  let lines: string[];
  const stdout = (text: string): void => { lines.push(text.trimEnd()); };

  const readiness: WorkerNodeHostReadiness = {
    checkedAt: 1,
    checks: [
      { id: 'sleep_on_power', status: 'problem', summary: 'This Mac sleeps after 1 minute on power, so jobs stop.', fix: 'sudo pmset -c sleep 0', needsAdmin: true },
      { id: 'tailscale_running', status: 'problem', summary: 'Tailscale is not running.', fix: 'Open Tailscale and sign in.', needsAdmin: false },
      { id: 'filevault', status: 'note', summary: 'FileVault is on, so after a restart someone must log in on this Mac before the worker starts.', needsAdmin: false },
      { id: 'remote_login_access', status: 'ok', summary: 'Remote Login allows this account.', needsAdmin: false },
    ],
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-install-agent-'));
    configPath = path.join(tempDir, '.orchestrator', 'worker-node.json');
    lines = [];
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function deps(overrides: Record<string, unknown> = {}) {
    return {
      stdout,
      platform: 'darwin' as NodeJS.Platform,
      uid: 501,
      homedir: tempDir,
      launchctl: vi.fn(async () => ({ code: 0, output: '' })),
      setUpBrowser: vi.fn(() => ['Browser features turned on (Chrome found).']),
      checkHost: vi.fn(async () => readiness),
      openTailscale: vi.fn(async () => ({ ok: true, message: 'Opened Tailscale. Sign in there if it asks.' })),
      sleep: async () => undefined,
      ...overrides,
    };
  }

  it('writes and loads a per-user LaunchAgent, names the computer and sets up the browser', async () => {
    const d = deps();

    const code = await runInstallAgent({ configPath, name: 'ct-test-mac', browser: true }, d);

    expect(code).toBe(0);
    const plistPath = path.join(tempDir, 'Library', 'LaunchAgents', 'com.aiorchestrator.worker.user.plist');
    const plist = fs.readFileSync(plistPath, 'utf-8');
    expect(plist).toContain('<string>--supervise</string>');
    expect(plist).toContain(`<string>${configPath}</string>`);
    expect(plist).toContain('<string>Aqua</string>');
    expect(plist).toContain(path.join(tempDir, '.orchestrator', 'logs', 'launchagent.err.log'));
    expect(d.launchctl.mock.calls).toEqual([
      [['bootout', 'gui/501/com.aiorchestrator.worker.user']],
      [['bootstrap', 'gui/501', plistPath]],
    ]);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).name).toBe('ct-test-mac');
    expect(d.setUpBrowser).toHaveBeenCalledWith(configPath);
    expect(lines.join('\n')).toContain('waiting to be paired');
  });

  it('opens Tailscale itself and lists the steps that need James', async () => {
    const d = deps();

    await runInstallAgent({ configPath, browser: false }, d);

    const out = lines.join('\n');
    expect(d.setUpBrowser).not.toHaveBeenCalled();
    expect(d.openTailscale).toHaveBeenCalled();
    expect(out).toContain('Opened Tailscale');
    expect(out).not.toContain('Tailscale is not running');
    expect(out).toContain('sudo pmset -c sleep 0 (needs an admin password)');
    expect(out).toContain('FileVault is on');
    expect(out).not.toContain('Remote Login allows');
  });

  it('retries a bootstrap that races the boot-out', async () => {
    let bootstraps = 0;
    const launchctl = vi.fn(async (args: string[]) => {
      if (args[0] !== 'bootstrap') return { code: 0, output: '' };
      bootstraps++;
      return bootstraps < 2 ? { code: 5, output: 'Bootstrap failed: 5: Input/output error' } : { code: 0, output: '' };
    });

    const code = await runInstallAgent({ configPath, browser: false }, deps({ launchctl }));

    expect(code).toBe(0);
    expect(bootstraps).toBe(2);
  });

  it('says someone must log in when there is no logged-in session to start the agent in', async () => {
    const launchctl = vi.fn(async (args: string[]) => (args[0] === 'bootout'
      ? { code: 3, output: 'Boot-out failed: 3: No such process' }
      : { code: 125, output: 'Bootstrap failed: 125: Domain does not support specified action' }));

    const code = await runInstallAgent({ configPath, browser: false }, deps({ launchctl }));

    expect(code).toBe(1);
    expect(launchctl.mock.calls.filter(([args]) => args[0] === 'bootstrap')).toHaveLength(4);
    expect(lines.join('\n')).toContain('Nobody is logged in');
  });

  it('refuses outside macOS and under sudo', async () => {
    expect(await runInstallAgent({ configPath, browser: true }, deps({ platform: 'win32' }))).toBe(1);
    expect(await runInstallAgent({ configPath, browser: true }, deps({ uid: 0 }))).toBe(1);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('uninstalls by stopping the agent and removing its file', async () => {
    const d = deps();
    await runInstallAgent({ configPath, browser: false }, d);

    await runUninstallAgent(d);

    expect(fs.existsSync(path.join(tempDir, 'Library', 'LaunchAgents', 'com.aiorchestrator.worker.user.plist'))).toBe(false);
    expect(d.launchctl).toHaveBeenLastCalledWith(['bootout', 'gui/501/com.aiorchestrator.worker.user']);
  });

  it('parses its options', () => {
    expect(parseInstallAgentArgs(['--name', 'ct-test-mac', '--no-browser'])).toEqual({ name: 'ct-test-mac', browser: false });
    expect(() => parseInstallAgentArgs(['--bogus'])).toThrow(/Unknown install-agent option/);
    expect(() => parseInstallAgentArgs(['--name'])).toThrow(/requires a value/);
  });
});
