import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { requestJson, runMonitorCheck } = require('./monitor.js') as {
  requestJson(url: URL, options?: { token?: string; timeoutMs?: number }): Promise<unknown>;
  runMonitorCheck(configPath: string, deps: {
    fetchJobs: () => Promise<unknown>; probePeer: () => Promise<boolean>;
    notify: (alert: { id: string; subject: string; text: string }) => Promise<void>; now: () => number;
  }): Promise<{ pending: number; notified: number; gatewayReachable: boolean }>;
};
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function config(): { file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'aio-home-monitor-'));
  directories.push(dir);
  const file = join(dir, 'monitor.json');
  writeFileSync(file, JSON.stringify({ gatewayUrl: 'http://100.64.0.1:4889', peer: { host: '100.64.0.2', port: 22 } }), { mode: 0o600 });
  return { file, dir };
}
const jobs = [{ id: 'report', name: 'Report', enabled: true, nextRunAt: 10_000_000, maxRunMinutes: 90,
  lastRun: { status: 'failed', at: 1000, result: null, maxRunMinutes: 90, paused: false, deadlineAt: null } }];

describe('home-base monitor runtime', () => {
  it('keeps an alert durable when delivery fails, then acknowledges it only after successful delivery', async () => {
    const { file, dir } = config();
    const deps = { fetchJobs: async () => jobs, probePeer: async () => true, now: () => 2000,
      notify: async () => { throw new Error('EXAMPLE_PRIVATE_VALUE'); } };
    const failed = await runMonitorCheck(file, deps);
    expect(failed).toMatchObject({ pending: 1, notified: 0, gatewayReachable: true });
    const saved = readFileSync(join(dir, 'monitor-state.json'), 'utf8');
    expect(JSON.parse(saved).outbox).toHaveLength(1);
    expect(saved).not.toContain('EXAMPLE_PRIVATE_VALUE');
    const delivered: string[] = [];
    const retried = await runMonitorCheck(file, { ...deps, notify: async alert => { delivered.push(alert.id); } });
    expect(delivered).toHaveLength(1);
    expect(retried).toMatchObject({ pending: 0, notified: 1 });
    await runMonitorCheck(file, { ...deps, notify: async alert => { delivered.push(alert.id); } });
    expect(delivered).toHaveLength(1);
  });

  it('counts refused authentication and a wrong list response as connection failures and still probes the independent peer', async () => {
    const { file } = config();
    let probes = 0;
    const delivered: string[] = [];
    const deps = { fetchJobs: async (): Promise<unknown> => { throw new Error('HTTP 403'); },
      probePeer: async () => { probes++; return true; }, now: () => 1000,
      notify: async (alert: { text: string }) => { delivered.push(alert.text); } };
    expect((await runMonitorCheck(file, deps)).gatewayReachable).toBe(false);
    await runMonitorCheck(file, { ...deps, fetchJobs: async () => ({ error: 'wrong answer' }), now: () => 1000 + 30 * 60_000 });
    expect(probes).toBe(2);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('other computer answered');
  });

  it('authenticates only the requested endpoint and never follows a redirect', async () => {
    let authorization: string | undefined;
    let redirected = false;
    const server = createServer((req, res) => {
      authorization = req.headers.authorization;
      if (req.url === '/private') {
        res.writeHead(302, { Location: '/redirected' }); res.end();
      } else { redirected = true; res.end('[]'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      await expect(requestJson(new URL(`http://127.0.0.1:${port}/private`), { token: 'EXAMPLE_DEVICE_TOKEN' })).rejects.toThrow(/HTTP 302/);
      expect(authorization).toBe('Bearer EXAMPLE_DEVICE_TOKEN');
      expect(redirected).toBe(false);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  it('does not include a refused response body in its error', async () => {
    const server = createServer((_req, res) => { res.writeHead(403); res.end('EXAMPLE_PRIVATE_VALUE'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      await expect(requestJson(new URL(`http://127.0.0.1:${port}/private`))).rejects.toThrow('Gateway request failed (HTTP 403)');
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
