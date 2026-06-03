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
