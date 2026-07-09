import {
  OrchestratorToolsRpcClient,
  type OrchestratorToolsRpcClientLike,
} from './orchestrator-tools-rpc-client';
import type {
  SettingsToolGetResult,
  SettingsToolListResult,
  SettingsToolSetResult,
} from './orchestrator-settings-tools';

export interface SettingsCliDeps {
  client?: OrchestratorToolsRpcClientLike;
  stdout?: (text: string) => void;
}

interface ParsedCommand<TPayload extends Record<string, unknown>> {
  json: boolean;
  payload: TPayload;
}

const SETTINGS_METHODS = {
  list: 'orchestrator_tools.settings.privileged_list',
  get: 'orchestrator_tools.settings.privileged_get',
  set: 'orchestrator_tools.settings.privileged_set',
  reset: 'orchestrator_tools.settings.privileged_reset',
} as const;

export async function runSettingsCli(
  argv: readonly string[],
  deps: SettingsCliDeps = {},
): Promise<void> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    stdout(formatSettingsHelp());
    return;
  }

  const client = deps.client ?? new OrchestratorToolsRpcClient({ timeoutMs: 10_000 });
  switch (command) {
    case 'list': {
      const parsed = parseListArgs(argv.slice(1));
      const result = await client.call(SETTINGS_METHODS.list, parsed.payload);
      const checked = assertSettingsListResult(result);
      stdout(parsed.json
        ? `${JSON.stringify(checked, null, 2)}\n`
        : formatSettingsListTable(checked));
      return;
    }
    case 'get': {
      const parsed = parseKeyArgs(argv.slice(1), 'get');
      const result = await client.call(SETTINGS_METHODS.get, parsed.payload);
      const checked = assertSettingsGetResult(result);
      stdout(parsed.json
        ? `${JSON.stringify(checked, null, 2)}\n`
        : formatSettingsGet(checked));
      return;
    }
    case 'set': {
      const parsed = parseSetArgs(argv.slice(1));
      const result = await client.call(SETTINGS_METHODS.set, parsed.payload);
      const checked = assertSettingsMutationResult(result);
      stdout(parsed.json
        ? `${JSON.stringify(checked, null, 2)}\n`
        : formatSettingsMutation(checked));
      return;
    }
    case 'reset': {
      const parsed = parseKeyArgs(argv.slice(1), 'reset');
      const result = await client.call(SETTINGS_METHODS.reset, parsed.payload);
      const checked = assertSettingsMutationResult(result);
      stdout(parsed.json
        ? `${JSON.stringify(checked, null, 2)}\n`
        : formatSettingsMutation(checked));
      return;
    }
    default:
      throw new Error(`Unknown settings command: ${command}`);
  }
}

export function formatSettingsListTable(result: SettingsToolListResult): string {
  if (result.settings.length === 0) {
    return 'No settings matched.\n';
  }
  const rows = result.settings.map((setting) => [
    String(setting.key),
    formatCliValue(setting.value),
    setting.policyTier,
    setting.writable ? 'yes' : 'no',
    setting.restartRequired ? 'yes' : 'no',
    setting.category,
  ]);
  return [
    `Settings: ${result.count}`,
    formatTable(['Key', 'Value', 'Policy', 'Writable', 'Restart', 'Category'], rows),
    '',
  ].join('\n');
}

function formatSettingsGet(result: SettingsToolGetResult): string {
  return [
    `${String(result.key)}: ${formatCliValue(result.value)}`,
    `policy=${result.policyTier} writable=${result.writable ? 'yes' : 'no'} `
      + `restartRequired=${result.restartRequired ? 'yes' : 'no'}`,
    '',
  ].join('\n');
}

function formatSettingsMutation(result: SettingsToolSetResult): string {
  return [
    `ok key=${String(result.key)} restartRequired=${result.restartRequired ? 'yes' : 'no'}`,
    `oldValue=${formatCliValue(result.oldValue)}`,
    `newValue=${formatCliValue(result.newValue)}`,
    '',
  ].join('\n');
}

function parseListArgs(argv: readonly string[]): ParsedCommand<{
  category?: string;
  all?: boolean;
}> {
  let json = false;
  let all = false;
  let category: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--all') {
      all = true;
    } else if (arg === '--category') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--category requires a value');
      }
      category = value;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      throw new Error('Use `aio-mcp settings --help` for settings command help');
    } else if (arg?.startsWith('--')) {
      throw new Error(`Unknown settings option: ${arg}`);
    } else {
      throw new Error(`Unexpected settings list argument: ${arg}`);
    }
  }
  return { json, payload: { ...(category ? { category } : {}), ...(all ? { all } : {}) } };
}

