import { createRequire } from 'node:module';
import http, { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileDeviceRegistry } from '../../src/main/mobile-gateway/mobile-device-registry';
import { bearerFromHeader } from '../../src/main/mobile-gateway/mobile-gateway-http-utils';

const require = createRequire(import.meta.url);
const { requestJson, runMonitorCheck } = require('./monitor.js') as {
  requestJson(url: URL, options?: { token?: string; timeoutMs?: number }): Promise<unknown>;
  runMonitorCheck(configPath: string, deps: {
    fetchJobs?: () => Promise<unknown>; probePeer: () => Promise<boolean>;
    notify?: (alert: { id: string; subject: string; text: string }) => Promise<void>; now?: () => number;
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

  it('lets a later alert through when an earlier delivery remains uncertain', async () => {
    const { file, dir } = config();
    const first = { ...jobs[0], id: 'first', name: 'First report' };
    const second = { ...jobs[0], id: 'second', name: 'Second report' };
    const delivered: string[] = [];
    const deps = {
      fetchJobs: async () => [first], probePeer: async () => true, now: () => 2000,
      notify: async (alert: { text: string }) => {
        if (alert.text.includes('First report')) throw new Error('Delivery is still uncertain');
        delivered.push(alert.text);
      },
    };
    expect(await runMonitorCheck(file, deps)).toMatchObject({ pending: 1, notified: 0, deliveryFailed: true });
    const later = { ...deps, fetchJobs: async () => [first, second], now: () => 3000 };
    expect(await runMonitorCheck(file, later)).toMatchObject({ pending: 2, notified: 0, deliveryFailed: true });
    expect(await runMonitorCheck(file, later)).toMatchObject({ pending: 1, notified: 1, deliveryFailed: false });
    expect(delivered).toEqual([expect.stringContaining('Second report')]);
    const { outbox } = JSON.parse(readFileSync(join(dir, 'monitor-state.json'), 'utf8'));
    expect(outbox).toEqual([expect.objectContaining({ text: expect.stringContaining('First report') })]);
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

  it('uses a renewed token after its original deadline and counts a later revocation as a failed check', async () => {
    const { file, dir } = config();
    let now = 100_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const registry = new MobileDeviceRegistry({
      load: () => undefined, save: () => {}, loadProfiles: () => undefined, saveProfiles: () => {},
    });
    const statuses: number[] = [];
    const server = createServer((req, res) => {
      if (req.method !== 'GET' || req.url !== '/api/automations') {
        res.writeHead(404).end();
        return;
      }
      const status = registry.validateToken(bearerFromHeader(req.headers.authorization)) ? 200 : 401;
      statuses.push(status);
      res.writeHead(status).end('[]');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const request = http.request;
    // Retain the normal protected configuration, URL construction and HTTP code, but keep traffic local.
    const route = vi.spyOn(http, 'request').mockImplementation((url, options, callback) => {
      if (!(url instanceof URL) || url.origin !== 'http://100.64.0.1:4889') throw new Error('Unexpected gateway');
      return request(new URL(url.pathname, `http://127.0.0.1:${port}`), options, callback);
    });
    try {
      const pairing = registry.issuePairing();
      const result = registry.pair({ pairingToken: pairing.pairingToken, tokenTtlMs: 60_000 });
      if (result.status !== 'paired') throw new Error('Expected pairing to succeed');
      const { deviceId, token, expiresAt } = result.device;
      writeFileSync(join(dir, 'device-token.json'), JSON.stringify({ token, expiresAt }), { mode: 0o600 });

      const deps = { probePeer: async () => true };
      now = expiresAt - 10_000;
      expect((await runMonitorCheck(file, deps)).gatewayReachable).toBe(true);

      now = expiresAt + 1;
      const renewed = await runMonitorCheck(file, deps);
      expect(statuses).toEqual([200, 200]);
      expect(renewed.gatewayReachable).toBe(true);

      registry.revokeDevice(deviceId);
      expect((await runMonitorCheck(file, deps)).gatewayReachable).toBe(false);
      expect(statuses).toEqual([200, 200, 401]);
    } finally {
      route.mockRestore();
      clock.mockRestore();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
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
