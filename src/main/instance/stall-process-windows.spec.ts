import { describe, expect, it, vi } from 'vitest';
import { sampleStallProcessFacts, sanitizeProcessLabel } from './stall-process-facts';

const row = (pid: number, ppid: number, cpuSeconds: number, runningSeconds: number, command: string) => ({
  pid, ppid, cpuSeconds, runningSeconds, rssMb: 2, command,
});

describe('Windows stall process observations', () => {
  it('measures CPU and finds a child through Windows shell wrappers without keeping command flags', async () => {
    let time = 1000;
    const table = (cpu: number) => JSON.stringify([
      row(100, 1, cpu, 600, 'C:\\tools\\claude.exe'),
      row(101, 100, 0, 40, 'C:\\Windows\\System32\\cmd.exe /c npm test'),
      row(102, 101, 0, 39, '"C:\\Program Files\\nodejs\\node.exe" C:\\repo\\vitest.mjs run --token TOKEN_PLACEHOLDER'),
      row(103, 100, 0, 500, 'node.exe tool-server.mjs'),
    ]);
    const runWindowsProcessTable = vi.fn().mockResolvedValueOnce(table(1)).mockResolvedValueOnce(table(2.5));
    const runPs = vi.fn();
    const facts = await sampleStallProcessFacts(100, {
      platform: 'win32', silenceMs: 70_000, runPs, runWindowsProcessTable,
      sleep: async () => { time += 1500; }, now: () => time,
    });
    expect(facts).toEqual({ pid: 100, state: 'unknown', cpuPercent: 100, rssMb: 2, sampledAt: 2500,
      child: { label: 'vitest run', runningSeconds: 39, cpuPercent: 0 } });
    expect(runPs).not.toHaveBeenCalled();
    expect(JSON.stringify(facts)).not.toContain('TOKEN_PLACEHOLDER');
  });

  it.each(['powershell.exe', 'pwsh.exe', 'cmd.exe'])('does not expose %s scripts', program => {
    expect(sanitizeProcessLabel(`${program} /c PRIVATE_VALUE_PLACEHOLDER`)).toBe('a shell command');
  });

  it.each(['not json', '{}', '[{"pid":100}]'])('rejects malformed process data: %s', async table => {
    expect(await sampleStallProcessFacts(100, {
      platform: 'win32', silenceMs: 70_000, runWindowsProcessTable: async () => table,
      sleep: async () => undefined,
    })).toBeNull();
  });

  it('handles the single-object JSON returned for one Windows process', async () => {
    const table = JSON.stringify(row(100, 1, 0, 100, 'claude.exe'));
    let time = 1000;
    expect(await sampleStallProcessFacts(100, { platform: 'win32', silenceMs: 70_000,
      runWindowsProcessTable: async () => table, sleep: async () => { time += 1500; }, now: () => time,
    })).toMatchObject({ pid: 100, cpuPercent: 0, state: 'unknown', child: null });
  });

  it.skipIf(process.platform !== 'win32')('observes a real Windows process without signalling it', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true });
    await once(child, 'spawn');
    try {
      const facts = await sampleStallProcessFacts(child.pid ?? null, { silenceMs: 70_000 });
      expect(facts).toMatchObject({ pid: child.pid, state: 'unknown', child: null });
      expect(facts?.cpuPercent).toBeGreaterThanOrEqual(0);
      expect(child.exitCode).toBeNull();
    } finally { child.kill(); }
  }, 10_000);
});
import { spawn } from 'node:child_process';
import { once } from 'node:events';
