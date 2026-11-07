/** One sentence and number rule for the panel and the near-compaction hint. */
export function autoCompactNotice(used: number, threshold: number): string {
  return `Claude will summarise this conversation in about ${Math.max(0, Math.round((threshold - used) / 1000))}K tokens.`;
}
