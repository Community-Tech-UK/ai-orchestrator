import * as net from 'node:net';
import { isHeavyDomBrowserMethod, isMutatingBrowserMethod } from './browser-mutation-safety';
import { BROWSER_GATEWAY_RPC_PROTOCOL_VERSION } from './browser-rpc-contract';

export interface BrowserGatewayRpcClientOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface BrowserGatewayRpcClientLike {
  call(method: string, payload: Record<string, unknown>): Promise<unknown>;
}

let nextRequestId = 1;

// The bridge sits between the MCP host (≥30s tool timeout) and the parent
// gateway, whose extension command store now waits up to ~90s for an extension
// channel to recover while a command is still queued (undelivered-wait, see
// browser-extension-command-store), plus the ~35s execution window once
// delivered — and even longer for operations that intentionally wait
// (`wait_for` ≤120s, `download_file` ≤60s). The socket timeout must OUTLIVE
// every inner layer or a slow-but-valid recovery surfaces as a misleading
// client-side timeout (the original flat 15s bug, observed live on
// `navigate`/`click`/`query_elements`). A dead parent still fails fast via a
// socket error, so a large timeout costs nothing in the unavailable case; the
// gateway itself always answers earlier because its own timers fire first.
// Sized from the gateway's worst HONEST answer for a mutation on a degraded
// channel: undelivered-wait 90s + receipt window 15s + heavy-DOM execution 65s
// + result grace ≈ 175s. The socket must outlive that or the client mislabels
// the gateway's precise verdict (not_delivered / receipt_missing /
// maybe_applied + probe) as a generic socket timeout. Only extreme read paths
// (a full-length wait_for riding out a channel outage) can exceed this — and
// a read timeout is retry-safe anyway.
const DEFAULT_RPC_TIMEOUT_MS = 180_000;
const MAX_RPC_TIMEOUT_MS = 180_000;
const LONG_OP_TIMEOUT_BUFFER_MS = 15_000;
const WAIT_FOR_DEFAULT_BUDGET_MS = 30_000;
const DOWNLOAD_DEFAULT_BUDGET_MS = 60_000;
// DOM-scaling reads (snapshot/query_elements/accessibility_snapshot/screenshot/
// evaluate) grow with page size and keep their own floor should DEFAULT ever be
// tuned back down — a flat short socket budget reports them as false timeouts
// on a large/duplicated DOM (the secondary feedback loop in the Webflow
// incident).
const HEAVY_DOM_RPC_TIMEOUT_MS = 180_000;

class BrowserGatewayRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserGatewayRpcError';
  }
}

// Distinct from a socket/connection error: the request WAS written, we just never
// saw the reply in time. For a mutating method that means the op may already have
// applied (see browser-mutation-safety), so the caller must verify before retry.
class BrowserGatewayTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserGatewayTimeoutError';
  }
}

function unavailable(): Record<string, unknown> {
  return {
    decision: 'denied',
    outcome: 'not_run',
    reason: 'browser_gateway_unavailable',
  };
}

// A socket timeout (request sent, no reply in time). The contract only allows
// `outcome: 'not_run'` for a denied result, so the "maybe applied" signal rides
// in `reason`/`data` rather than a new outcome: a mutating op that timed out is
// reported as maybe-applied so the caller verifies before retrying, while a
// read is reported as a plain (retry-safe) timeout.
function timedOut(method: string): Record<string, unknown> {
  const maybeApplied = isMutatingBrowserMethod(method);
  return {
    decision: 'denied',
    outcome: 'not_run',
    reason: maybeApplied ? 'browser_gateway_timeout_maybe_applied' : 'browser_gateway_timeout',
    data: {
      timedOut: true,
      maybeApplied,
      ...(maybeApplied
        ? {
            advice:
              'The call timed out after being sent; this mutation may have already applied. '
              + 'Verify page state (e.g. re-read or query elements) before retrying to avoid duplicates.',
          }
        : {}),
    },
  };
}

function deniedForRpcError(error: BrowserGatewayRpcError): Record<string, unknown> {
  return {
    decision: 'denied',
    outcome: 'not_run',
    reason: normalizeRpcErrorReason(error.message),
    data: {
      message: error.message,
    },
  };
}

