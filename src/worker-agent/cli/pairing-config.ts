import * as os from 'node:os';
import { loadWorkerConfig, persistConfig, type WorkerConfig } from '../worker-config';

export interface ParsedPairingConfig {
  name?: string;
  authToken: string;
  coordinatorUrl: string;
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
    namespace: firstString(config['namespace']),
    maxConcurrentInstances: config['maxConcurrentInstances'],
    workingDirectories: config['workingDirectories'],
  });
}

function normalizedParsedConfig(input: {
  name?: string;
  authToken?: string;
  coordinatorUrl?: string;
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

  return {
    ...(name ? { name } : {}),
    authToken,
    coordinatorUrl,
    namespace: input.namespace?.trim() || DEFAULT_NAMESPACE,
    maxConcurrentInstances,
    workingDirectories: normalizeWorkingDirectoryInput(input.workingDirectories),
  };
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
