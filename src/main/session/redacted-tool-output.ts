export const LEGACY_REDACTED_TOOL_OUTPUT = '[REDACTED TOOL OUTPUT]';

export function isLegacyRedactedToolOutput(content: string): boolean {
  return content.trim() === LEGACY_REDACTED_TOOL_OUTPUT;
}
