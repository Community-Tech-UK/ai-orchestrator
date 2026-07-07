import * as os from 'os';
import { crossPlatformBasename } from '../../shared/utils/cross-platform-path';
import type { MobilePromptDto } from '../../shared/types/mobile-gateway.types';
import type { MobileApnsSender } from './mobile-apns-sender';
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

export function sendMobilePromptPush(deps: MobileGatewayPushDeps, prompt: MobilePromptDto): void {
  try {
    const sender = deps.apnsSender;
    if (!sender.isConfigured()) return;
    const tokens = deps.registry.apnsTokens();
    if (tokens.length === 0) return;
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
    void sender
      .send(tokens, {
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
        },
      })
      .catch((err) =>
        deps.logger.debug('APNs send failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
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
  try {
    const sender = deps.apnsSender;
    if (!sender.isConfigured()) return;
    const tokens = deps.registry.liveActivityTokensFor(instanceId);
    if (tokens.length === 0) return;
    const instance = deps.instanceManager?.getInstance(instanceId);
    const where = instance?.workingDirectory
      ? crossPlatformBasename(instance.workingDirectory)
      : '';
    const nowSeconds = Math.floor(Date.now() / 1000);
    void sender
      .sendLiveActivity(tokens, {
        event,
        contentState: {
          status: liveActivityStatusLabel(status),
          detail: where,
        },
        // Grey the activity out if no update lands within 30 minutes.
        staleDate: nowSeconds + 30 * 60,
        ...(event === 'end' ? { dismissalDate: nowSeconds + 5 * 60 } : {}),
      })
      .catch((err) =>
        deps.logger.debug('Live Activity send failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
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
    const tokens = deps.registry.apnsTokens();
    if (tokens.length === 0) return;
    const kindLabel = escalation.kind.replace(/_/g, ' ');
    void sender
      .send(tokens, {
        title: `Browser agent parked: ${kindLabel}`,
        body: escalation.reason.slice(0, 160),
        category: 'AIO_BROWSER_ESCALATION',
        threadId: escalation.campaignId ?? escalation.profileId,
        data: {
          escalationId: escalation.escalationId,
          kind: 'browser_escalation',
          host: os.hostname(),
        },
      })
      .catch((err) =>
        deps.logger.debug('APNs escalation send failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
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
    const tokens = deps.registry.apnsTokens();
    if (tokens.length === 0) return;
    const instance = deps.instanceManager?.getInstance(instanceId);
    const where = instance?.workingDirectory
      ? crossPlatformBasename(instance.workingDirectory)
      : '';
    const agent = instance?.displayName || 'Agent';
    void sender
      .send(tokens, {
        title: `${agent} finished`,
        body: where ? `Idle · ${where}` : 'Ready for your next message',
        category: 'AIO_COMPLETE',
        threadId: instanceId,
        data: {
          instanceId,
          kind: 'completion',
          host: os.hostname(),
        },
      })
      .catch((err) =>
        deps.logger.debug('APNs completion send failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
  } catch (err) {
    deps.logger.debug('sendCompletionPush threw', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
