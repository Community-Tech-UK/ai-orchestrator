import { afterEach, describe, expect, it } from 'vitest';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { BrowserGatewayRpcClient } from './browser-gateway-rpc-client';

describe('BrowserGatewayRpcClient', () => {
  const servers: net.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    servers.length = 0;
  });

  it('returns a structured unavailable result when socket env is missing', async () => {
    const client = new BrowserGatewayRpcClient({ env: {} });

    await expect(client.call('browser.health', {})).resolves.toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'browser_gateway_unavailable',
    });
  });

  it('sends JSON-RPC requests with the injected instance id', async () => {
    const socketPath = path.join(os.tmpdir(), `browser-gateway-${process.pid}.sock`);
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        const request = JSON.parse(chunk.toString('utf-8'));
        socket.end(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              method: request.method,
              params: request.params,
            },
          })}\n`,
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const client = new BrowserGatewayRpcClient({
      env: {
        AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET: socketPath,
        AI_ORCHESTRATOR_BROWSER_INSTANCE_ID: 'instance-1',
        AI_ORCHESTRATOR_BROWSER_PROVIDER: 'copilot',
      },
    });

    await expect(client.call('browser.navigate', { profileId: 'profile-1' })).resolves.toMatchObject({
      method: 'browser.navigate',
      params: {
        instanceId: 'instance-1',
        provider: 'copilot',
        payload: {
          profileId: 'profile-1',
        },
      },
    });
  });

  it('extends the socket timeout for waiting operations beyond the base timeout', async () => {
    // A server that replies after a short delay. With a deliberately tiny base
    // timeout, a normal call must give up, but wait_for must extend its budget
    // (payload.timeoutMs + buffer) and succeed — guarding the timeout-cascade
    // fix where a flat 15s client timeout cut off slow-but-valid operations.
    const socketPath = path.join(os.tmpdir(), `browser-gateway-slow-${process.pid}.sock`);
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        const request = JSON.parse(chunk.toString('utf-8'));
        setTimeout(() => {
          socket.end(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: { method: request.method },
            })}\n`,
          );
        }, 150);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const client = new BrowserGatewayRpcClient({
      env: {
        AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET: socketPath,
        AI_ORCHESTRATOR_BROWSER_INSTANCE_ID: 'instance-1',
      },
      timeoutMs: 50,
    });

    // Non-waiting mutating call uses the (tiny) base timeout and gives up — but
    // because it was sent before timing out it is reported as maybe-applied, not
    // not-run, so the caller verifies before retrying instead of duplicating it.
    await expect(client.call('browser.navigate', {})).resolves.toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'browser_gateway_timeout_maybe_applied',
      data: { timedOut: true, maybeApplied: true },
    });
    // wait_for extends to payload.timeoutMs + buffer, so 150ms is well within budget.
    await expect(
      client.call('browser.wait_for', { timeoutMs: 1_000 }),
    ).resolves.toMatchObject({ method: 'browser.wait_for' });
  });

  it('reports a timed-out read as retry-safe rather than maybe-applied', async () => {
    const socketPath = path.join(os.tmpdir(), `browser-gateway-read-${process.pid}.sock`);
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        const request = JSON.parse(chunk.toString('utf-8'));
        setTimeout(() => {
          socket.end(
            `${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`,
          );
        }, 200);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const client = new BrowserGatewayRpcClient({
      env: {
        AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET: socketPath,
        AI_ORCHESTRATOR_BROWSER_INSTANCE_ID: 'instance-1',
      },
      timeoutMs: 50,
    });

    await expect(client.call('browser.console_messages', {})).resolves.toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'browser_gateway_timeout',
      data: { timedOut: true, maybeApplied: false },
    });
  });

  it('reports a true connection failure as unavailable (genuinely not run)', async () => {
    const client = new BrowserGatewayRpcClient({
      env: {
        AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET: path.join(
          os.tmpdir(),
          `browser-gateway-missing-${process.pid}.sock`,
        ),
        AI_ORCHESTRATOR_BROWSER_INSTANCE_ID: 'instance-1',
      },
    });

    await expect(client.call('browser.navigate', {})).resolves.toMatchObject({
      reason: 'browser_gateway_unavailable',
    });
  });

  it('extends the socket timeout for DOM-scaling reads on a large page', async () => {
    // Heavy reads (query_elements/snapshot/...) grow with DOM size. With a tiny
    // base timeout a flat budget would falsely time out, but the heavy-DOM budget
    // keeps a 150ms reply well within range.
    const socketPath = path.join(os.tmpdir(), `browser-gateway-heavy-${process.pid}.sock`);
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        const request = JSON.parse(chunk.toString('utf-8'));
        setTimeout(() => {
          socket.end(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: { method: request.method },
            })}\n`,
          );
        }, 150);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const client = new BrowserGatewayRpcClient({
      env: {
        AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET: socketPath,
        AI_ORCHESTRATOR_BROWSER_INSTANCE_ID: 'instance-1',
      },
      timeoutMs: 50,
    });

    await expect(
      client.call('browser.query_elements', { profileId: 'p', targetId: 't' }),
    ).resolves.toMatchObject({ method: 'browser.query_elements' });
  });

  it('returns parent-side RPC errors without masking them as unavailable', async () => {
    const socketPath = path.join(os.tmpdir(), `browser-gateway-error-${process.pid}.sock`);
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        const request = JSON.parse(chunk.toString('utf-8'));
        socket.end(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: {
              code: -32000,
              message: 'Invalid browser gateway RPC payload',
            },
          })}\n`,
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const client = new BrowserGatewayRpcClient({
      env: {
        AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET: socketPath,
        AI_ORCHESTRATOR_BROWSER_INSTANCE_ID: 'instance-1',
      },
    });

    await expect(client.call('browser.navigate', { profileId: 'profile-1' })).resolves.toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'invalid_browser_gateway_rpc_payload',
      data: {
        message: 'Invalid browser gateway RPC payload',
      },
    });
  });
});
