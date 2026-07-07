/**
 * Provider quota probes — barrel + bootstrap.
 *
 * `registerDefaultQuotaProbes()` is called once during main-process boot
 * (from `ipc-main-handler.ts`) to wire up every available probe. New probes
 * (codex, gemini, copilot) are added here as they're implemented.
 */

import { getCliDetectionService } from '../../../cli/cli-detection';
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
  GeminiLoadCodeAssistFetch,
  GeminiOAuthClientDiscovery,
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

  // Quota is only meaningful for CLIs that exist on this machine. Probes can
  // still find data for absent CLIs (leftover credential files, the shared
  // usage-monitor state.json), so refresh() gates on installation. Provider
  // ids match `CLI_REGISTRY` names 1:1 (the `antigravity` probes report the
  // shared ~/.gemini quota under the `antigravity` provider, whose CLI is
  // `agy`). `detectAll()` caches for 60s, so a CLI installed mid-session is
  // picked up on the next refresh.
  service.setCliInstalledCheck(async (provider) => {
    const detection = await getCliDetectionService().detectAll();
    return detection.detected.some((cli) => cli.name === provider && cli.installed);
  });

  // Claude: the OAuth usage endpoint is the source of truth for numerical
  // windows (5-hour / weekly / per-model / overage credits) and login state
  // (401 ⇒ signed out).
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
