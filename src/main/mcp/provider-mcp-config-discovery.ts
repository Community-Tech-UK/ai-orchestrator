import * as fsp from 'fs/promises';
import * as path from 'path';
import { constants as fsConstants } from 'fs';
import { createHash } from 'crypto';
import type { McpServerConfig, McpServerSourceEntry } from '../../shared/types/mcp.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('ProviderMcpConfigDiscovery');

type ProviderName = NonNullable<McpServerConfig['sourceProvider']>;

interface JsonMcpConfigFile {
  mcpServers?: Record<string, unknown>;
  mcp_servers?: Record<string, unknown>;
  orchDisabledMcpServers?: Record<string, unknown>;
  mcp?: {
    allowed?: unknown;
    excluded?: unknown;
  };
  projects?: Record<string, unknown>;
}

interface DiscoveredJsonSource {
  provider: ProviderName;
  label: string;
  filePath: string;
  scope?: string;
  servers: Record<string, unknown>;
  disabled?: boolean;
  excludedNames?: Set<string>;
}

interface TomlServerDraft {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  enabled?: boolean;
}

const DISABLED_JSON_BUCKET = 'orchDisabledMcpServers';
const writtenBackupPaths = new Set<string>();

function homeDir(): string {
  return process.env['HOME'] || process.env['USERPROFILE'] || '';
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

function getStringArray(value: unknown, key: string): string[] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  if (!Array.isArray(candidate)) {
    return undefined;
  }
  const strings = candidate.filter((item): item is string => typeof item === 'string');
  return strings.length === candidate.length ? strings : undefined;
}

function getBoolean(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return typeof candidate === 'boolean' ? candidate : undefined;
}

function getStringSet(value: unknown): Set<string> {
  if (!Array.isArray(value)) {
    return new Set();
  }
  return new Set(value.filter((item): item is string => typeof item === 'string'));
}

function redactEnv(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.keys(value).map((key) => [key, '[redacted]'] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || value;
}

function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 8);
}

function externalId(provider: ProviderName, filePath: string, scope: string | undefined, name: string): string {
  const safeName = name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
  return `external:${provider}:${shortHash(`${filePath}:${scope ?? ''}:${name}`)}:${safeName}`;
}

function externalGroupId(name: string): string {
  const safeName = name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
  return `external-group:${shortHash(name.toLowerCase())}:${safeName}`;
}

function normalizeTransport(raw: unknown): McpServerConfig['transport'] {
  const explicit = getString(raw, 'transport') || getString(raw, 'type');
  if (explicit === 'stdio' || explicit === 'http' || explicit === 'sse') {
    return explicit;
  }
  return getString(raw, 'url') || getString(raw, 'httpUrl') ? 'sse' : 'stdio';
}

function serverEnabled(
  raw: unknown,
  name: string,
  source: Pick<DiscoveredJsonSource, 'disabled' | 'excludedNames'>,
): boolean {
  if (source.disabled) {
    return false;
  }
  if (source.excludedNames?.has(name)) {
    return false;
  }
  if (getBoolean(raw, 'enabled') === false || getBoolean(raw, 'disabled') === true) {
    return false;
  }
  return true;
}

function createServerConfig(
  provider: ProviderName,
  label: string,
  filePath: string,
  name: string,
  raw: unknown,
  scope?: string,
  enabled = true,
): McpServerConfig {
  const command = getString(raw, 'command');
  const url = getString(raw, 'url') || getString(raw, 'httpUrl');
  const args = getStringArray(raw, 'args');
  const env = redactEnv(isRecord(raw) ? raw['env'] : undefined);

  return {
    id: externalId(provider, filePath, scope, name),
    name,
    description: `${label} MCP server${scope ? ` (${scope})` : ''}`,
    source: provider === 'orchestrator' ? 'orchestrator-bootstrap' : 'provider-config',
    sourceProvider: provider,
    sourceLabel: label,
    sourcePath: filePath,
    scope,
    readOnly: true,
    toggleable: provider !== 'orchestrator',
    enabled,
    transport: normalizeTransport(raw),
    command,
    args,
    env,
    url,
    autoConnect: false,
    status: 'disconnected',
  };
}

