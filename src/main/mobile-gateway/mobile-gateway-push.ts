import * as os from 'os';
import { crossPlatformBasename } from '../../shared/utils/cross-platform-path';
import type { MobilePromptDto } from '../../shared/types/mobile-gateway.types';
import type { ApnsAlert, ApnsSendResult, MobileApnsSender } from './mobile-apns-sender';
import type { MobileDeviceRegistry } from './mobile-device-registry';
import type { SubsystemLogger } from '../logging/logger';

interface PushInstanceSource {
  getInstance(id: string): {
    displayName?: string;
    workingDirectory?: string;
  } | undefined;
}

interface MobileGatewayPushDeps {
  apnsSender: MobileApnsSender;
  registry: MobileDeviceRegistry;
  instanceManager: PushInstanceSource | null;
  logger: SubsystemLogger;
}

const LIVE_ACTIVITY_THROTTLE_MS = 15_000;
interface PendingLiveActivity {
  timer: ReturnType<typeof setTimeout> | null;
  lastSentAt: number;
  pending: { deps: MobileGatewayPushDeps; status: string } | null;
}
const liveActivityThrottle = new Map<string, PendingLiveActivity>();

function invalidDeviceToken(result: ApnsSendResult): boolean {
  return result.status === 410 || (
    result.status === 400 && (result.reason === 'BadDeviceToken' || result.reason === 'Unregistered')
  );
}

function sendPersonalizedAlerts(
  deps: MobileGatewayPushDeps,
  build: (hostDeviceId: string) => ApnsAlert,
  logMessage: string,
): void {
  const targets = deps.registry.apnsTargets();
  if (targets.length === 0) return;
  void Promise.all(targets.map(async ({ deviceId, token }) => {
    const results = await deps.apnsSender.send([token], build(deviceId));
    for (const result of results) {
      if (invalidDeviceToken(result)) deps.registry.clearApnsToken(result.deviceToken);
    }
  })).catch((err) => deps.logger.debug(logMessage, {
    error: err instanceof Error ? err.message : String(err),
  }));
}

