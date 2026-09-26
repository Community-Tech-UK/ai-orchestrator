import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import type { McpTransport } from '../../../shared/types/mcp-orchestrator.types';
import type { ProviderMcpScope, SupportedProvider } from '../../../shared/types/mcp-scopes.types';
import type { RawMcpRecord } from '../redaction-service';
import { isRecord } from './json-mcp-config';

/**
 * OpenCode MCP config helpers.
 *
 * OpenCode keeps its MCP servers under a top-level `mcp` map in
 * `opencode.json` / `opencode.jsonc`, with a different shape from the usual
 * `mcpServers` map (schema: https://opencode.ai/config.json):
 *
 *   local:  { "type": "local",  "command": ["cmd", ...args], "environment": {...}, "enabled": true }
 *   remote: { "type": "remote", "url": "https://…", "headers": {...}, "enabled": true }
 *
 * `command` is an argv ARRAY (command + args together) and env lives under
 * `environment`. Both config names are JSONC (comments and trailing commas
 * allowed); reads strip both outside string literals, and writes re-serialize
 * as plain JSON — a comment-bearing `opencode.jsonc` loses its comments on
 * write, the same whole-document rewrite behaviour as the Claude/Gemini
 * adapters.
 */
export interface OpenCodeMcpDocument {
  mcp?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Strip `//` and `/* *\/` comments outside string literals. */
function stripComments(raw: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i] as string;
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && raw[i + 1] === '/') {
      while (i < raw.length && raw[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && raw[i + 1] === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Drop trailing commas outside string literals (run AFTER {@link stripComments}). */
function stripTrailingCommas(raw: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i] as string;
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let ahead = i + 1;
      while (ahead < raw.length && /\s/.test(raw[ahead] as string)) ahead += 1;
      const next = raw[ahead];
      if (next === '}' || next === ']') {
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/** Strip `//` / `/* *\/` comments and trailing commas outside string literals. */
export function stripJsonc(raw: string): string {
  return stripTrailingCommas(stripComments(raw));
}

export async function readOpenCodeMcpDocument(filePath: string): Promise<OpenCodeMcpDocument> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const raw = await fsp.readFile(filePath, 'utf8');
  if (!raw.trim()) {
    return {};
  }
  const parsed: unknown = JSON.parse(stripJsonc(raw));
  return isRecord(parsed) ? parsed as OpenCodeMcpDocument : {};
}

export function getOpenCodeMcpMap(document: OpenCodeMcpDocument): Record<string, unknown> {
  return isRecord(document.mcp) ? document.mcp : {};
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function getStringRecord(record: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const value = record[key];
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** OpenCode stores argv as one array; split it into command + args. */
function splitCommand(entry: Record<string, unknown>): { command?: string; args?: string[] } {
  const raw = entry['command'];
  if (Array.isArray(raw)) {
    const parts = raw.filter((item): item is string => typeof item === 'string');
    const [command, ...args] = parts;
    return { command, ...(args.length > 0 ? { args } : {}) };
  }
  if (typeof raw === 'string' && raw.trim()) {
    return { command: raw };
  }
  return {};
}

export function normalizeOpenCodeMcpServers(
  provider: SupportedProvider,
  scope: ProviderMcpScope,
  servers: Record<string, unknown>,
): RawMcpRecord[] {
  const now = Date.now();
  return Object.entries(servers).map(([name, entry]) => {
    const record = isRecord(entry) ? entry : {};
    const { command, args } = splitCommand(record);
    const url = getString(record, 'url');
    const transport: McpTransport = url || getString(record, 'type') === 'remote' ? 'sse' : 'stdio';
    return {
      id: `${provider}:${scope}:${name}`,
      name,
      description: getString(record, 'description'),
      transport,
      command,
      args,
      url,
      headers: getStringRecord(record, 'headers'),
      env: getStringRecord(record, 'environment'),
      autoConnect: getBoolean(record, 'enabled') ?? true,
      createdAt: now,
      updatedAt: now,
    };
  });
}

export function serializeOpenCodeMcpRecord(record: RawMcpRecord): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  if (record.transport === 'stdio' || !record.url) {
    output['type'] = 'local';
    const argv = [record.command, ...(record.args ?? [])]
      .filter((part): part is string => Boolean(part && part.trim()));
    output['command'] = argv;
  } else {
    output['type'] = 'remote';
    output['url'] = record.url;
    if (record.headers) output['headers'] = record.headers;
  }
  if (record.env && Object.keys(record.env).length > 0) output['environment'] = record.env;
  if (record.description) output['description'] = record.description;
  if (record.autoConnect === false) output['enabled'] = false;
  return output;
}

export function openCodeServerNameFromId(serverId: string): string {
  const parts = serverId.split(':');
  return parts[parts.length - 1] || serverId;
}

/**
 * Map an OpenCode `mcp` entry onto the generic `mcpServers` record shape
 * (`command`/`args`/`env`/`url`/`headers`/`transport`/`enabled`) so shared
 * readers and config builders can treat it like any other provider entry.
 * `enabled` is copied through untouched.
 */
export function toStandardMcpEntry(entry: unknown): Record<string, unknown> {
  const record = isRecord(entry) ? entry : {};
  const { command, args } = splitCommand(record);
  const url = getString(record, 'url');
  const output: Record<string, unknown> = {};
  if (command) output['command'] = command;
  if (args) output['args'] = args;
  if (url) output['url'] = url;
  const headers = getStringRecord(record, 'headers');
  if (headers) output['headers'] = headers;
  const env = getStringRecord(record, 'environment');
  if (env) output['env'] = env;
  if (url || getString(record, 'type') === 'remote') output['transport'] = 'sse';
  const enabled = getBoolean(record, 'enabled');
  if (enabled !== undefined) output['enabled'] = enabled;
  return output;
}