async function readJson(filePath: string): Promise<JsonMcpConfigFile | null> {
  try {
    const content = await fsp.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed as JsonMcpConfigFile : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.debug('Failed to read MCP JSON config', {
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}

function mcpServersFromJson(parsed: JsonMcpConfigFile | null): Record<string, unknown> {
  if (!parsed) {
    return {};
  }
  if (isRecord(parsed.mcpServers)) {
    return parsed.mcpServers;
  }
  if (isRecord(parsed.mcp_servers)) {
    return parsed.mcp_servers;
  }
  return {};
}

function disabledMcpServersFromJson(parsed: JsonMcpConfigFile | null): Record<string, unknown> {
  return parsed && isRecord(parsed.orchDisabledMcpServers) ? parsed.orchDisabledMcpServers : {};
}

function excludedNamesFromJson(parsed: JsonMcpConfigFile | null): Set<string> {
  return getStringSet(parsed?.mcp?.excluded);
}

function projectMcpSources(
  provider: ProviderName,
  label: string,
  filePath: string,
  parsed: JsonMcpConfigFile | null,
): DiscoveredJsonSource[] {
  if (!parsed || !isRecord(parsed.projects)) {
    return [];
  }

  const sources: DiscoveredJsonSource[] = [];
  for (const [projectPath, projectConfig] of Object.entries(parsed.projects)) {
    if (!isRecord(projectConfig)) {
      continue;
    }
    const servers = mcpServersFromJson(projectConfig as JsonMcpConfigFile);
    const disabledServers = disabledMcpServersFromJson(projectConfig as JsonMcpConfigFile);
    if (Object.keys(servers).length > 0) {
      sources.push({
        provider,
        label,
        filePath,
        scope: projectPath,
        servers,
      });
    }
    if (Object.keys(disabledServers).length > 0) {
      sources.push({
        provider,
        label,
        filePath,
        scope: projectPath,
        servers: disabledServers,
        disabled: true,
      });
    }
  }
  return sources;
}

async function discoverJsonSources(): Promise<DiscoveredJsonSource[]> {
  const home = homeDir();
  if (!home) {
    return [];
  }

  const sourceDefs: Array<{ provider: ProviderName; label: string; filePath: string; includeProjects?: boolean }> = [
    { provider: 'claude', label: 'Claude user config', filePath: path.join(home, '.claude.json'), includeProjects: true },
    { provider: 'claude', label: 'Claude settings', filePath: path.join(home, '.claude', 'settings.json') },
    { provider: 'claude', label: 'Claude settings', filePath: path.join(home, '.config', 'claude', 'settings.json') },
    { provider: 'gemini', label: 'Gemini settings', filePath: path.join(home, '.gemini', 'settings.json') },
    { provider: 'copilot', label: 'Copilot MCP config', filePath: path.join(home, '.copilot', 'mcp-config.json') },
  ];

  const sources: DiscoveredJsonSource[] = [];
  for (const def of sourceDefs) {
    const parsed = await readJson(def.filePath);
    const servers = mcpServersFromJson(parsed);
    const disabledServers = disabledMcpServersFromJson(parsed);
    const excludedNames = excludedNamesFromJson(parsed);
    if (Object.keys(servers).length > 0) {
      sources.push({
        provider: def.provider,
        label: def.label,
        filePath: def.filePath,
        servers,
        excludedNames,
      });
    }
    if (Object.keys(disabledServers).length > 0) {
      sources.push({
        provider: def.provider,
        label: def.label,
        filePath: def.filePath,
        servers: disabledServers,
        disabled: true,
      });
    }
    if (def.includeProjects) {
      sources.push(...projectMcpSources(def.provider, def.label, def.filePath, parsed));
    }
  }

  for (const bootstrapPath of resolveOrchestratorBootstrapPaths()) {
    const parsed = await readJson(bootstrapPath);
    const servers = mcpServersFromJson(parsed);
    if (Object.keys(servers).length > 0) {
      sources.push({
        provider: 'orchestrator',
        label: 'Orchestrator bootstrap',
        filePath: bootstrapPath,
        servers,
      });
      break;
    }
  }

  return sources;
}

function resolveOrchestratorBootstrapPaths(): string[] {
  const resourcesPath = process.resourcesPath;
  return unique([
    ...(resourcesPath ? [path.join(resourcesPath, 'config', 'mcp-servers.json')] : []),
    path.resolve(__dirname, '../../../config/mcp-servers.json'),
    path.resolve(process.cwd(), 'config/mcp-servers.json'),
  ]);
}

function parseTomlString(value: string): string | undefined {
  const trimmed = value.trim();
  const doubleQuoted = trimmed.match(/^"((?:\\.|[^"\\])*)"/);
  if (doubleQuoted) {
    return doubleQuoted[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  const singleQuoted = trimmed.match(/^'([^']*)'/);
  return singleQuoted?.[1];
}

function parseTomlStringArray(value: string): string[] | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return undefined;
  }
  const matches = Array.from(trimmed.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'/g));
  return matches.map((match) => (match[1] ?? match[2] ?? '').replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
}

function parseTomlBoolean(value: string): boolean | undefined {
  const trimmed = value.trim();
  if (trimmed === 'true') {
    return true;
  }
  if (trimmed === 'false') {
    return false;
  }
  return undefined;
}

function parseCodexMcpServersToml(content: string): TomlServerDraft[] {
  const drafts = new Map<string, TomlServerDraft>();
  let currentServer: TomlServerDraft | null = null;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const section = trimmed.match(/^\[mcp_servers\.([^\].]+)(?:\.[^\]]+)?\]$/);
    if (section) {
      const serverName = section[1].replace(/^"|"$/g, '');
      const isNestedSection = trimmed.slice('[mcp_servers.'.length, -1).includes('.');
      const draft = drafts.get(serverName) ?? { name: serverName };
      currentServer = isNestedSection ? null : draft;
      if (!isNestedSection) {
        drafts.set(serverName, draft);
      }
      continue;
    }

    if (!currentServer) {
      continue;
    }

    const assignment = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!assignment) {
      continue;
    }
    const [, key, rawValue] = assignment;
    if (key === 'command') {
      currentServer.command = parseTomlString(rawValue);
    } else if (key === 'url') {
      currentServer.url = parseTomlString(rawValue);
    } else if (key === 'args') {
      currentServer.args = parseTomlStringArray(rawValue);
    } else if (key === 'enabled') {
      currentServer.enabled = parseTomlBoolean(rawValue);
    }
  }

  return Array.from(drafts.values());
}