export function sendMobilePromptPush(deps: MobileGatewayPushDeps, prompt: MobilePromptDto): void {
  try {
    const sender = deps.apnsSender;
    if (!sender.isConfigured()) return;
    const instance = deps.instanceManager?.getInstance(prompt.instanceId);
    const where = instance?.workingDirectory
      ? crossPlatformBasename(instance.workingDirectory)
      : '';
    const agent = instance?.displayName || 'Agent';
    const title =
      prompt.kind === 'permission'
        ? prompt.toolName
          ? `${prompt.toolName} needs approval`
          : 'Approval needed'
        : prompt.title;
    const body = where ? `${agent} · ${where}` : agent;
    sendPersonalizedAlerts(deps, (hostDeviceId) => ({
        title,
        body,
        category: 'AIO_APPROVAL',
        threadId: prompt.instanceId,
        data: {
          instanceId: prompt.instanceId,
          requestId: prompt.requestId,
          kind: prompt.kind,
          // Lets a multi-host phone route one-tap Approve/Deny to this Mac.
          host: os.hostname(),
          hostDeviceId,
        },
      }), 'APNs send failed');
  } catch (err) {
    deps.logger.debug('sendPush threw', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Instance status → the coarse label the Live Activity widget renders. */
export function liveActivityStatusLabel(status: string): string {
  switch (status) {
    case 'waiting_for_permission':
    case 'waiting_for_input':
      return 'needs approval';
    case 'error':
    case 'failed':
    case 'degraded':
      return 'error';
    case 'idle':
    case 'ready':
      return 'idle';
    default:
      return 'working';
  }
}

/**
 * Refresh (or end) the lock-screen Live Activity for an instance on any status
 * change. Tokens only exist while a phone has an activity running for the
 * session, so this is a no-op for everyone else.
 */
export function sendMobileLiveActivityPush(
  deps: MobileGatewayPushDeps,
  instanceId: string,
  status: string,
  event: 'update' | 'end' = 'update',
): void {
  if (event === 'end') {
    const state = liveActivityThrottle.get(instanceId);
    if (state?.timer) clearTimeout(state.timer);
    liveActivityThrottle.delete(instanceId);
    performLiveActivityPush(deps, instanceId, status, event);
    return;
  }
  const now = Date.now();
  const state = liveActivityThrottle.get(instanceId);
  if (!state || now - state.lastSentAt >= LIVE_ACTIVITY_THROTTLE_MS) {
    liveActivityThrottle.set(instanceId, { timer: null, lastSentAt: now, pending: null });
    performLiveActivityPush(deps, instanceId, status, event);
    return;
  }
  state.pending = { deps, status };
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    const pending = state.pending;
    state.pending = null;
    if (!pending) return;
    state.lastSentAt = Date.now();
    performLiveActivityPush(pending.deps, instanceId, pending.status, 'update');
  }, Math.max(0, LIVE_ACTIVITY_THROTTLE_MS - (now - state.lastSentAt)));
  state.timer.unref?.();
}

function performLiveActivityPush(
  deps: MobileGatewayPushDeps,
  instanceId: string,
  status: string,
  event: 'update' | 'end',
): void {
  try {
    const sender = deps.apnsSender;
    if (!sender.isConfigured()) return;
    const targets = deps.registry.liveActivityTargetsFor(instanceId);
    if (targets.length === 0) return;
    const instance = deps.instanceManager?.getInstance(instanceId);
    const where = instance?.workingDirectory
      ? crossPlatformBasename(instance.workingDirectory)
      : '';
    const nowSeconds = Math.floor(Date.now() / 1000);
    void Promise.all(targets.map(async ({ deviceId, token }) => {
      const results = await sender.sendLiveActivity([token], {
        event,
        contentState: {
          status: liveActivityStatusLabel(status),
          detail: where,
          hostDeviceId: deviceId,
        },
        collapseId: `live-${instanceId}`.slice(0, 64),
        // Grey the activity out if no update lands within 30 minutes.
        staleDate: nowSeconds + 30 * 60,
        ...(event === 'end' ? { dismissalDate: nowSeconds + 5 * 60 } : {}),
      });
      for (const result of results) {
        if (invalidDeviceToken(result)) deps.registry.clearLiveActivityToken(result.deviceToken);
      }
    })).catch((err) => deps.logger.debug('Live Activity send failed', {
      error: err instanceof Error ? err.message : String(err),
    }));
  } catch (err) {
    deps.logger.debug('sendLiveActivityPush threw', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface BrowserEscalationPushInput {
  escalationId: string;
  kind: string;
  profileId: string;
  campaignId?: string;
  /** Human-readable hard-stop reason. Must never contain a secret or code. */
  reason: string;
}

/**
 * Page the phone when an unattended browser campaign parks a hard stop
 * (captcha, failed re-login, unfamiliar declaration, …). The night's other
 * work continues; this is the "triage me in the morning (or now)" signal.
 */
export function sendBrowserEscalationPush(
  deps: MobileGatewayPushDeps,
  escalation: BrowserEscalationPushInput,
): void {
  try {
    const sender = deps.apnsSender;
    if (!sender.isConfigured()) return;
    const kindLabel = escalation.kind.replace(/_/g, ' ');
    sendPersonalizedAlerts(deps, (hostDeviceId) => ({
        title: `Browser agent parked: ${kindLabel}`,
        body: escalation.reason.slice(0, 160),
        category: 'AIO_BROWSER_ESCALATION',
        threadId: escalation.campaignId ?? escalation.profileId,
        data: {
          escalationId: escalation.escalationId,
          kind: 'browser_escalation',
          host: os.hostname(),
          hostDeviceId,
        },
      }), 'APNs escalation send failed');
  } catch (err) {
    deps.logger.debug('sendBrowserEscalationPush threw', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function sendMobileCompletionPush(
  deps: MobileGatewayPushDeps,
  instanceId: string,
): void {
  try {
    const sender = deps.apnsSender;
    if (!sender.isConfigured()) return;
    const instance = deps.instanceManager?.getInstance(instanceId);
    const where = instance?.workingDirectory
      ? crossPlatformBasename(instance.workingDirectory)
      : '';
    const agent = instance?.displayName || 'Agent';
    sendPersonalizedAlerts(deps, (hostDeviceId) => ({
        title: `${agent} finished`,
        body: where ? `Idle · ${where}` : 'Ready for your next message',
        category: 'AIO_COMPLETE',
        threadId: instanceId,
        collapseId: `status-${instanceId}`.slice(0, 64),
        data: {
          instanceId,
          kind: 'completion',
          host: os.hostname(),
          hostDeviceId,
        },
      }), 'APNs completion send failed');
  } catch (err) {
    deps.logger.debug('sendCompletionPush threw', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function clearMobilePushThrottle(): void {
  for (const state of liveActivityThrottle.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  liveActivityThrottle.clear();
}

export function _resetMobilePushThrottleForTesting(): void {
  clearMobilePushThrottle();
}
