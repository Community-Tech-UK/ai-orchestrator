/** Native OpenCode loop requests carry the original tool in rawInput.tool. */
const READ_ONLY_TOOLS = new Set(['read', 'grep', 'glob', 'list', 'lsp']);
const MUTATING_TOOLS = new Set(['bash', 'shell', 'execute', 'edit', 'write', 'apply_patch', 'patch']);

export function isReadOnlyProviderTool(tool: string): boolean {
  return READ_ONLY_TOOLS.has(tool.trim().toLowerCase());
}

export function isMutatingProviderTool(tool: string): boolean {
  return MUTATING_TOOLS.has(tool.trim().toLowerCase());
}

/** Undefined leaves ordinary non-YOLO approval to the existing registry/UI. */
export function resolveAcpAutomaticPermission(
  adapterName: string,
  yoloMode: boolean | undefined,
  toolCall: Record<string, unknown>,
): boolean | undefined {
  if (adapterName === 'opencode-acp' && toolCall['title'] === 'doom_loop') {
    const input = toolCall['rawInput'];
    const tool = input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)['tool']
      : undefined;
    // Missing original-tool identity cannot authorize a repeated mutation.
    return typeof tool === 'string' && isReadOnlyProviderTool(tool);
  }
  return yoloMode === true ? true : undefined;
}

export const DOOM_LOOP_BLOCKED_NOTICE = 'Blocked: identical tool call repeated. Change approach before retrying.';
