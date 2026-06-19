import * as net from 'node:net';
import { isHeavyDomBrowserMethod, isMutatingBrowserMethod } from './browser-mutation-safety';

export interface BrowserGatewayRpcClientOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface BrowserGatewayRpcClientLike {
  call(method: string, payload: Record<string, unknown>): Promise<unknown>;
}

let nextRequestId = 1;

// The bridge sits between the MCP host (≥30s tool timeout) and the parent
// gateway, whose extension command store waits up to 30s — and far longer for
// operations that intentionally wait (`wait_for` ≤120s, `download_file` ≤60s).
// The previous flat 15s socket timeout was SHORTER than every layer it wrapped,
// so any operation that legitimately took >15s surfaced as a misleading
// `browser_gateway_unavailable` (observed live on `navigate`/`click`/
// `query_elements`). A dead parent still fails fast via a socket error, so a
// larger timeout costs nothing in the unavailable case — it only stops cutting
// off slow-but-valid work.
const DEFAULT_RPC_TIMEOUT_MS = 45_000;
const MAX_RPC_TIMEOUT_MS = 130_000;
const LONG_OP_TIMEOUT_BUFFER_MS = 15_000;
const WAIT_FOR_DEFAULT_BUDGET_MS = 30_000;
const DOWNLOAD_DEFAULT_BUDGET_MS = 60_000;
// DOM-scaling reads (snapshot/query_elements/accessibility_snapshot/screenshot/
// evaluate) grow with page size; a flat 45s socket budget reports them as false
// timeouts on a large/duplicated DOM (the secondary feedback loop in the Webflow
// incident). Give them a larger socket budget — still well under MAX so a dead
// parent fails fast on a socket error rather than waiting this out.
const HEAVY_DOM_RPC_TIMEOUT_MS = 90_000;

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
