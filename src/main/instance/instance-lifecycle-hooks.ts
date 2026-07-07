import type { HookExecutionContext } from '../hooks/hook-executor';
import { getHookManager, type HookManager } from '../hooks/hook-manager';
import type { SubsystemLogger } from '../logging/logger';
import type { HookEvent } from '../../shared/types/hook.types';
import type { Instance } from '../../shared/types/instance.types';

function buildInstanceHookContext(
  instance: Instance | undefined,
  extra: HookExecutionContext = {},
): HookExecutionContext {
  return {
    instanceId: instance?.id,
    sessionId: instance?.providerSessionId || instance?.sessionId,
    workingDirectory: instance?.workingDirectory,
    modelId: instance?.currentModel,
    ...extra,
  };
}

export function dispatchInstanceLifecycleHook(
  event: HookEvent,
  instance: Instance | undefined,
  extra: HookExecutionContext,
  logger: SubsystemLogger,
  hookManager: HookManager = getHookManager(),
): void {
  const context = buildInstanceHookContext(instance, extra);
  void hookManager.triggerLifecycleHooks(event, context).catch((error: unknown) => {
    logger.error(`${event} hook error`, error instanceof Error ? error : undefined, {
      instanceId: context.instanceId,
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
    throw new Error(result.message ?? `${event} hook blocked the operation`);
  }
}