async function discoverCodexServers(): Promise<McpServerConfig[]> {
  const home = homeDir();
  if (!home) {
    return [];
  }

  const filePath = path.join(home, '.codex', 'config.toml');
  let content: string;
  try {
    content = await fsp.readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.debug('Failed to read Codex MCP config', {
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return [];
  }

  return parseCodexMcpServersToml(content).map((server) =>
    createServerConfig(
      'codex',
      'Codex config',
      filePath,
      server.name,
      server,
      undefined,
      server.enabled !== false,
    )
  );
}

export async function discoverProviderMcpServers(): Promise<McpServerConfig[]> {
  const [jsonSources, codexServers] = await Promise.all([
    discoverJsonSources(),
    discoverCodexServers(),
  ]);

  const servers: McpServerConfig[] = [
    ...jsonSources.flatMap((source) =>
      Object.entries(source.servers).map(([name, raw]) =>
        createServerConfig(
          source.provider,
          source.label,
          source.filePath,
          name,
          raw,
          source.scope,
          serverEnabled(raw, name, source),
        )
      )
    ),
    ...codexServers,
  ];

  return collapseDuplicateServers(servers);
}

function toSourceEntry(server: McpServerConfig): McpServerSourceEntry {
  return {
    id: server.id,
    name: server.name,
    sourceProvider: server.sourceProvider,
    sourceLabel: server.sourceLabel,
    sourcePath: server.sourcePath,
    scope: server.scope,
    enabled: server.enabled !== false,
    readOnly: server.readOnly,
  };
}

function updateSourceSummary(server: McpServerConfig): void {
  const sourceEntries = server.sourceEntries ?? [toSourceEntry(server)];
  const enabledSourceCount = sourceEntries.filter((source) => source.enabled).length;
  server.sourceEntries = sourceEntries;
  server.sourceCount = sourceEntries.length;
  server.enabledSourceCount = enabledSourceCount;
  server.enabled = enabledSourceCount > 0;
  server.sourceSummary = sourceEntries.length === 1
    ? sourceEntries[0].sourceLabel ?? 'Provider config'
    : `${sourceEntries.length} sources, ${enabledSourceCount} enabled`;
  server.description = sourceEntries.length === 1
    ? server.description
    : `${server.name} MCP server configured in ${sourceEntries.length} places.`;
}

function collapseDuplicateServers(servers: McpServerConfig[]): McpServerConfig[] {
  const groups = new Map<string, McpServerConfig>();

  for (const server of servers) {
    server.name = server.name || titleCase(server.id);
    const key = server.name.toLowerCase();
    const existing = groups.get(key);
    if (!existing) {
      const grouped = {
        ...server,
        id: externalGroupId(server.name),
        sourceEntries: [toSourceEntry(server)],
      };
      updateSourceSummary(grouped);
      groups.set(key, grouped);
      continue;
    }

    existing.sourceEntries = [...(existing.sourceEntries ?? []), toSourceEntry(server)];
    updateSourceSummary(existing);
  }

  return Array.from(groups.values());
}

async function writeFileWithBackup(filePath: string, content: string): Promise<void> {
  const stat = await fsp.stat(filePath);
  const backupPath = `${filePath}.orch-bak`;
  if (!writtenBackupPaths.has(filePath)) {
    try {
      await fsp.copyFile(filePath, backupPath, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    writtenBackupPaths.add(filePath);
  }

  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tempPath, content, { mode: stat.mode });
  await fsp.rename(tempPath, filePath);
}

function getJsonScopeContainer(
  parsed: JsonMcpConfigFile,
  scope?: string,
): JsonMcpConfigFile | null {
  if (!scope) {
    return parsed;
  }
  if (!isRecord(parsed.projects)) {
    return null;
  }
  const project = parsed.projects[scope];
  return isRecord(project) ? project as JsonMcpConfigFile : null;
}

function ensureRecordContainer(target: JsonMcpConfigFile, key: 'mcpServers' | typeof DISABLED_JSON_BUCKET): Record<string, unknown> {
  const existing = target[key];
  if (isRecord(existing)) {
    return existing;
  }
  const created: Record<string, unknown> = {};
  target[key] = created;
  return created;
}

function removeFromStringArray(value: unknown, name: string): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item !== name)
    : [];
}

function setGeminiExcluded(parsed: JsonMcpConfigFile, name: string, enabled: boolean): void {
  const mcp = isRecord(parsed.mcp) ? parsed.mcp : {};
  const current = removeFromStringArray(mcp.excluded, name);
  mcp.excluded = enabled ? current : unique([...current, name]);
  parsed.mcp = mcp;
}

async function setJsonMcpServerEnabled(source: McpServerSourceEntry, enabled: boolean): Promise<void> {
  if (!source.sourcePath || !source.name) {
    throw new Error('MCP source is missing its config path or server name.');
  }

  const content = await fsp.readFile(source.sourcePath, 'utf-8');
  const parsed = JSON.parse(content) as JsonMcpConfigFile;
  const container = getJsonScopeContainer(parsed, source.scope);
  if (!container) {
    throw new Error(`MCP config scope not found: ${source.scope ?? 'user'}`);
  }

  const activeServers = ensureRecordContainer(container, 'mcpServers');
  const disabledServers = ensureRecordContainer(container, DISABLED_JSON_BUCKET);

  if (source.sourceProvider === 'gemini') {
    if (enabled && Object.prototype.hasOwnProperty.call(disabledServers, source.name)) {
      activeServers[source.name] = disabledServers[source.name];
      delete disabledServers[source.name];
    }
    setGeminiExcluded(parsed, source.name, enabled);
    if (Object.keys(disabledServers).length === 0) {
      delete container.orchDisabledMcpServers;
    }
    await writeFileWithBackup(source.sourcePath, `${JSON.stringify(parsed, null, 2)}\n`);
    return;
  }

  if (enabled && Object.prototype.hasOwnProperty.call(disabledServers, source.name)) {
    activeServers[source.name] = disabledServers[source.name];
    delete disabledServers[source.name];
  } else if (!enabled && Object.prototype.hasOwnProperty.call(activeServers, source.name)) {
    disabledServers[source.name] = activeServers[source.name];
    delete activeServers[source.name];
  }

  if (Object.keys(disabledServers).length === 0) {
    delete container.orchDisabledMcpServers;
  }

  await writeFileWithBackup(source.sourcePath, `${JSON.stringify(parsed, null, 2)}\n`);
}

function codexSectionName(rawName: string): string {
  return rawName.replace(/^"|"$/g, '');
}

function codexSectionHeader(line: string): { name: string; nested: boolean } | null {
  const section = line.trim().match(/^\[mcp_servers\.([^\].]+)(?:\.[^\]]+)?\]$/);
  if (!section) {
    return null;
  }
  return {
    name: codexSectionName(section[1]),
    nested: line.trim().slice('[mcp_servers.'.length, -1).includes('.'),
  };
}

