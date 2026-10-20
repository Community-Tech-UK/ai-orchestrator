/**
 * Stateless exec-per-message adapter classification.
 *
 * Shared by the coordinator (`instance-communication.ts`) and the worker agent
 * (`local-instance-manager.ts`), so both sides agree on which adapter `exit`
 * events are a turn's process finishing rather than the session ending.
 *
 * Electron isolation: the worker imports this statically, so it must stay a
 * leaf. Type-only imports only; the adapter is read by duck typing, which also
 * keeps the answer correct when the adapter class was loaded through a second
 * module instance (path aliases, or the worker's lazily imported factory).
 */
import type { AdapterCapabilities, AdapterRuntimeCapabilities } from './base-cli-adapter.types';

export interface StatelessExecClassifiable {
  getName(): string;
  getRuntimeCapabilities?(): AdapterRuntimeCapabilities;
  getAdapterCapabilities?(): Pick<AdapterCapabilities, 'residentSession'>;
}

const STATELESS_EXEC_ADAPTER_NAMES: readonly string[] = [
  'antigravity-cli',
  'codex-cli',
  'copilot-cli',
  'cursor-cli',
  'gemini-cli',
];

/**
 * True when the adapter runs one provider process per message, so a process
 * exit ends a turn, not the session. Read synchronously inside `exit`
 * listeners: adapters that can leave a resident mode (Codex app-server, LT-004)
 * keep reporting their resident state until those listeners have run.
 */
export function isStatelessExecAdapter(adapter: StatelessExecClassifiable): boolean {
  const runtimeCapabilities = adapter.getRuntimeCapabilities?.();
  if (
    runtimeCapabilities?.supportsNativeCompaction
    || runtimeCapabilities?.supportsPermissionPrompts
    || runtimeCapabilities?.supportsDeferPermission
  ) {
    return false;
  }
  // A resident session is definitionally not exec-per-message (WS14: copilot
  // server mode; also codex app-server, which additionally escapes above).
  if (adapter.getAdapterCapabilities?.().residentSession) {
    return false;
  }
  return STATELESS_EXEC_ADAPTER_NAMES.includes(adapter.getName().toLowerCase());
}
