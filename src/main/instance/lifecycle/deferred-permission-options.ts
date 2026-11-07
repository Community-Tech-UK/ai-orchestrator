import type { LivePermissionAnswer } from '../../cli/adapters/claude-live-permission';

export interface ResumeDeferredOptions {
  yoloMode?: boolean;
  requestId?: string;
  denyNote?: string;
}
export interface LivePermissionPort {
  hasPending(): boolean;
  /** True for a card id this broker minted, live or closed. Optional for old adapters and transport proxies. */
  knowsCard?(cardId: string): boolean;
  whenAnswered?(cardId: string | undefined): Promise<void>;
  answer(cardId: string | undefined, answer: LivePermissionAnswer): boolean;
}
/** Structural so the held path also supports old adapters and transport proxies. */
export function livePermissionsOf(adapter: object | undefined): LivePermissionPort | undefined {
  if (!adapter || !('livePermissions' in adapter)) return undefined;
  const broker = adapter.livePermissions as LivePermissionPort | undefined;
  return typeof broker?.answer === 'function' && typeof broker.hasPending === 'function' ? broker : undefined;
}
