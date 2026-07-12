import * as os from 'node:os';
import { loadWorkerConfig, persistConfig, type WorkerConfig } from '../worker-config';

export interface ParsedPairingConfig {
  name?: string;
  authToken: string;
  coordinatorUrl: string;
  /**
   * Additional coordinator URLs to try when `coordinatorUrl` is unreachable,
   * in order. The rest of the worker already supports this end-to-end
   * (`WorkerConfig.coordinatorUrls`, `getConfiguredCoordinatorUrl()`,
   * `worker-agent.ts` dialling, `worker-mode-runtime-service.ts`) — only the
   * pair CLI was silently dropping the list, so a Connection Config offering
   * both a Tailscale hostname and a LAN IP lost its fallback at pairing time.
   *
   * Rescued from tag `preserve/pair-both-wip`. Never contains `coordinatorUrl`.
   */
  coordinatorUrls?: string[];
  namespace: string;
  maxConcurrentInstances: number;
  workingDirectories: string[];
}

const DEFAULT_NAMESPACE = 'default';
const DEFAULT_MAX_CONCURRENT_INSTANCES = 10;

export function parsePairingConfigInput(input: string): ParsedPairingConfig {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Pairing input is empty');
  }

  if (trimmed.startsWith('{')) {
    return parseJsonPairingConfig(trimmed);
  }

  if (trimmed.startsWith('ai-orchestrator://')) {
    return parsePairingLink(trimmed);
  }

  throw new Error(
    'Pairing input must be a pairing link or full Connection Config. A one-time credential alone is not enough to locate the coordinator.',
  );
}

export function sanitizePairingErrorMessage(error: unknown, secret?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return secret ? message.split(secret).join('[redacted]') : message;
}

export function buildCoordinatorUrl(params: {
  host: string;
  port: number;
  requireTls?: boolean;
}): string {
  const protocol = params.requireTls === true ? 'wss' : 'ws';
  return `${protocol}://${params.host}:${params.port}`;
}

export function writePairedWorkerConfig(
  configPath: string,
  parsed: ParsedPairingConfig,
): WorkerConfig {
  const existing = loadWorkerConfig(configPath);
  const next: WorkerConfig = {
    ...existing,
    name: parsed.name ?? existing.name ?? os.hostname(),
    authToken: parsed.authToken,
    coordinatorUrl: parsed.coordinatorUrl,
    namespace: parsed.namespace,
    maxConcurrentInstances: parsed.maxConcurrentInstances,
    workingDirectories: [...parsed.workingDirectories],
  };
  // Persist the fallback list so `getConfiguredCoordinatorUrl()` can use it.
  // Re-pairing without a list must CLEAR a stale one rather than inherit it
  // from `...existing`, otherwise a worker keeps dialling a coordinator the
  // operator has since removed.
  if (parsed.coordinatorUrls && parsed.coordinatorUrls.length > 0) {
    next.coordinatorUrls = [...parsed.coordinatorUrls];
  } else {
    delete next.coordinatorUrls;
  }
  delete next.nodeToken;
  delete next.recoveryToken;
  persistConfig(configPath, next);
  return next;
}

function parsePairingLink(input: string): ParsedPairingConfig {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Pairing link is malformed');
  }
  if (url.protocol !== 'ai-orchestrator:' || url.hostname !== 'remote-node' || url.pathname !== '/pair') {
    throw new Error('Pairing link must use ai-orchestrator://remote-node/pair');
  }

  const token = firstString(url.searchParams.get('authToken'), url.searchParams.get('token'));
  const coordinatorUrl = firstString(url.searchParams.get('coordinatorUrl'))
    ?? coordinatorFromHostPort({
      host: url.searchParams.get('host'),
      port: url.searchParams.get('port'),
      requireTls: url.searchParams.get('requireTls'),
    });
  return normalizedParsedConfig({
    authToken: token,
    coordinatorUrl,
    namespace: url.searchParams.get('namespace') ?? undefined,
    name: url.searchParams.get('name') ?? undefined,
  });
}

function parseJsonPairingConfig(input: string): ParsedPairingConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    throw new Error('Connection Config JSON is malformed');
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error('Connection Config must be a JSON object');
  }
  const config = raw as Record<string, unknown>;
  const coordinatorUrl = firstString(config['coordinatorUrl'])
    ?? coordinatorFromHostPort({
      host: config['host'],
      port: config['port'],
      requireTls: config['requireTls'],
    });

  return normalizedParsedConfig({
    name: firstString(config['name']),
    authToken: firstString(config['authToken'], config['token']),
    coordinatorUrl,
    coordinatorUrls: config['coordinatorUrls'],
    namespace: firstString(config['namespace']),
    maxConcurrentInstances: config['maxConcurrentInstances'],
    workingDirectories: config['workingDirectories'],
  });
}

function normalizedParsedConfig(input: {
  name?: string;
  authToken?: string;
  coordinatorUrl?: string;
  coordinatorUrls?: unknown;
  namespace?: string;
  maxConcurrentInstances?: unknown;
  workingDirectories?: unknown;
}): ParsedPairingConfig {
  const authToken = input.authToken?.trim();
  if (!authToken) {
    throw new Error('Pairing config is missing authToken');
  }
  const coordinatorUrl = normalizeCoordinatorUrl(input.coordinatorUrl);
  if (!coordinatorUrl) {
    throw new Error(
      'Pairing config is missing coordinatorUrl. Paste the full Connection Config or run:\n  aio-worker pair <pairing-link>',
    );
  }
  const name = input.name?.trim();
  const maxConcurrentInstances = isPositiveInteger(input.maxConcurrentInstances)
    ? input.maxConcurrentInstances
    : DEFAULT_MAX_CONCURRENT_INSTANCES;
  const coordinatorUrls = normalizeCoordinatorUrls(input.coordinatorUrls, coordinatorUrl);

  return {
    ...(name ? { name } : {}),
    authToken,
    coordinatorUrl,
    // Omitted entirely when empty, so an unpaired-from-link config keeps the
    // same shape it had before this field existed.
    ...(coordinatorUrls.length > 0 ? { coordinatorUrls } : {}),
    namespace: input.namespace?.trim() || DEFAULT_NAMESPACE,
    maxConcurrentInstances,
    workingDirectories: normalizeWorkingDirectoryInput(input.workingDirectories),
  };
}

/**
 * Normalize the fallback coordinator list: drop non-strings and unparseable
 * URLs, dedupe, and exclude `primary` (which is already `coordinatorUrl`) so a
 * config listing the primary in both places doesn't dial it twice.
 */
function normalizeCoordinatorUrls(value: unknown, primary: string): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>([primary]);
  const urls: string[] = [];
  for (const entry of value) {
    const url = typeof entry === 'string' ? normalizeCoordinatorUrl(entry) : undefined;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function coordinatorFromHostPort(input: {
  host: unknown;
  port: unknown;
  requireTls: unknown;
}): string | undefined {
  const host = firstString(input.host)?.trim();
  const port = typeof input.port === 'number'
    ? input.port
    : Number.parseInt(firstString(input.port) ?? '', 10);
  if (!host || !isValidPort(port)) {
    return undefined;
  }
  return buildCoordinatorUrl({
    host,
    port,
    requireTls: input.requireTls === true || input.requireTls === 'true',
  });
}

function normalizeCoordinatorUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      return undefined;
    }
    url.search = '';
    url.hash = '';
    return url.pathname === '/' && !url.search && !url.hash
      ? `${url.protocol}//${url.host}`
      : url.toString();
  } catch {
    return undefined;
  }
}

function normalizeWorkingDirectoryInput(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}
