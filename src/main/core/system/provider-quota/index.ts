/**
 * Provider quota probes — barrel + bootstrap.
 *
 * `registerDefaultQuotaProbes()` is called once during main-process boot
 * (from `ipc-main-handler.ts`) to wire up every available probe. New probes
 * (codex, gemini, copilot) are added here as they're implemented.
 */

import { getProviderQuotaService } from '../provider-quota-service';
import { ClaudeUsageEndpointProbe } from './claude-usage-endpoint-probe';
import { CopilotQuotaProbe } from './copilot-quota-probe';
import { CopilotUsageEndpointProbe } from './copilot-usage-endpoint-probe';
import { CodexQuotaProbe } from './codex-quota-probe';
import { CodexUsageEndpointProbe } from './codex-usage-endpoint-probe';
import { CursorUsageSummaryProbe } from './cursor-usage-summary-probe';
import { GeminiQuotaProbe } from './gemini-quota-probe';
import { GeminiUsageEndpointProbe } from './gemini-usage-endpoint-probe';
import { CompositeQuotaProbe } from './composite-quota-probe';
import { FallbackQuotaProbe } from './fallback-quota-probe';
import { UsageMonitorSource } from './usage-monitor-source';

export { ClaudeQuotaProbe } from './claude-quota-probe';
export type {
  ClaudeAuthStatusExec,
  ClaudeQuotaProbeOptions,
} from './claude-quota-probe';

export { ClaudeUsageEndpointProbe, parseUsagePayload } from './claude-usage-endpoint-probe';
export type {
  ClaudeUsageEndpointProbeOptions,
  UsageFetch,
} from './claude-usage-endpoint-probe';

export {
  ClaudeCredentialsReader,
} from './claude-credentials-reader';
export type {
  ClaudeCredentialsReaderOptions,
  ClaudeOAuthCredential,
  CredentialResult,
  CredentialFailureReason,
  SecurityExec,
  CredentialsFileReader,
} from './claude-credentials-reader';

export { UsageMonitorSource } from './usage-monitor-source';
export type { UsageMonitorSourceOptions } from './usage-monitor-source';

export { CompositeQuotaProbe } from './composite-quota-probe';
export { FallbackQuotaProbe } from './fallback-quota-probe';

export { CopilotQuotaProbe } from './copilot-quota-probe';
export type {
  CopilotConfigReader,
  CopilotQuotaProbeOptions,
} from './copilot-quota-probe';

export { CopilotUsageEndpointProbe, parseCopilotInternalUserPayload } from './copilot-usage-endpoint-probe';
export type {
  CopilotAppsReader,
  CopilotUsageEndpointProbeOptions,
  CopilotUsageFetch,
} from './copilot-usage-endpoint-probe';

export { CodexQuotaProbe } from './codex-quota-probe';
export type {
  CodexLoginStatusExec,
  CodexQuotaProbeOptions,
} from './codex-quota-probe';

export { CodexUsageEndpointProbe, parseCodexUsagePayload } from './codex-usage-endpoint-probe';
export type {
  CodexAuthFileReader,
  CodexUsageEndpointProbeOptions,
  CodexUsageFetch,
} from './codex-usage-endpoint-probe';

export { CursorCredentialsReader } from './cursor-credentials-reader';
export type {
  CursorCredentialFailureReason,
  CursorCredentialResult,
  CursorCredentialsReaderOptions,
  CursorSecurityExec,
  CursorSessionCredential,
} from './cursor-credentials-reader';

export { CursorUsageSummaryProbe, parseCursorUsageSummaryPayload } from './cursor-usage-summary-probe';
export type {
  CursorUsageFetch,
  CursorUsageSummaryProbeOptions,
} from './cursor-usage-summary-probe';

export { GeminiQuotaProbe } from './gemini-quota-probe';
export type {
  GeminiFileReader,
  GeminiQuotaProbeOptions,
} from './gemini-quota-probe';

export { GeminiUsageEndpointProbe, parseGeminiQuotaPayload } from './gemini-usage-endpoint-probe';
export type {
  GeminiQuotaFetch,
  GeminiQuotaFileReader,
  GeminiTokenRefreshFetch,
  GeminiUsageEndpointProbeOptions,
} from './gemini-usage-endpoint-probe';

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
  // One shared reader for the optional standalone-monitor state.json so the
  // composite wrappers don't each stat/read the file independently.
  const usageMonitor = new UsageMonitorSource();

  // Claude: the OAuth usage endpoint is the source of truth for numerical
  // windows (5-hour / weekly / per-model / overage credits). The older
  // auth-status `ClaudeQuotaProbe` is retained as a utility but no longer the
  // registered probe — the endpoint also reports login state (401 ⇒ signed out).
  //
  // Each native probe is wrapped in a CompositeQuotaProbe so that, when the
  // standalone token-usage-monitor is running, its `state.json` fills any
  // windows the native poll can't populate yet (Codex live WS, etc.). The
  // native poll always wins when it has real windows.
  service.registerProbe(new CompositeQuotaProbe(new ClaudeUsageEndpointProbe(), usageMonitor));
  service.registerProbe(new CompositeQuotaProbe(
    new FallbackQuotaProbe(new CopilotUsageEndpointProbe(), new CopilotQuotaProbe()),
    usageMonitor,
  ));
  service.registerProbe(new CompositeQuotaProbe(
    new FallbackQuotaProbe(new CodexUsageEndpointProbe(), new CodexQuotaProbe()),
    usageMonitor,
  ));
  service.registerProbe(new CompositeQuotaProbe(
    new FallbackQuotaProbe(new GeminiUsageEndpointProbe(), new GeminiQuotaProbe()),
    usageMonitor,
  ));
  service.registerProbe(new CompositeQuotaProbe(new CursorUsageSummaryProbe(), usageMonitor));
}
