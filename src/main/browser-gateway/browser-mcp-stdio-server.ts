import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { getLogManager, getLogger } from '../logging/logger';
import { McpServer } from '../mcp/mcp-server';
import {
  BrowserGatewayRpcClient,
  type BrowserGatewayRpcClientLike,
} from './browser-gateway-rpc-client';
import {
  BROWSER_TOOL_DEFERRAL_ENV,
  createDeferredBrowserMcpTools,
} from './browser-mcp-deferral';
import { createBrowserMcpTools } from './browser-mcp-tools';
import {
  BROWSER_GATEWAY_RPC_PROTOCOL_VERSION,
  computeBrowserToolSurfaceHash,
} from './browser-rpc-contract';

const logger = getLogger('BrowserMcpStdioServer');

const REVEAL_RESTORE_TIMEOUT_MS = 1_500;

/**
 * Ask the parent for the tool names this instance had already revealed before
 * a forwarder restart (reliability hardening: the MCP tool surface must be
 * identical across a reconnect). Degrades to [] fast — never blocks startup.
 */
export async function fetchPreviouslyRevealedToolNames(
  client: BrowserGatewayRpcClientLike,
): Promise<string[]> {
  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), REVEAL_RESTORE_TIMEOUT_MS).unref?.();
  });
  try {
    const result = await Promise.race([
      client.call('browser.tool_reveal_get', {}),
      timeout,
    ]);
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const names = (result as Record<string, unknown>)['revealedNames'];
      if (Array.isArray(names)) {
        return names.filter((name): name is string => typeof name === 'string');
      }
    }
  } catch {
    // Fall through — parity is restored on the next reveal instead.
  }
  return [];
}

/**
 * Report this forwarder's full tool surface + contract version to the parent
 * so `browser.health` can verify schema-match and tool parity. Fire-and-forget.
 */
export function reportToolSurface(
  client: BrowserGatewayRpcClientLike,
  revealedNames: readonly string[],
): void {
  const tools = createBrowserMcpTools(client);
  void client
    .call('browser.report_tool_surface', {
      names: tools.map((tool) => tool.name),
      revealedNames: [...revealedNames],
      protocolVersion: BROWSER_GATEWAY_RPC_PROTOCOL_VERSION,
      surfaceHash: computeBrowserToolSurfaceHash(tools),
    })
    .then((result) => {
      const parity = result && typeof result === 'object'
        ? (result as Record<string, unknown>)['parity']
        : undefined;
      if (parity && typeof parity === 'object') {
        const record = parity as Record<string, unknown>;
        if (record['surfaceHashMatch'] === false || record['protocolVersionMatch'] === false) {
          logger.warn('Browser Gateway tool-surface contract mismatch with parent', {
            surfaceHashMatch: record['surfaceHashMatch'],
            protocolVersionMatch: record['protocolVersionMatch'],
          });
        }
      }
    })
    .catch(() => undefined);
}

interface JsonRpcRequest {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method: string;
  params?: unknown;
}

function writeResponse(id: JsonRpcRequest['id'], payload: Record<string, unknown>): void {
  stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...payload })}\n`);
}

export async function runBrowserMcpForwarder(
  client: BrowserGatewayRpcClientLike = new BrowserGatewayRpcClient(),
): Promise<void> {
  getLogManager().updateConfig({ enableConsole: false });

  const server = McpServer.getInstance();
  const toolDeferral = process.env[BROWSER_TOOL_DEFERRAL_ENV] === '1';
  const revealedNames = new Set<string>();
  if (toolDeferral) {
    // WS9 deferral: list only the core set + search/describe; all tools stay
    // dispatchable. Reveals push a list_changed so the client re-lists.
    server.registerTools(
      createDeferredBrowserMcpTools(client, {
        onReveal: (names) => {
          server.revealTools(names);
          for (const name of names) {
            revealedNames.add(name);
          }
          // Persist reveal state in the parent so a forwarder restart (MCP
          // reconnect) restores the identical tool surface. Fire-and-forget.
          void client.call('browser.tool_reveal_record', { names }).catch(() => undefined);
        },
      }),
    );
    // Restore the pre-restart surface BEFORE attaching the list_changed
    // notifier (no pre-initialize notification) and before the first
    // tools/list, so the client sees the same tool set as before the blip.
    const restored = await fetchPreviouslyRevealedToolNames(client);
    if (restored.length > 0) {
      server.revealTools(restored);
      for (const name of restored) {
        revealedNames.add(name);
      }
      logger.info('Restored previously revealed browser tools', {
        count: restored.length,
      });
    }
    server.on('tools-list-changed', () => {
      stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n`,
      );
    });
  } else {
    server.registerTools(createBrowserMcpTools(client));
  }
  server.start();
  reportToolSurface(client, [...revealedNames]);

  const shutdown = (): void => {
    server.stop();
  };

  process.on('SIGINT', () => {
    shutdown();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    shutdown();
    process.exit(0);
  });

  const rl = createInterface({ input: stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch (error) {
      logger.warn('Received invalid JSON-RPC request', {
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (request.method === 'notifications/initialized') {
      continue;
    }

    try {
      const result = await server.handleRequest({
        method: request.method,
        params: request.params,
        id: typeof request.id === 'number' ? request.id : undefined,
      });
      if (request.id !== undefined) {
        writeResponse(request.id, { result });
      }
      if (request.method === 'shutdown') {
        shutdown();
        process.exit(0);
      }
    } catch (error) {
      if (request.id !== undefined) {
        writeResponse(request.id, {
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }

  shutdown();
}

// No auto-run here. The aio-mcp SEA dispatcher is the only entrypoint —
// it imports `runBrowserMcpForwarder` and calls it under the `browser-gateway`
// subcommand. Re-adding a `require.main === module` guard would also fire
// from inside the dispatcher's esbuild bundle (esbuild rewrites all bundled
// modules to share the same outer `require.main`/`module`), causing the
// browser-gateway forwarder to start unconditionally whenever any other
// aio-mcp subcommand runs.
