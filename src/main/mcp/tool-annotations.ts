import type { McpServerToolDefinition } from './mcp-server-tools';

/** Hints only: original permission checks remain authoritative. Unknowns mutate. */
export function defaultToolAnnotations(name: string): NonNullable<McpServerToolDefinition['annotations']> {
  const leaf = name.split('.').at(-1) ?? name;
  const readOnly = /^(?:list_|get_|read_|search_|describe_|query_|measure_|inspect_|check_)/.test(leaf)
    || ['snapshot', 'screenshot', 'health', 'status', 'tool_search', 'tool_describe', 'plan_queue_status'].includes(leaf);
  return { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: true };
}
