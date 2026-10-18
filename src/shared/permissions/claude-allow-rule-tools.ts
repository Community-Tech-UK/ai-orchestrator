/** Claude tools for which Harness can write a provider-native allow rule. */
export const CLAUDE_ALLOW_RULE_TOOLS = ['Write', 'Edit', 'Read', 'Bash'] as const;
export type ClaudeAllowRuleTool = typeof CLAUDE_ALLOW_RULE_TOOLS[number];

export function resolveClaudeAllowRuleTool(toolName: string | undefined): ClaudeAllowRuleTool | undefined {
  const normalized = toolName?.trim().toLowerCase();
  return CLAUDE_ALLOW_RULE_TOOLS.find(tool => tool.toLowerCase() === normalized);
}
