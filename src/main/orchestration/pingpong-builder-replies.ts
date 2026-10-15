export interface BuilderFindingReply { id: string; claim: 'fixed' | 'rebutted'; response: string }

export function parseBuilderFindingReplies(output: string, openIds: readonly string[]): BuilderFindingReply[] {
  const allowed = new Set(openIds);
  const replies = new Map<string, BuilderFindingReply>();
  for (const line of output.split('\n')) {
    const match = /^\s*Finding\s+(pp-[a-z0-9]+)\s*:\s*(fixed|rebutted)\s*[-—–]\s*(.+)$/i.exec(line);
    if (!match || !allowed.has(match[1])) continue;
    replies.set(match[1], { id: match[1], claim: match[2].toLowerCase() as 'fixed' | 'rebutted', response: match[3].trim().slice(0, 400) });
  }
  return [...replies.values()];
}
