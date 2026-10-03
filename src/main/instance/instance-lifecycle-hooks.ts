import type { HookExecutionContext } from '../hooks/hook-executor';
import { getHookManager, type HookManager } from '../hooks/hook-manager';
import type { SubsystemLogger } from '../logging/logger';
import { errorDiagnostic } from '../logging/source-diagnostics';
import type { HookEvent } from '../../shared/types/hook.types';
import type { Instance } from '../../shared/types/instance.types';
import { getInstanceTurnEnding } from './instance-turn-ending-state';
import {
  getRecoverySensitiveValues,
  isCrashRecoveryInstance,
  redactRecoveryIdentityValue,
  redactRecoveryText,
} from './instance-recovery-redaction';

function buildInstanceHookContext(
  instance: Instance | undefined,
  extra: HookExecutionContext = {},
): HookExecutionContext {
  const isCrashRecovery = instance?.metadata?.['reason'] === 'crash-recovery';
  const { sessionId: _extraSessionId, ...safeExtra } = extra;
  const context: HookExecutionContext = {
    instanceId: instance?.id,
    ...(!isCrashRecovery
      ? { sessionId: instance?.providerSessionId || instance?.sessionId || _extraSessionId }
      : {}),
    workingDirectory: instance?.workingDirectory,
    modelId: instance?.currentModel,
    ...safeExtra,
  };
  return instance && isCrashRecoveryInstance(instance)
    ? redactRecoveryIdentityValue(
        context,
        getRecoverySensitiveValues(instance),
      ) as HookExecutionContext
    : context;
}

export function dispatchInstanceLifecycleHook(
  event: HookEvent,
  instance: Instance | undefined,
  extra: HookExecutionContext,
  logger: SubsystemLogger,
  hookManager: HookManager = getHookManager(),
): void {
  // A rejected prompt cannot accept text added by completion hooks either.
  if ((event === 'PostSampling' || event === 'Stop') && instance
    && getInstanceTurnEnding(instance.id) === 'context_overflow') return;
  const context = buildInstanceHookContext(instance, extra);
  void hookManager.triggerLifecycleHooks(event, context).catch((error: unknown) => {
    const isCrashRecovery = instance?.metadata?.['reason'] === 'crash-recovery';
    logger.error(`${event} hook error`,
      undefined, {
      instanceId: context.instanceId,
      ...errorDiagnostic(error),
      ...(isCrashRecovery ? { recoverySession: true } : {}),
    });
  });
}

export async function assertInstanceLifecycleHookAllowed(
  event: HookEvent,
  instance: Instance,
  extra: HookExecutionContext = {},
  hookManager: HookManager = getHookManager(),
): Promise<void> {
  const result = await hookManager.triggerLifecycleHooks(event, buildInstanceHookContext(instance, extra));
  if (result.blocked) {
    throw new Error(redactRecoveryText(
      instance,
      result.message ?? `${event} hook blocked the operation`,
    ));
  }
}
