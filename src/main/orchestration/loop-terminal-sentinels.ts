/** Number of physical output lines eligible to carry a terminal declaration. */
export const TERMINAL_OUTPUT_WINDOW_LINES = 12;

export const CLEAN_REVIEW_SENTINEL = '[[LOOP:CLEAN_REVIEW]]';

/**
 * Match a terminal protocol token only when it occupies a complete line near
 * the end of the agent output. This prevents prompt echoes and prose that
 * merely discusses a token from being interpreted as loop control.
 */
export function matchesTerminalOutputPattern(
  output: string,
  patternSource: string,
  flags = '',
): boolean {
  if (typeof output !== 'string' || !output.trim() || !patternSource.trim()) return false;
  const safeFlags = flags.replace(/[dgmy]/g, '');
  const pattern = new RegExp(`^(?:${patternSource})$`, safeFlags);
  const terminalLines = output.trimEnd().split(/\r?\n/).slice(-TERMINAL_OUTPUT_WINDOW_LINES);
  return terminalLines.some((line) => pattern.test(line.trim()));
}

export function hasTerminalSentinelLine(output: string, sentinel: string): boolean {
  const escaped = sentinel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return matchesTerminalOutputPattern(output, escaped);
}
