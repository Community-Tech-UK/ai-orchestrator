/**
 * Auto-title Phase 3 wiring (see `AutoTitleService`): the instant/AI title
 * from the opening message can only be as good as that message — a lot of
 * real opening messages ("fix this issue", a raw paste) name no subject at
 * all. `instance:settled` fires once per turn across every CLI adapter, so it
 * is the one place that reliably observes "the assistant has now replied"
 * regardless of which provider is running. `AutoTitleService` itself is
 * one-shot per instance (the pending entry is consumed on first use), so this
 * is a no-op on every settle after the first.
 *
 * Split out of `InstanceManager` (rather than inlined as a private method) to
 * keep that file under its LOC ratchet ceiling — this hook has no other
 * reason to live there beyond needing the same `applyTitle` side effects as
 * the other auto-title call sites.
 */

import type { Instance } from '../../shared/types/instance.types';
import { getAutoTitleService } from './auto-title-service';
import { getSessionContinuityManager } from '../session/session-continuity';
import { getLogger } from '../logging/logger';

const logger = getLogger('InstanceManager');

export interface AutoTitleSettleHookDeps {
  queueUpdate: (
    instanceId: string,
    status: Instance['status'],
    contextUsage: Instance['contextUsage'],
    diffStats: undefined,
    displayName: string,
  ) => void;
}

/** Handle one `instance:settled` event, upgrading the title when appropriate. */
export function handleInstanceSettledForAutoTitle(
  instanceId: string,
  instance: Instance,
  deps: AutoTitleSettleHookDeps,
): void {
  const assistantReply = instance.outputBuffer
    .filter((message) => message.type === 'assistant')
    .map((message) => message.content)
    .join('\n')
    .trim();
  if (!assistantReply) return;

  getAutoTitleService().maybeUpgradeTitleWithFirstReply(
    instanceId,
    assistantReply,
    (id, title) => {
      logger.debug('Auto-title callback (contextual upgrade)', { id, title, isRenamed: instance.isRenamed });
      if (instance.isRenamed) return;
      instance.displayName = title;
      instance.aiTitle = title;
      deps.queueUpdate(id, instance.status, instance.contextUsage, undefined, title);
      getSessionContinuityManager().updateState(id, { displayName: title });
    },
    instance.isRenamed,
  ).catch(() => { /* non-critical */ });
}
