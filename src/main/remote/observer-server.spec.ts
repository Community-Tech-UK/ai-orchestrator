import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceManager } from '../instance/instance-manager';
import { OBSERVER_CLIENT_SCRIPT } from './observer-client-script';
import { RemoteObserverAuth, getRemoteObserverAuth } from './observer-auth';
import { RemoteObserverServer } from './observer-server';
import { OBSERVER_STYLES } from './observer-styles';

const mocks = vi.hoisted(() => ({
  listJobs: vi.fn(() => []),
  getAllNodes: vi.fn(() => []),
}));

vi.mock('../repo-jobs', () => ({
  getRepoJobService: () => ({ listJobs: mocks.listJobs }),
}));

vi.mock('../remote-node', () => ({
  getWorkerNodeRegistry: () => ({ getAllNodes: mocks.getAllNodes }),
}));

describe('RemoteObserverServer HTTP boundary', () => {
  let server: RemoteObserverServer;
  let baseUrl: string;

  beforeEach(async () => {
    RemoteObserverAuth._resetForTesting();
    const port = await reserveLoopbackPort();
    const instanceManager = {
      getAllInstances: () => [],
      getInstance: () => undefined,
    } as unknown as InstanceManager;
    server = new RemoteObserverServer();
    server.initialize({ instanceManager });
    await server.start('127.0.0.1', port);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('serves the secured page and exact same-origin assets', async () => {
    const page = await fetch(`${baseUrl}/`);
    const pageBody = await page.text();

    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(page.headers.get('content-security-policy')).toContain("style-src 'self'");
    expect(page.headers.get('content-security-policy')).toContain("require-trusted-types-for 'script'");
    expect(page.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(page.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(page.headers.get('permissions-policy')).toBe('camera=(), geolocation=(), microphone=()');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(pageBody).toContain('src="/observer-client.js"');
    expect(pageBody).toContain('href="/observer.css"');

    const [client, styles] = await Promise.all([
      fetch(`${baseUrl}/observer-client.js`),
      fetch(`${baseUrl}/observer.css`),
    ]);
    expect(client.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
    expect(client.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(client.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await client.text()).toBe(OBSERVER_CLIENT_SCRIPT);
    expect(styles.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(styles.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await styles.text()).toBe(OBSERVER_STYLES);
  });

  it('keeps JSON APIs behind the observer token', async () => {
    const unauthorized = await fetch(`${baseUrl}/api/status`);
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: 'Unauthorized' });

    const token = getRemoteObserverAuth().getToken();
    const authorized = await fetch(`${baseUrl}/api/status?token=${encodeURIComponent(token)}`);
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toMatchObject({
      running: true,
      mode: 'read-only',
      host: '127.0.0.1',
    });
  });

  it('serves the SSE stream without a cross-origin allowance', async () => {
    const unauthorized = await fetch(`${baseUrl}/api/events`);
    expect(unauthorized.status).toBe(401);

    const token = getRemoteObserverAuth().getToken();
    const stream = await fetch(`${baseUrl}/api/events?token=${encodeURIComponent(token)}`);
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toBe('text/event-stream');
    expect(stream.headers.get('access-control-allow-origin')).toBeNull();
    await stream.body?.cancel();
  });
});

async function reserveLoopbackPort(): Promise<number> {
  const reservation = createNetServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}
