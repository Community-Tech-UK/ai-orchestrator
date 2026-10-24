import { parseTOML, type AST } from 'toml-eslint-parser';

/** These Claude callbacks cannot deliver a continuation to a Codex session. */
const CALLBACK_TOOLS = [
  'Monitor', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger',
  'Workflow', 'PushNotification', 'SendMessage', 'ListAgents', 'TaskStop',
];

interface Property {
  node: AST.TOMLKeyValue;
  relativeKey: string[];
  inline: boolean;
}

type ServerProperties = Map<string, Property>;
interface Edit { start: number; end: number; text: string; }

function keyParts(key: AST.TOMLKey): string[] {
  return key.keys.map((part) => part.type === 'TOMLBare' ? part.name : part.value);
}

/** Use parser-decoded leaves, never whole-object conversion of untrusted keys. */
function stringValue(value: AST.TOMLContentNode | undefined): string | undefined {
  return value?.type === 'TOMLValue' && value.kind === 'string' ? value.value : undefined;
}

function stringArray(value: AST.TOMLContentNode | undefined): string[] | undefined {
  if (value?.type !== 'TOMLArray') return undefined;
  const result: string[] = [];
  for (const element of value.elements) {
    const text = stringValue(element);
    if (text === undefined) return undefined;
    result.push(text);
  }
  return result;
}

function collectServers(program: AST.TOMLProgram): Map<string, ServerProperties> {
  const servers = new Map<string, ServerProperties>();
  const visit = (node: AST.TOMLKeyValue, base: (string | number)[], inline: boolean): void => {
    const relativeKey = keyParts(node.key);
    const path = [...base, ...relativeKey];
    if (path.length === 3 && path[0] === 'mcp_servers' && typeof path[1] === 'string' && typeof path[2] === 'string') {
      let server = servers.get(path[1]);
      if (!server) { server = new Map<string, Property>(); servers.set(path[1], server); }
      server.set(path[2], { node, relativeKey, inline });
    }
    if (node.value.type === 'TOMLInlineTable') {
      for (const child of node.value.body) visit(child, path, true);
    }
  };
  for (const entry of program.body[0].body) {
    if (entry.type === 'TOMLTable') {
      for (const node of entry.body) visit(node, entry.resolvedKey, false);
    } else visit(entry, [], false);
  }
  return servers;
}

/** Narrow only Claude's callback tools, retaining every other source range verbatim. */
export function disableClaudeCallbackTools(config: string): string {
  const edits: Edit[] = [];
  const newline = config.includes('\r\n') ? '\r\n' : '\n';
  // Codex 0.164 accepts TOML 1.1, including multiline inline tables and \x escapes.
  for (const server of collectServers(parseTOML(config, { tomlVersion: '1.1' })).values()) {
    const command = server.get('command');
    const executable = stringValue(command?.node.value)?.split(/[\\/]/).pop();
    if (!command || !executable || !/^claude(?:\.(?:exe|cmd|bat))?$/i.test(executable)) continue;
    const args = stringArray(server.get('args')?.node.value);
    if (!args?.some((arg, index) => arg === 'mcp' && args[index + 1] === 'serve')) continue;
    const disabled = server.get('disabled_tools');
    const existing = disabled ? stringArray(disabled.node.value) : [];
    if (!existing) throw new Error('Expected a string array for Claude disabled_tools');
    const tools = [...new Set([...existing, ...CALLBACK_TOOLS])];
    const array = `[${tools.map((tool) => JSON.stringify(tool)).join(', ')}]`;
    if (disabled) {
      edits.push({ start: disabled.node.value.range[0], end: disabled.node.value.range[1], text: array });
    } else {
      const prefix = command.relativeKey.slice(0, -1).map((part) => /^[A-Za-z0-9_-]+$/.test(part) ? part : JSON.stringify(part));
      const key = [...prefix, 'disabled_tools'].join('.');
      const text = `${key} = ${array}${command.inline ? ', ' : newline}`;
      edits.push({ start: command.node.range[0], end: command.node.range[0], text });
    }
  }
  if (edits.length === 0) return config;
  edits.sort((left, right) => left.start - right.start);
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    parts.push(config.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  parts.push(config.slice(cursor));
  return parts.join('');
}
