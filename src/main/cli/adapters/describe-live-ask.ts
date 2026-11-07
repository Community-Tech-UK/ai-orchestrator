const sensitiveKey = /token|secret|password|key|authorization/i;
const shorten = (value: string): string => value.length > 80 ? value.slice(0, 79) + '…' : value;

function safeValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '…';
  if (typeof value === 'string') return shorten(value);
  if (Array.isArray(value)) return value.slice(0, 10).map(item => safeValue(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 20)
    .map(([key, item]) => [shorten(key), sensitiveKey.test(key) ? 'hidden' : safeValue(item, depth + 1)]));
  return value;
}

/** Display text only. Permission resource matching always uses the original unabridged input. */
export function describeLiveAsk(toolName: string, input: Record<string, unknown>, agentId?: string): string {
  const prefix = agentId ? 'A subagent wants to ' : 'Claude wants to ';
  const target = input['file_path'] ?? input['notebook_path'] ?? input['path'];
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    return `${prefix}${toolName === 'Read' ? 'read' : 'edit'} ${String(target ?? 'a file')}`;
  }
  if (toolName === 'WebFetch') return `${prefix}fetch ${String(input['url'] ?? 'a web page')}`;
  if (toolName === 'WebSearch') return `${prefix}search the web for ${String(input['query'] ?? '')}`;
  if (toolName === 'SandboxNetworkAccess') return `${prefix}use network access to ${String(input['host'] ?? 'a host')}`;
  const connector = /^mcp__(.+?)__(.+)$/.exec(toolName);
  const name = connector ? `${connector[1]} > ${connector[2]}` : toolName;
  const args = Object.entries(input).slice(0, 20).map(([key, value]) =>
    `${shorten(key)}: ${sensitiveKey.test(key) ? 'hidden' : shorten(typeof value === 'string' ? value : JSON.stringify(safeValue(value)) ?? '')}`);
  return `${prefix}use ${name}${args.length ? ` (${args.join(', ')})` : ''}`;
}
