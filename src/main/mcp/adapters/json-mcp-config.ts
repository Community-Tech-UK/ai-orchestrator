import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import type { McpTransport } from '../../../shared/types/mcp-orchestrator.types';
import type { ProviderMcpScope, SupportedProvider } from '../../../shared/types/mcp-scopes.types';
import type { RawMcpRecord } from '../redaction-service';

export interface JsonMcpDocument {
  mcpServers?: Record<string, unknown>;
  mcp_servers?: Record<string, unknown>;
  [key: string]: unknown;
}

export async function readJsonMcpDocument(filePath: string): Promise<JsonMcpDocument> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const raw = await fsp.readFile(filePath, 'utf8');
  if (!raw.trim()) {
    return {};
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    return {};
  }
  return parsed;
}

export function getMcpServerMap(document: JsonMcpDocument): Record<string, unknown> {
  if (isRecord(document.mcpServers)) {
    return document.mcpServers;
  }
  if (isRecord(document.mcp_servers)) {
    return document.mcp_servers;
  }
  return {};
}

export function normalizeJsonMcpServers(
  provider: SupportedProvider,
  scope: ProviderMcpScope,
  servers: Record<string, unknown>,
): RawMcpRecord[] {
  const now = Date.now();
  return Object.entries(servers).map(([name, entry]) => {
    const record = isRecord(entry) ? entry : {};
    const command = getString(record, 'command');
    const url = getString(record, 'url') ?? getString(record, 'httpUrl');
    const explicitTransport = getString(record, 'transport') ?? getString(record, 'type');
    const transport: McpTransport =
      explicitTransport === 'http' || explicitTransport === 'sse'
        ? explicitTransport
        : url
          ? 'sse'
          : 'stdio';
    return {
      id: `${provider}:${scope}:${name}`,
      name,
      description: getString(record, 'description'),
      transport,
      command,
      args: getStringArray(record, 'args'),
      url,
      headers: getStringRecord(record, 'headers'),
      env: getStringRecord(record, 'env'),
      autoConnect: getBoolean(record, 'autoConnect') ?? true,
      createdAt: now,
      updatedAt: now,
    };
  });
}

export function serializeJsonMcpRecord(record: RawMcpRecord): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  if (record.transport !== 'stdio') output['transport'] = record.transport;
  if (record.command) output['command'] = record.command;
  if (record.args) output['args'] = record.args;
  if (record.url) output['url'] = record.url;
  if (record.headers) output['headers'] = record.headers;
  if (record.env) output['env'] = record.env;
  if (record.description) output['description'] = record.description;
  if (!record.autoConnect) output['autoConnect'] = false;
  return output;
}

export function serverNameFromId(serverId: string): string {
  const parts = serverId.split(':');
  return parts[parts.length - 1] || serverId;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function getStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.every((item) => typeof item === 'string') ? value : undefined;
}

function getStringRecord(record: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const value = record[key];
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
