/**
 * Helper-agent policy for Codex sessions that run on a worker node.
 *
 * A worker has no settings store, so the controller resolves the helper level and sends it
 * (`codexHelperLevel`), and the worker sends the per-turn helper share back as `session_turn_share`
 * telemetry. A worker that does not advertise `codexHelperPolicy: 1` drops both fields.
 */
import type { WorkerNodeCapabilities } from '../../../shared/types/worker-node.types';

export const REMOTE_CODEX_HELPER_POLICY_PROTOCOL = 1;

export const REMOTE_CODEX_HELPER_POLICY_UNSUPPORTED =
  'This worker is out of date, so it would ignore the Codex helper setting and not record helper token use for this chat. Update the worker, or use local execution.';

/**
 * Every remote Codex session needs the capability: an older worker drops the helper level (it would start
 * the session as 'full' whatever the setting says) and the per-turn helper share, which Step 2 requires to
 * be stored for every session. So it is refused whatever the level.
 */
export function assertRemoteCodexHelperPolicySupported(
  capabilities: Pick<WorkerNodeCapabilities, 'codexHelperPolicy'> | undefined,
): void {
  // Registration capabilities reach the registry unparsed: accept only the exact value.
  if (capabilities?.codexHelperPolicy !== REMOTE_CODEX_HELPER_POLICY_PROTOCOL) throw new Error(REMOTE_CODEX_HELPER_POLICY_UNSUPPORTED);
}

/** Both Codex worker fences, checked together before a remote Codex spawn is sent. */
export function assertRemoteCodexWorkerSupported(
  cliType: string,
  options: { ephemeral?: boolean },
  capabilities: Pick<WorkerNodeCapabilities, 'codexSpawnMetadata' | 'codexHelperPolicy'> | undefined,
): void {
  if (cliType !== 'codex') return;
  if (options.ephemeral === false && capabilities?.codexSpawnMetadata !== 1) {
    throw new Error('Persistent Codex requires an updated worker that preserves its session policy. Update the worker or use local execution.');
  }
  assertRemoteCodexHelperPolicySupported(capabilities);
}
