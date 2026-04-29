import type { AllowedHostMatcher } from './allowed-hosts';
import { OrchestratorPausedError } from '../pause/orchestrator-paused-error';

interface CoordinatorLike {
  isPaused(): boolean;
}

export interface InstallNetworkPauseGateDeps {
  coordinator: CoordinatorLike;
  allowedHosts: AllowedHostMatcher;
}

type HttpModule = typeof import('node:http');
type HttpsModule = typeof import('node:https');

// Patch the real CommonJS export objects. ESM namespace imports are often
// frozen accessors in Vitest and cannot be assigned to.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mutableHttp = require('node:http') as HttpModule & {
  request: HttpModule['request'];
  get: HttpModule['get'];
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mutableHttps = require('node:https') as HttpsModule & {
  request: HttpsModule['request'];
  get: HttpsModule['get'];
};

function normalizeHostname(hostname: string | undefined): string | undefined {
  if (!hostname) return hostname;
  if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname.slice(1, -1);
  return hostname;
}

function stripPort(hostWithPort: string): string {
  if (hostWithPort.startsWith('[')) {
    const close = hostWithPort.indexOf(']');
    return close === -1 ? hostWithPort : hostWithPort.slice(0, close + 1);
  }

  const lastColon = hostWithPort.lastIndexOf(':');
  if (lastColon === -1) return hostWithPort;
  if (hostWithPort.indexOf(':') !== lastColon) return hostWithPort;
  return hostWithPort.slice(0, lastColon);
}

function extractHostname(args: readonly unknown[]): string | undefined {
  const first = args[0];
  if (typeof first === 'string') {
    try {
      return normalizeHostname(new URL(first).hostname);
    } catch {
      return undefined;
    }
  }
  if (first instanceof URL) return normalizeHostname(first.hostname);
  if (first && typeof first === 'object') {
    const options = first as { hostname?: unknown; host?: unknown };
    if (typeof options.hostname === 'string') return normalizeHostname(options.hostname);
    if (typeof options.host === 'string') return normalizeHostname(stripPort(options.host));
  }
  return undefined;
}

function throwIfPausedForHost(
  scheme: string,
  hostname: string | undefined,
  deps: InstallNetworkPauseGateDeps
): void {
  if (deps.allowedHosts.isAllowed(hostname) || !deps.coordinator.isPaused()) return;

  throw new OrchestratorPausedError(
    `Network call refused while paused: ${scheme}://${hostname ?? '<unknown>'}`,
    { hostname }
  );
}

function makeGatedRequest<F extends (...args: never[]) => unknown>(
  scheme: 'http' | 'https',
  real: F,
  deps: InstallNetworkPauseGateDeps
): F {
  return function gatedRequest(this: unknown, ...args: unknown[]): unknown {
    throwIfPausedForHost(scheme, extractHostname(args), deps);
    return (real as unknown as (...innerArgs: unknown[]) => unknown).apply(this, args);
  } as unknown as F;
}

function extractFetchHostname(input: Parameters<typeof globalThis.fetch>[0]): string | undefined {
  try {
    if (typeof input === 'string') return normalizeHostname(new URL(input).hostname);
    if (input instanceof URL) return normalizeHostname(input.hostname);
    if (typeof Request !== 'undefined' && input instanceof Request) {
      return normalizeHostname(new URL(input.url).hostname);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function makeGatedFetch(
  real: typeof globalThis.fetch,
  deps: InstallNetworkPauseGateDeps
): typeof globalThis.fetch {
  return (async (input, init) => {
    throwIfPausedForHost('fetch', extractFetchHostname(input), deps);
    return real(input, init);
  }) as typeof globalThis.fetch;
}

export function installNetworkPauseGate(deps: InstallNetworkPauseGateDeps): () => void {
  const realHttpRequest = mutableHttp.request;
  const realHttpGet = mutableHttp.get;
  const realHttpsRequest = mutableHttps.request;
  const realHttpsGet = mutableHttps.get;
  const realFetch = globalThis.fetch;

  mutableHttp.request = makeGatedRequest('http', realHttpRequest as never, deps) as HttpModule['request'];
  mutableHttp.get = makeGatedRequest('http', realHttpGet as never, deps) as HttpModule['get'];
  mutableHttps.request = makeGatedRequest(
    'https',
    realHttpsRequest as never,
    deps
  ) as HttpsModule['request'];
  mutableHttps.get = makeGatedRequest('https', realHttpsGet as never, deps) as HttpsModule['get'];
  globalThis.fetch = makeGatedFetch(realFetch, deps);

  return () => {
    mutableHttp.request = realHttpRequest;
    mutableHttp.get = realHttpGet;
    mutableHttps.request = realHttpsRequest;
    mutableHttps.get = realHttpsGet;
    globalThis.fetch = realFetch;
  };
}
