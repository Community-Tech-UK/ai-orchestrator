import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import {
  buildHiddenLauncherScript,
  buildRegisterTaskScript,
  psQuote,
  readablePowerShellError,
  WorkerSignInTask,
} from './worker-sign-in-task';

describe('WorkerSignInTask', () => {
  let tmp: string;
  let bundleDir: string;
  let bundledExe: string;
  let localAppData: string;
  let scripts: string[];
  let taskState: 'absent' | 'enabled' | 'disabled';

  function makeTask(platform: NodeJS.Platform = 'win32'): WorkerSignInTask {
    return new WorkerSignInTask({
      platform,
      localAppData,
      resolveBundledWorker: () => bundledExe,
      runPowerShell: async (script) => {
        scripts.push(script);
        if (script.includes('Get-ScheduledTask @task')) {
          return `${taskState}\r\n`;
        }
        if (script.includes('Register-ScheduledTask')) {
          taskState = 'enabled';
        }
        if (script.includes('Unregister-ScheduledTask')) {
          taskState = 'absent';
        }
        return '';
      },
    });
  }

  function writeBundle(contents: string, mtime: Date): void {
    fs.writeFileSync(bundledExe, contents);
    // The packaged folder also ships an identical second executable.
    fs.writeFileSync(path.join(bundleDir, 'worker-agent.exe'), contents);
    fs.writeFileSync(path.join(bundleDir, 'worker-tools', 'tool.txt'), contents);
    fs.utimesSync(bundledExe, mtime, mtime);
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-in-task-'));
    bundleDir = path.join(tmp, 'resources', 'worker-agent-cli');
    fs.mkdirSync(path.join(bundleDir, 'worker-tools'), { recursive: true });
    bundledExe = path.join(bundleDir, 'aio-worker.exe');
    writeBundle('build-one', new Date('2026-10-01T00:00:00Z'));
    localAppData = path.join(tmp, 'LocalAppData');
    scripts = [];
    taskState = 'absent';
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('is Windows-only and refuses to install elsewhere', async () => {
    const task = makeTask('darwin');

    expect(task.isSupported()).toBe(false);
    await expect(task.install('/c.json')).rejects.toThrow(/only available on Windows/);
    await expect(task.stop()).resolves.toBeUndefined();
    expect(scripts).toEqual([]);
  });

  it('installs a private copy, a hidden launcher and a started task', async () => {
    const task = makeTask();

    await task.install('C:/Users/james/.orchestrator/worker-node.json');

    const { versionsDir, launcherPath, deploymentPath } = task.paths();
    const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8')) as { buildId: string; exePath: string };
    expect(deployment.exePath).toBe(path.join(versionsDir, deployment.buildId, 'aio-worker.exe'));
    expect(fs.readFileSync(deployment.exePath, 'utf8')).toBe('build-one');
    expect(fs.existsSync(path.join(versionsDir, deployment.buildId, 'worker-tools', 'tool.txt'))).toBe(true);
    expect(fs.existsSync(path.join(versionsDir, deployment.buildId, 'worker-agent.exe'))).toBe(false);

    const launcher = fs.readFileSync(launcherPath);
    expect([...launcher.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    const launcherText = launcher.subarray(2).toString('utf16le');
    expect(launcherText).toContain(deployment.exePath);
    expect(launcherText).toContain('--supervise');
    expect(launcherText).toContain('shell.Run(command, 0, True)');

    // Read the task, pause it, end old copies, register, then enable and start.
    expect(scripts[0]).toContain('Get-ScheduledTask');
    expect(scripts[1]).toContain('Disable-ScheduledTask');
    expect(scripts[2]).toContain('taskkill.exe');
    expect(scripts.some((s) => s.includes('Register-ScheduledTask'))).toBe(true);
    expect(scripts.at(-1)).toContain('Start-ScheduledTask');
    expect(scripts.at(-1)).toContain('Enable-ScheduledTask');
  });

  it('pause disables the task and ends the worker; resume enables and starts', async () => {
    const task = makeTask();

    await task.stop();
    expect(scripts[0]).toContain('Disable-ScheduledTask');
    expect(scripts[1]).toContain('taskkill.exe');
    expect(scripts[1]).toContain('/T /F');
    expect(scripts[1]).toContain(psQuote(`${task.paths().versionsDir}${path.sep}`));

    scripts = [];
    await task.start();
    expect(scripts[0]).toContain('Enable-ScheduledTask');
    expect(scripts[0]).toContain('Start-ScheduledTask');
  });

  it('leaves an up-to-date task alone at launch', async () => {
    const task = makeTask();
    await task.install('/c.json');
    scripts = [];

    await expect(task.ensureCurrent('/c.json')).resolves.toBe(false);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('Get-ScheduledTask');
  });

  it('moves the task onto a new Harness build and prunes the old copy', async () => {
    const task = makeTask();
    await task.install('/c.json');
    const { versionsDir, deploymentPath } = task.paths();
    const oldBuild = (JSON.parse(fs.readFileSync(deploymentPath, 'utf8')) as { buildId: string }).buildId;

    writeBundle('build-two-bigger', new Date('2026-10-20T00:00:00Z'));
    scripts = [];
    await expect(task.ensureCurrent('/c.json')).resolves.toBe(true);

    const newBuild = (JSON.parse(fs.readFileSync(deploymentPath, 'utf8')) as { buildId: string }).buildId;
    expect(newBuild).not.toBe(oldBuild);
    expect(fs.readdirSync(versionsDir)).toEqual([newBuild]);
    expect(scripts.some((s) => s.includes('taskkill.exe'))).toBe(true);
    expect(scripts.at(-1)).toContain('Start-ScheduledTask');
  });

  it('keeps a paused worker paused when it updates it', async () => {
    const task = makeTask();
    await task.install('/c.json');
    writeBundle('build-two-bigger', new Date('2026-10-20T00:00:00Z'));
    taskState = 'disabled';
    scripts = [];

    await task.ensureCurrent('/c.json');

    // Registration re-enables a task, so it must be disabled again, not started.
    const afterRegister = scripts.slice(scripts.findIndex((s) => s.includes('Register-ScheduledTask')) + 1);
    expect(afterRegister.some((s) => s.includes('Disable-ScheduledTask'))).toBe(true);
    expect(afterRegister.some((s) => s.includes('Start-ScheduledTask'))).toBe(false);
  });

  it('restores a deleted task at launch', async () => {
    const task = makeTask();
    await task.install('/c.json');
    taskState = 'absent';
    scripts = [];

    await expect(task.ensureCurrent('/c.json')).resolves.toBe(true);
    expect(scripts.some((s) => s.includes('Register-ScheduledTask'))).toBe(true);
    expect(scripts.at(-1)).toContain('Start-ScheduledTask');
  });

  it('remove unregisters the task, ends the worker and deletes the copies', async () => {
    const task = makeTask();
    await task.install('/c.json');
    scripts = [];

    await task.remove();

    expect(scripts[0]).toContain('Unregister-ScheduledTask');
    expect(scripts[1]).toContain('taskkill.exe');
    expect(fs.readdirSync(task.paths().versionsDir)).toEqual([]);
  });

  it('ends every script with exit 0 so a swallowed "not found" is not a failure', async () => {
    const task = makeTask();
    await task.install('/c.json');
    await task.stop();
    await task.remove();
    await task.ensureCurrent('/c.json');

    expect(scripts.length).toBeGreaterThan(5);
    for (const script of scripts) {
      expect(script.trimEnd().endsWith('exit 0')).toBe(true);
    }
  });

  it('redeploys when the deployed copy or launcher has gone missing', async () => {
    const task = makeTask();
    await task.install('/c.json');
    fs.rmSync(task.paths().launcherPath);
    scripts = [];

    await expect(task.ensureCurrent('/c.json')).resolves.toBe(true);
    expect(fs.existsSync(task.paths().launcherPath)).toBe(true);
  });

  it('runs task actions one at a time, so a Stop is not undone by a launch update', async () => {
    const order: string[] = [];
    let releaseRegister: () => void = () => undefined;
    const task = new WorkerSignInTask({
      platform: 'win32',
      localAppData,
      resolveBundledWorker: () => bundledExe,
      runPowerShell: async (script) => {
        if (script.includes('Get-ScheduledTask @task')) {
          return 'absent';
        }
        if (script.includes('Register-ScheduledTask')) {
          order.push('register');
          await new Promise<void>((resolve) => { releaseRegister = resolve; });
        } else if (script.includes('Start-ScheduledTask') && !script.includes('Stop-ScheduledTask')) {
          order.push('start');
        } else if (script.includes('Disable-ScheduledTask') && script.includes('Stop-ScheduledTask')) {
          order.push('disable');
        }
        return '';
      },
    });

    const update = task.ensureCurrent('/c.json');
    await vi.waitFor(() => expect(order).toContain('register'));
    const stop = task.stop();
    await Promise.resolve();
    expect(order.at(-1)).toBe('register');
    releaseRegister();
    await Promise.all([update, stop]);

    // The user's Stop lands after the update finished starting the task.
    expect(order.slice(order.indexOf('register'))).toEqual(['register', 'start', 'disable']);
  });

  it('prepares the new copy before touching the running worker', async () => {
    const task = makeTask();
    await task.install('/c.json');
    writeBundle('build-two-bigger', new Date('2026-10-20T00:00:00Z'));
    let copyExistedWhenPaused = false;
    const updater = new WorkerSignInTask({
      platform: 'win32',
      localAppData,
      resolveBundledWorker: () => bundledExe,
      runPowerShell: async (script) => {
        if (script.includes('Get-ScheduledTask @task')) {
          return 'enabled';
        }
        if (script.includes('Disable-ScheduledTask') && !copyExistedWhenPaused) {
          copyExistedWhenPaused = fs.readdirSync(updater.paths().versionsDir).length === 2;
        }
        return '';
      },
    });

    await updater.ensureCurrent('/c.json');

    expect(copyExistedWhenPaused).toBe(true);
  });

  it('re-enables a running task when the switch-over fails, and retries next launch', async () => {
    const task = makeTask();
    await task.install('/c.json');
    const { deploymentPath } = task.paths();
    const oldRecord = fs.readFileSync(deploymentPath, 'utf8');
    writeBundle('build-two-bigger', new Date('2026-10-20T00:00:00Z'));
    const seen: string[] = [];
    const failing = new WorkerSignInTask({
      platform: 'win32',
      localAppData,
      resolveBundledWorker: () => bundledExe,
      runPowerShell: async (script) => {
        seen.push(script);
        if (script.includes('Get-ScheduledTask @task')) {
          return 'enabled';
        }
        if (script.includes('Register-ScheduledTask')) {
          throw new Error('Windows task setup failed: Access is denied.');
        }
        return '';
      },
    });

    await expect(failing.ensureCurrent('/c.json')).rejects.toThrow(/Access is denied/);

    expect(seen.at(-1)).toContain('Enable-ScheduledTask');
    expect(seen.at(-1)).toContain('Start-ScheduledTask');
    // The record still names the old build, so the next launch tries again.
    expect(fs.readFileSync(deploymentPath, 'utf8')).toBe(oldRecord);
  });

  it('recovers a task left disabled by an interrupted switch-over, not mistaking it for a pause', async () => {
    const task = makeTask();
    await task.install('/c.json');
    // Harness quit after pausing the task but before the switch-over ended.
    fs.writeFileSync(task.paths().switchingMarkerPath, 'x');
    taskState = 'disabled';
    scripts = [];

    await expect(task.ensureCurrent('/c.json')).resolves.toBe(true);

    expect(scripts.at(-1)).toContain('Start-ScheduledTask');
    // Not re-paused: the "keep it paused" step is a bare Disable just before exit.
    expect(scripts.some((script) => script.includes('Disable-ScheduledTask @task | Out-Null\nexit 0'))).toBe(false);
    expect(fs.existsSync(task.paths().switchingMarkerPath)).toBe(false);
  });

  it('marks the switch-over while the task is paused for it, and clears the mark after', async () => {
    const task = makeTask();
    await task.install('/c.json');
    writeBundle('build-two-bigger', new Date('2026-10-20T00:00:00Z'));
    let markedWhilePaused = false;
    const updater = new WorkerSignInTask({
      platform: 'win32',
      localAppData,
      resolveBundledWorker: () => bundledExe,
      runPowerShell: async (script) => {
        if (script.includes('Get-ScheduledTask @task')) {
          return 'enabled';
        }
        if (script.includes('try { Disable-ScheduledTask')) {
          markedWhilePaused = fs.existsSync(updater.paths().switchingMarkerPath);
        }
        return '';
      },
    });

    await updater.ensureCurrent('/c.json');

    expect(markedWhilePaused).toBe(true);
    expect(fs.existsSync(updater.paths().switchingMarkerPath)).toBe(false);
  });

  it('lets a Stop override a switching marker left by a crash', async () => {
    const task = makeTask();
    await task.install('/c.json');
    fs.writeFileSync(task.paths().switchingMarkerPath, 'x');

    await task.stop();
    taskState = 'disabled';
    scripts = [];

    expect(fs.existsSync(task.paths().switchingMarkerPath)).toBe(false);
    await expect(task.ensureCurrent('/c.json')).resolves.toBe(false);
    expect(scripts.some((script) => script.includes('Start-ScheduledTask'))).toBe(false);
  });

  it('fails a Stop rather than leave a marker that would undo it, but not a Start', async () => {
    const task = makeTask();
    await task.install('/c.json');
    // A non-empty directory where the marker file goes cannot be removed by rm.
    fs.mkdirSync(path.join(task.paths().switchingMarkerPath, 'held'), { recursive: true });
    scripts = [];

    await expect(task.stop()).rejects.toThrow();
    expect(scripts.some((script) => script.includes('Disable-ScheduledTask'))).toBe(false);

    await expect(task.start()).resolves.toBeUndefined();
  });

  it('keeps a genuinely paused task paused (no switching marker)', async () => {
    const task = makeTask();
    await task.install('/c.json');
    taskState = 'disabled';
    scripts = [];

    await expect(task.ensureCurrent('/c.json')).resolves.toBe(false);
    expect(scripts.some((script) => script.includes('Start-ScheduledTask'))).toBe(false);
  });

  it('does not re-enable a paused task when the switch-over fails', async () => {
    const seen: string[] = [];
    const failing = new WorkerSignInTask({
      platform: 'win32',
      localAppData,
      resolveBundledWorker: () => bundledExe,
      runPowerShell: async (script) => {
        seen.push(script);
        if (script.includes('Get-ScheduledTask @task')) {
          return 'disabled';
        }
        if (script.includes('Register-ScheduledTask')) {
          throw new Error('Windows task setup failed: Access is denied.');
        }
        return '';
      },
    });

    await expect(failing.ensureCurrent('/c.json')).rejects.toThrow(/Access is denied/);
    expect(seen.some((script) => script.includes('Enable-ScheduledTask'))).toBe(false);
  });

  it('treats only a missing task as absent and clears stale worker locks after a kill', async () => {
    const task = makeTask();
    await task.stop();
    await task.getTaskState();

    const stateScript = scripts.find((script) => script.includes('Get-ScheduledTask @task'))!;
    expect(stateScript).toContain("'ObjectNotFound'");
    const killScript = scripts.find((script) => script.includes('taskkill.exe'))!;
    expect(killScript).toContain("'orchestrator-worker-*.lock'");
    expect(killScript).toContain('Remove-Item');
  });

  it('surfaces a PowerShell failure from install', async () => {
    const task = new WorkerSignInTask({
      platform: 'win32',
      localAppData,
      resolveBundledWorker: () => bundledExe,
      runPowerShell: async (script) => {
        if (script.includes('Register-ScheduledTask')) {
          throw new Error('Windows task setup failed: Access is denied.');
        }
        return '';
      },
    });

    await expect(task.install('/c.json')).rejects.toThrow(/Access is denied/);
  });
});

describe('sign-in task scripts', () => {
  it('quotes PowerShell literals', () => {
    expect(psQuote("C:\\Users\\O'Brien\\x")).toBe("'C:\\Users\\O''Brien\\x'");
  });

  it('quotes paths in the VBScript launcher', () => {
    const script = buildHiddenLauncherScript('C:\\Odd "Name"\\aio-worker.exe', 'C:\\cfg.json');
    expect(script).toContain('"C:\\Odd ""Name""\\aio-worker.exe"');
    expect(script).toContain('WScript.Quit shell.Run(command, 0, True)');
  });

  it('registers a per-user, non-elevated task with logon and keep-alive triggers', () => {
    const script = buildRegisterTaskScript("C:\\Users\\O'Brien\\run.vbs", 'C:\\Users\\x');

    expect(script).toContain('-AtLogOn -User $userId');
    expect(script).toContain('-RepetitionInterval (New-TimeSpan -Minutes 5)');
    expect(script).toContain('-MultipleInstances IgnoreNew');
    expect(script).toContain('-LogonType Interactive -RunLevel Limited');
    expect(script).toContain("'C:\\Users\\O''Brien\\run.vbs'");
    expect(script).not.toMatch(/RunLevel Highest/);
  });

  it('doubles typographic single quotes too', () => {
    expect(psQuote('C:\\Users\\O\u2019Brien')).toBe("'C:\\Users\\O\u2019\u2019Brien'");
  });

  it('turns CLIXML error output into readable text', () => {
    const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">Access is denied._x000D__x000A_</S><S S="Error">At line:3 char:1_x000D__x000A_</S></Objs>';

    expect(readablePowerShellError(clixml)).toBe('Access is denied.\nAt line:3 char:1');
    expect(readablePowerShellError('  plain failure  ')).toBe('plain failure');
  });
});

