/**
 * WS-C3 — run-readiness checkpoint at the action point.
 *
 * `buildRunReadinessReasons` is a pure aggregator: it turns EXISTING
 * readiness signals (passed in as plain data — no IPC, no new health checks)
 * into a short, deduplicated, severity-ordered list of reasons a compact
 * banner near Run/Send can render. It does not probe anything itself.
 *
 * Signal sourced today: provider CLI health, read from the app-wide
 * `StartupCapabilityReport` that `AppComponent` and `SetupCenterComponent`
 * already pull/subscribe to (`AppIpcService.getStartupCapabilities` /
 * `onStartupCapabilities` — see `run-readiness-banner.component.ts`'s
 * `RunReadinessGate`, which reuses that exact same pull once more; no new IPC
 * channel is introduced).
 *   - `provider.any` === 'unavailable' → no supported provider CLI works at
 *     all → blocking (this is the "dead provider, expensive failed start"
 *     acceptance case: starting an instance would spawn a CLI that can only
 *     fail).
 *   - `provider.<id>` === 'degraded' for the composer's active provider (not
 *     on PATH, or diagnostics failed, or unhealthy) while at least one other
 *     provider is fine → warning, not blocking (the user may still want to
 *     try; switching providers is the remediation, not a hard stop).
 *
 * Deliberately EXCLUDED, with the existing owner noted so this file never
 * grows into a second, disagreeing health system:
 *   - Context/compaction pressure — owned by `ContextWarningComponent`
 *     (`context-warning.component.ts`). It already renders its own banner at
 *     75%/critical/emergency; duplicating that number here would produce two
 *     banners disagreeing about the same context usage.
 *   - Provider quota-park / auth-required `InstanceWaitReason` states —
 *     owned by `ComposerBannersComponent` (`composer-banners.component.ts`).
 *     Sending while parked or signed out is intentional: the message queues
 *     and is replayed once the wait clears (`instance-detail.component.ts`
 *     `onSendMessage` → `InstanceStore.sendInput`), so these are not
 *     readiness *failures* and must not gate Send.
 *   - A dead/unresumable session (`status === 'error' && recoveryMethod ===
 *     'failed'`) — already has its own inline recovery banner in
 *     `instance-detail.component.html`.
 *   - Missing workspace and cost-spike checks — surveyed and NOT found as an
 *     existing renderer-visible signal anywhere in the app (only a
 *     main-process-internal `directoryExists()` guard used by warm-start,
 *     and no spend/cost estimator for a pending send). Adding either would
 *     be a NEW health check, which this aggregator explicitly must not do.
 *     Left as a known gap for a future work slice once such a signal exists.
 */

import type { InstanceProvider } from '../../core/state/instance/instance.types';
import type { StartupCapabilityReport } from '../../../../shared/types/startup-capability.types';

export type RunReadinessSeverity = 'info' | 'warning' | 'blocking';

export interface RunReadinessAction {
  label: string;
  /** Dispatched via `ActionDispatchService.dispatch()`. Never a bespoke command. */
  commandId: string;
}

export interface RunReadinessReason {
  id: string;
  severity: RunReadinessSeverity;
  message: string;
  /** At most one — "each reason exactly one primary action". */
  action?: RunReadinessAction;
  /** Reserved for a future reason the user may acknowledge and proceed past. None emitted today are confirmable. */
  confirmable?: boolean;
}

export interface RunReadinessInputs {
  /** The provider the composer is about to send/spawn with. */
  provider: InstanceProvider | string;
  /** Null while not yet loaded — produces no reasons rather than guessing. */
  startupCapabilities: StartupCapabilityReport | null;
}

const SEVERITY_ORDER: Record<RunReadinessSeverity, number> = {
  blocking: 0,
  warning: 1,
  info: 2,
};

/** Open Doctor — the existing repair surface for provider CLI health. */
const OPEN_DOCTOR_ACTION: RunReadinessAction = { label: 'Open Doctor', commandId: 'app.open-doctor' };

export function buildRunReadinessReasons(inputs: RunReadinessInputs): RunReadinessReason[] {
  const reasons: RunReadinessReason[] = [];
  const report = inputs.startupCapabilities;

  if (report) {
    const anyCheck = report.checks.find((check) => check.id === 'provider.any');
    if (anyCheck?.status === 'unavailable') {
      reasons.push({
        id: 'provider-none-available',
        severity: 'blocking',
        message: anyCheck.summary || 'No supported provider CLI is currently available.',
        action: OPEN_DOCTOR_ACTION,
      });
    } else {
      // Only surface the per-provider warning when the aggregate check above
      // didn't already fire — a single clear "nothing works" reason beats a
      // redundant per-provider one when every provider is broken.
      const providerCheck = report.checks.find((check) => check.id === `provider.${inputs.provider}`);
      if (providerCheck?.status === 'degraded') {
        reasons.push({
          id: `provider-degraded-${inputs.provider}`,
          severity: 'warning',
          message: providerCheck.summary,
          action: OPEN_DOCTOR_ACTION,
        });
      }
    }
  }

  return dedupeById(reasons).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

function dedupeById(reasons: RunReadinessReason[]): RunReadinessReason[] {
  const seen = new Set<string>();
  const out: RunReadinessReason[] = [];
  for (const reason of reasons) {
    if (seen.has(reason.id)) continue;
    seen.add(reason.id);
    out.push(reason);
  }
  return out;
}
