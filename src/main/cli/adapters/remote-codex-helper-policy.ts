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

export const REMOTE_CODEX_EXEC_SKILLS_POLICY_PROTOCOL = 1;

export const REMOTE_CODEX_EXEC_SKILLS_POLICY_UNSUPPORTED =
  'This worker is out of date, so its command-mode Codex would run this work without the skills limit and without naming the skills it needs. Update the worker, or use local execution.';

/**
 * A worker's command-mode Codex (the subprocess `exec` path) applies the skills cap, the checker's catalog omission and
 * the required-skills line only when the worker advertises `codexExecSkillsPolicy: 1`. An older worker accepts the same
 * spawn and then runs it uncapped, and the controller cannot see which mode the worker picked, so every non-chat Codex
 * session is refused there. Chats keep Codex's own catalog and need nothing.
 */
export function assertRemoteCodexExecSkillsPolicySupported(
  options: { sessionKind?: string },
  capabilities: Pick<WorkerNodeCapabilities, 'codexExecSkillsPolicy'> | undefined,
): void {
  if (options.sessionKind === undefined || options.sessionKind === 'chat') return;
  // Registration capabilities reach the registry unparsed: accept only the exact value.
  if (capabilities?.codexExecSkillsPolicy !== REMOTE_CODEX_EXEC_SKILLS_POLICY_PROTOCOL) throw new Error(REMOTE_CODEX_EXEC_SKILLS_POLICY_UNSUPPORTED);
}

/** The Codex worker fences, checked together before a remote Codex spawn is sent. */
export function assertRemoteCodexWorkerSupported(
  cliType: string,
  options: { ephemeral?: boolean; sessionKind?: string },
  capabilities: Pick<WorkerNodeCapabilities, 'codexSpawnMetadata' | 'codexHelperPolicy' | 'codexExecSkillsPolicy'> | undefined,
): void {
  if (cliType !== 'codex') return;
  if (options.ephemeral === false && capabilities?.codexSpawnMetadata !== 1) {
    throw new Error('Persistent Codex requires an updated worker that preserves its session policy. Update the worker or use local execution.');
  }
  assertRemoteCodexHelperPolicySupported(capabilities);
  assertRemoteCodexExecSkillsPolicySupported(options, capabilities);
}
