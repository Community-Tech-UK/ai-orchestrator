import {
  parseAcpConfigOptions,
  planConfigOptionWrite,
  type AcpSessionConfigKey,
  type AcpSessionConfigOutcome,
  type AcpSessionConfigRequest,
} from './acp-session-config-options';

/** The latest native list is authoritative over any earlier acknowledgment. */
export function isAcpSessionConfigSelected(currentOptions: unknown, key: AcpSessionConfigKey, value: string): boolean {
  if (!Array.isArray(currentOptions)) return false;
  const plan = planConfigOptionWrite(parseAcpConfigOptions(currentOptions), key, value.trim());
  return plan.kind === 'skip' && plan.reason === 'already selected';
}

/** Live changes require both accepted selection provenance and matching latest state. */
export function confirmAcpLiveSessionConfig(
  previous: AcpSessionConfigRequest | undefined,
  requested: AcpSessionConfigRequest,
  currentOptions: unknown,
  outcome: AcpSessionConfigOutcome,
): AcpSessionConfigRequest {
  const confirmed = { ...previous };
  for (const key of ['model', 'effort'] as const) {
    const value = requested[key]?.trim();
    if (!value) continue;
    const hasProvenance = [...outcome.applied, ...(outcome.alreadySelected ?? [])]
      .some((entry) => entry.key === key && entry.value === value);
    const latestMatches = !Array.isArray(currentOptions) || isAcpSessionConfigSelected(currentOptions, key, value);
    if (!hasProvenance || !latestMatches) {
      throw new Error(`The agent did not switch the session ${key}: ${outcome.warnings.join(' ') || 'the latest native selection does not match'}`);
    }
    confirmed[key] = value;
  }
  return confirmed;
}
