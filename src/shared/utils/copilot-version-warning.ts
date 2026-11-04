export const COPILOT_TOOL_STALL_WARNING = 'Copilot below 1.0.100 may stall for minutes on a hung tool server.';

/** Numeric semver comparison. Unknown versions do not masquerade as a measured old install. */
export function copilotVersionWarning(version: string | undefined): string | undefined {
  const match = version?.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([^+\s]+))?(?:\+[^\s]+)?$/);
  if (!match) return undefined;
  const installed = match.slice(1, 4).map(Number), fixed = [1, 0, 100];
  for (let i = 0; i < fixed.length; i++) {
    if (installed[i] < fixed[i]) return COPILOT_TOOL_STALL_WARNING;
    if (installed[i] > fixed[i]) return undefined;
  }
  return match[4] ? COPILOT_TOOL_STALL_WARNING : undefined;
}
