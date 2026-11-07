/** "mcp__browser-gateway__browser_health" reads as "browser_health (browser-gateway)"; other tool names pass through. */
export function friendlyToolName(toolName: string): string {
  const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return match ? `${match[2]} (${match[1]})` : toolName;
}
