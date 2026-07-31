/**
 * channel-admission-delivery.ts
 *
 * Admission-gated delivery for channel messages (A5 fix), extracted from
 * ChannelMessageRouter. Shared by `routeToInstance` and `routeBroadcast`:
 * re-checks live instance state immediately before sending — a session
 * `waiting_for_permission` (or interrupting/respawning/parked) gets its
 * prompt held rather than thrown at a `sendInput()` that would either reject
 * or silently wedge the CLI stdin. Held prompts are redelivered once the
 * instance reaches a ready state (see `handleChannelAdmissionRedelivery`).
 */

import { getLogger } from '../logging/logger';
import type { BaseChannelAdapter } from './channel-adapter';
import type { ChannelPlatform, InboundChannelMessage } from '../../shared/types/channels';
import type { FileAttachment } from '../../shared/types/instance.types';
import { getSessionAdmissionService, type RedeliveryContext } from '../session/session-admission-service';
import { buildChannelMessagePrompt } from './channel-message-prompt';

const logger = getLogger('ChannelMessageRouter');

/**
 * Capabilities `deliverChannelMessage` / `handleChannelAdmissionRedelivery`
 * need from `ChannelMessageRouter`, injected explicitly so this module stays
 * decoupled from the router class.
 */
export interface ChannelAdmissionDeliveryDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getInstanceManager(): any;
  streamResults(msg: InboundChannelMessage, instanceId: string, adapter: BaseChannelAdapter): void;
  getAdapter(platform: ChannelPlatform): BaseChannelAdapter | undefined;
}

export async function deliverChannelMessage(
  deps: ChannelAdmissionDeliveryDeps,
  msg: InboundChannelMessage,
  instanceId: string,
  content: string,
  adapter: BaseChannelAdapter,
  attachments: FileAttachment[] = [],
): Promise<'admitted' | 'suppressed'> {
  const im = deps.getInstanceManager();
  const prompt = buildChannelMessagePrompt(msg, content);
  const outcome = getSessionAdmissionService().admitAutomatedWrite({
    instanceId,
    origin: 'channel',
    message: prompt,
    attachments: attachments.length > 0 ? attachments : undefined,
    sourceMetadata: { msg, content, platform: msg.platform },
  });

  if (outcome.kind === 'suppressed') {
    logger.info('Channel send suppressed pending instance readiness', {
      instanceId,
      reason: outcome.reason,
      admissionId: outcome.admissionId,
    });
    return 'suppressed';
  }

  // Attach the output listener before delivering the prompt so the reply
  // can't be emitted before we're listening. (This is an existing, ready
  // instance, so there is no buffered first turn to replay.)
  deps.streamResults(msg, instanceId, adapter);

  try {
    if (attachments.length > 0) {
      await im.sendInput(instanceId, prompt, attachments);
    } else {
      await im.sendInput(instanceId, prompt);
    }
    getSessionAdmissionService().markDelivered(outcome.admissionId);
  } catch (err) {
    getSessionAdmissionService().markFailed(
      outcome.admissionId,
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }
  return 'admitted';
}

/**
 * Redelivery handler for suppressed channel sends. Re-resolves the platform
 * adapter (channel adapters are per-platform, not per-message) and replays
 * `deliverChannelMessage` — which re-checks admission fresh, so a still-not-
 * ready instance simply re-suppresses (and stays queued) rather than throwing.
 */
export async function handleChannelAdmissionRedelivery(
  deps: ChannelAdmissionDeliveryDeps,
  ctx: RedeliveryContext,
): Promise<void> {
  const meta = ctx.sourceMetadata as { msg?: InboundChannelMessage; content?: string } | undefined;
  if (!meta?.msg || typeof meta.content !== 'string') {
    logger.warn('Channel redelivery missing original message context; dropping', {
      instanceId: ctx.instanceId,
      admissionId: ctx.admissionId,
    });
    return;
  }
  const adapter = deps.getAdapter(meta.msg.platform);
  if (!adapter) {
    logger.warn('Channel redelivery: adapter unavailable', {
      platform: meta.msg.platform,
      instanceId: ctx.instanceId,
    });
    return;
  }
  try {
    const result = await deliverChannelMessage(
      deps,
      meta.msg,
      ctx.instanceId,
      meta.content,
      adapter,
      ctx.attachments ?? [],
    );
    if (result === 'admitted') {
      getSessionAdmissionService().markDelivered(ctx.admissionId);
    }
  } catch (err) {
    getSessionAdmissionService().markFailed(ctx.admissionId, err instanceof Error ? err.message : String(err));
    logger.warn('Channel redelivery send failed', {
      instanceId: ctx.instanceId,
      admissionId: ctx.admissionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
