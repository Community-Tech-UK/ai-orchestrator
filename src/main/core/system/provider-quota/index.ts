/**
 * Provider quota probes — barrel + bootstrap.
 *
 * `registerDefaultQuotaProbes()` is called once during main-process boot
 * (from `ipc-main-handler.ts`) to wire up every available probe. New probes
 * (codex, gemini, copilot) are added here as they're implemented.
 */

import { getProviderQuotaService } from '../provider-quota-service';
import { ClaudeQuotaProbe } from './claude-quota-probe';
import { CopilotQuotaProbe } from './copilot-quota-probe';
import { CodexQuotaProbe } from './codex-quota-probe';
import { GeminiQuotaProbe } from './gemini-quota-probe';

export { ClaudeQuotaProbe } from './claude-quota-probe';
export type {
  ClaudeAuthStatusExec,
  ClaudeQuotaProbeOptions,
} from './claude-quota-probe';

export { CopilotQuotaProbe } from './copilot-quota-probe';
export type {
  CopilotConfigReader,
  CopilotQuotaProbeOptions,
} from './copilot-quota-probe';

export { CodexQuotaProbe } from './codex-quota-probe';
export type {
  CodexLoginStatusExec,
  CodexQuotaProbeOptions,
} from './codex-quota-probe';

export { GeminiQuotaProbe } from './gemini-quota-probe';
export type {
  GeminiFileReader,
  GeminiQuotaProbeOptions,
} from './gemini-quota-probe';

/**
 * Register every default quota probe on the singleton service. Idempotent —
 * subsequent calls overwrite the prior probe for each provider.
 *
 * Probes registered here are passive: they don't run on registration; they
 * run when the renderer calls `quotaRefresh(provider)` or when polling is
 * explicitly enabled via `quotaSetPollInterval(provider, ms)`.
 */
export function registerDefaultQuotaProbes(): void {
  const service = getProviderQuotaService();
  service.registerProbe(new ClaudeQuotaProbe());
  service.registerProbe(new CopilotQuotaProbe());
  service.registerProbe(new CodexQuotaProbe());
  service.registerProbe(new GeminiQuotaProbe());
}
