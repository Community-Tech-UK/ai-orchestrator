import { livePermissionsOf, type ResumeDeferredOptions } from './deferred-permission-options';

interface ResumeDeferredHost {
  resume(instanceId: string, approved: boolean, updatedInput?: Record<string, unknown>, options?: ResumeDeferredOptions): Promise<void>;
  queueYoloMode(instanceId: string, enabled: boolean): Promise<unknown>;
}

/** Live replies must not enter the held path's forced YOLO mutation or emit an unapplied toggle. */
export async function resumeDeferredPermissionWithPolicy(
  adapter: object | undefined, instanceId: string, approved: boolean, updatedInput: Record<string, unknown> | undefined,
  options: ResumeDeferredOptions | undefined, host: ResumeDeferredHost,
): Promise<void> {
  const live = livePermissionsOf(adapter)?.hasPending() === true;
  await host.resume(instanceId, approved, updatedInput, live ? { ...options, yoloMode: undefined } : options);
  if (live && approved && options?.yoloMode !== undefined) await host.queueYoloMode(instanceId, options.yoloMode);
}