async function setCodexMcpServerEnabled(source: McpServerSourceEntry, enabled: boolean): Promise<void> {
  if (!source.sourcePath || !source.name) {
    throw new Error('Codex MCP source is missing its config path or server name.');
  }

  const content = await fsp.readFile(source.sourcePath, 'utf-8');
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const header = codexSectionHeader(line);
    return header?.name === source.name && !header.nested;
  });
  if (start === -1) {
    throw new Error(`Codex MCP server not found: ${source.name}`);
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trim().startsWith('[')) {
      end = index;
      break;
    }
  }

  const enabledLine = `enabled = ${enabled ? 'true' : 'false'}`;
  const existing = lines
    .slice(start + 1, end)
    .findIndex((line) => line.trim().startsWith('enabled ='));
  if (existing === -1) {
    lines.splice(start + 1, 0, enabledLine);
  } else {
    lines[start + 1 + existing] = enabledLine;
  }

  await writeFileWithBackup(source.sourcePath, lines.join('\n'));
}

export async function setProviderMcpServerEnabled(serverId: string, enabled: boolean): Promise<void> {
  const servers = await discoverProviderMcpServers();
  const server = servers.find((candidate) =>
    candidate.id === serverId || candidate.sourceEntries?.some((source) => source.id === serverId)
  );
  if (!server) {
    throw new Error(`Provider MCP server not found: ${serverId}`);
  }

  const sources = server.sourceEntries ?? [toSourceEntry(server)];
  for (const source of sources) {
    if (!source.sourcePath || source.sourceProvider === 'orchestrator') {
      continue;
    }
    if (source.sourceProvider === 'codex') {
      await setCodexMcpServerEnabled(source, enabled);
    } else {
      await setJsonMcpServerEnabled(source, enabled);
    }
  }
}