function parseKeyArgs(
  argv: readonly string[],
  command: 'get' | 'reset',
): ParsedCommand<{ key: string }> {
  let json = false;
  let key: string | undefined;
  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      throw new Error('Use `aio-mcp settings --help` for settings command help');
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown settings option: ${arg}`);
    } else if (!key) {
      key = arg;
    } else {
      throw new Error(`Unexpected settings ${command} argument: ${arg}`);
    }
  }
  if (!key) {
    throw new Error(`settings ${command} requires <key>`);
  }
  return { json, payload: { key } };
}

function parseSetArgs(argv: readonly string[]): ParsedCommand<{
  key: string;
  value: unknown;
}> {
  let json = false;
  const positionals: string[] = [];
  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      throw new Error('Use `aio-mcp settings --help` for settings command help');
    } else if (arg.startsWith('--') && positionals.length !== 1) {
      throw new Error(`Unknown settings option: ${arg}`);
    } else if (positionals.length < 2) {
      positionals.push(arg);
    } else {
      throw new Error(`Unexpected settings set argument: ${arg}`);
    }
  }
  const [key, rawValue] = positionals;
  if (!key || rawValue === undefined) {
    throw new Error('settings set requires <key> <json-value>');
  }
  return { json, payload: { key, value: parseJsonFirst(rawValue) } };
}

function parseJsonFirst(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function assertSettingsListResult(value: unknown): SettingsToolListResult {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { settings?: unknown }).settings)) {
    throw new Error('privileged_list returned an invalid result');
  }
  const result = value as Partial<SettingsToolListResult>;
  for (const item of result.settings ?? []) {
    assertSettingsListItem(item);
  }
  return {
    count: typeof result.count === 'number' ? result.count : result.settings?.length ?? 0,
    settings: result.settings ?? [],
  };
}

function assertSettingsGetResult(value: unknown): SettingsToolGetResult {
  if (!isObjectRecord(value) ||
    typeof value['key'] !== 'string' ||
    !hasOwn(value, 'value') ||
    typeof value['restartRequired'] !== 'boolean' ||
    typeof value['writable'] !== 'boolean' ||
    !isSettingsPolicyTier(value['policyTier'])) {
    throw new Error('privileged_get returned an invalid result');
  }
  return {
    key: value['key'] as SettingsToolGetResult['key'],
    value: value['value'],
    restartRequired: value['restartRequired'],
    writable: value['writable'],
    policyTier: value['policyTier'],
  };
}

function assertSettingsMutationResult(value: unknown): SettingsToolSetResult {
  if (!isObjectRecord(value) ||
    value['ok'] !== true ||
    typeof value['key'] !== 'string' ||
    !hasOwn(value, 'oldValue') ||
    !hasOwn(value, 'newValue') ||
    typeof value['restartRequired'] !== 'boolean') {
    throw new Error('settings mutation returned an invalid result');
  }
  return {
    ok: true,
    key: value['key'] as SettingsToolSetResult['key'],
    oldValue: value['oldValue'],
    newValue: value['newValue'],
    restartRequired: value['restartRequired'],
  };
}

function assertSettingsListItem(value: unknown): asserts value is SettingsToolListResult['settings'][number] {
  if (!isObjectRecord(value) ||
    typeof value['key'] !== 'string' ||
    !hasOwn(value, 'value') ||
    !hasOwn(value, 'defaultValue') ||
    typeof value['type'] !== 'string' ||
    typeof value['category'] !== 'string' ||
    typeof value['writable'] !== 'boolean' ||
    typeof value['restartRequired'] !== 'boolean' ||
    typeof value['description'] !== 'string' ||
    !isSettingsPolicyTier(value['policyTier'])) {
    throw new Error('privileged_list returned an invalid result');
  }
}

function isSettingsPolicyTier(value: unknown): value is SettingsToolListResult['settings'][number]['policyTier'] {
  return value === 'open' || value === 'read-only' || value === 'secret';
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function formatCliValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

function formatSettingsHelp(): string {
  return [
    'Usage: aio-mcp settings <command>',
    '',
    'Commands:',
    '  list [--json] [--category <category>] [--all]',
    '  get <key> [--json]',
    '  set <key> <json-value> [--json]',
    '  reset <key> [--json]',
    '',
  ].join('\n');
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)));
  const lines = [
    formatRow(headers, widths),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...rows.map((row) => formatRow(row, widths)),
  ];
  return lines.join('\n');
}

function formatRow(values: string[], widths: number[]): string {
  return values
    .map((value, index) => value.padEnd(widths[index] ?? value.length))
    .join('  ');
}
