import {
  applyAcpSessionConfig,
  parseAcpConfigOptions,
  planConfigOptionWrite,
  type AcpSessionConfigKey,
  type AcpSessionConfigOutcome,
  type AcpSessionConfigRequest,
  type AcpSetConfigOption,
} from './acp-session-config-options';
import { getLogger } from '../../logging/logger';

const logger = getLogger('AcpCliAdapter');

/** Live configuration requires a running session with no undispatched preparing turn. */
export function assertAcpLiveSessionConfigReady(running: boolean, preparing: boolean): void {
  if (!running) throw new Error('ACP session is not running.');
  if (preparing) throw new Error('Cannot switch ACP session configuration while a prompt is preparing; respawn is required.');
}

/** Apply ordered writes, then confirm against the latest authoritative native selection. */
export async function applyConfirmedAcpLiveSessionConfig(
  getPrevious: () => AcpSessionConfigRequest | undefined,
  requested: AcpSessionConfigRequest,
  setConfigOption: AcpSetConfigOption,
  getCurrentOptions: () => unknown,
  adapter: string,
): Promise<AcpSessionConfigRequest> {
  const outcome = await applyAcpSessionConfig(setConfigOption, getCurrentOptions(), requested, getCurrentOptions);
  const confirmed = confirmAcpLiveSessionConfig(getPrevious(), requested, getCurrentOptions(), outcome);
  if (outcome.warnings.length > 0) {
    logger.warn('ACP live session config not fully applied', { adapter, warningCount: outcome.warnings.length });
  }
  return confirmed;
}

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