function normalizeRpcErrorReason(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('unknown browser gateway instance')) {
    return 'unknown_browser_gateway_instance';
  }
  if (normalized.includes('invalid browser gateway rpc payload')) {
    return 'invalid_browser_gateway_rpc_payload';
  }
  if (normalized.includes('payload too large')) {
    return 'browser_gateway_rpc_payload_too_large';
  }
  if (normalized.includes('rate limit')) {
    return 'browser_gateway_rpc_rate_limited';
  }
  if (normalized.includes('service method unavailable')) {
    return 'browser_gateway_service_method_unavailable';
  }
  return 'browser_gateway_rpc_error';
}

export class BrowserGatewayRpcClient implements BrowserGatewayRpcClientLike {
  private readonly env: Record<string, string | undefined>;
  private readonly timeoutMs: number;

  constructor(options: BrowserGatewayRpcClientOptions = {}) {
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  }

  async call(method: string, payload: Record<string, unknown>): Promise<unknown> {
    const socketPath = this.env['AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET'];
    const instanceId = this.env['AI_ORCHESTRATOR_BROWSER_INSTANCE_ID'];
    const provider = this.env['AI_ORCHESTRATOR_BROWSER_PROVIDER'];
    if (!socketPath || !instanceId) {
      return unavailable();
    }

    try {
      return await this.send(socketPath, {
        jsonrpc: '2.0',
        id: nextRequestId++,
        method,
        params: {
          instanceId,
          ...(provider ? { provider } : {}),
          // Advisory contract version. Servers that predate it ignore unknown
          // params fields; newer servers use it for skew telemetry.
          contract: { protocolVersion: BROWSER_GATEWAY_RPC_PROTOCOL_VERSION },
          payload,
        },
      }, this.resolveTimeoutMs(method, payload));
    } catch (error) {
      if (error instanceof BrowserGatewayRpcError) {
        return deniedForRpcError(error);
      }
      if (error instanceof BrowserGatewayTimeoutError) {
        return timedOut(method);
      }
      // A connection-level failure means the request never reached the parent,
      // so it genuinely did not run.
      return unavailable();
    }
  }

  // Operations that intentionally wait carry their own budget; the socket must
  // outlive that budget (plus overhead) or the wait can never report success.
  private resolveTimeoutMs(method: string, payload: Record<string, unknown>): number {
    if (method === 'browser.wait_for' || method === 'browser.download_file') {
      const requested = typeof payload['timeoutMs'] === 'number' ? payload['timeoutMs'] : undefined;
      const fallback = method === 'browser.wait_for'
        ? WAIT_FOR_DEFAULT_BUDGET_MS
        : DOWNLOAD_DEFAULT_BUDGET_MS;
      const budget = (requested ?? fallback) + LONG_OP_TIMEOUT_BUFFER_MS;
      return Math.min(MAX_RPC_TIMEOUT_MS, Math.max(this.timeoutMs, budget));
    }
    if (isHeavyDomBrowserMethod(method)) {
      return Math.min(MAX_RPC_TIMEOUT_MS, Math.max(this.timeoutMs, HEAVY_DOM_RPC_TIMEOUT_MS));
    }
    return this.timeoutMs;
  }

  private send(
    socketPath: string,
    request: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const socket = net.connect(socketPath);
      let buffer = '';
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new BrowserGatewayTimeoutError('Browser Gateway RPC request timed out'));
      }, timeoutMs);

      socket.on('connect', () => {
        socket.write(`${JSON.stringify(request)}\n`);
      });
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        const newline = buffer.indexOf('\n');
        if (newline === -1) {
          return;
        }
        const line = buffer.slice(0, newline);
        clearTimeout(timeout);
        socket.end();
        const response = JSON.parse(line) as {
          result?: unknown;
          error?: { message?: string };
        };
        if (response.error) {
          reject(new BrowserGatewayRpcError(response.error.message ?? 'Browser Gateway RPC failed'));
          return;
        }
        resolve(response.result);
      });
      socket.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }
}
