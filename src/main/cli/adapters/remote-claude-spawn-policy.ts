/**
 * Claude spawn policy for remote (worker-node) execution.
 *
 * A local Claude spawn applies these policies inside `createClaudeAdapter`
 * (argv and env). A remote spawn carries them over `instance.spawn` so the
 * worker's own `createClaudeAdapter` applies them identically. Workers that do
 * not advertise support would silently drop them, so a policy-bearing session
 * is refused there rather than run unprotected.
 */
import type { CliType } from '../cli-detection';
import type { UnifiedSpawnOptions } from './adapter-factory.types';
import { resolveContextCeilingTokens } from './context-ceiling';
import type { WorkerNodeCapabilities } from '../../../shared/types/worker-node.types';
import {
  RemoteClaudeSpawnPolicySchema,
  type RemoteClaudeSpawnPolicy,
} from '../../remote-node/claude-spawn-policy-schema';

/** The `claudeSpawnPolicy` capability value whose wire shape this coordinator sends. */
export const REMOTE_CLAUDE_SPAWN_POLICY_PROTOCOL = 1;

export const REMOTE_CLAUDE_POLICY_UNSUPPORTED =
  'Remote Claude execution cannot enforce read-only review, machine-session policy or turn/context limits on this worker yet. Update the worker, or use local execution for this session.';

/**
 * The policies a local Claude spawn with these options would apply, or
 * `undefined` when none would. The context ceiling is resolved from the
 * controller's settings here because the worker has no Harness settings.
 */
export function resolveRemoteClaudeSpawnPolicy(
  options: UnifiedSpawnOptions,
  readContextCeiling: (machineSession: boolean) => number | undefined = resolveContextCeilingTokens,
): RemoteClaudeSpawnPolicy | undefined {
  const contextCeilingTokens = options.contextCeilingTokens
    ?? readContextCeiling(Boolean(options.machineSession));
  const policy: RemoteClaudeSpawnPolicy = {
    ...(options.machineSession ? { machineSession: options.machineSession } : {}),
    ...(contextCeilingTokens !== undefined && contextCeilingTokens > 0 ? { contextCeilingTokens } : {}),
    ...(options.readOnlyReview === true ? { readOnlyReview: true } : {}),
    ...(options.maxTurns !== undefined && options.maxTurns > 0 ? { maxTurns: options.maxTurns } : {}),
    ...(typeof options.maxBudgetUsd === 'number' && Number.isFinite(options.maxBudgetUsd) && options.maxBudgetUsd > 0
      ? { maxBudgetUsd: options.maxBudgetUsd }
      : {}),
  };
  return Object.keys(policy).length > 0 ? RemoteClaudeSpawnPolicySchema.parse(policy) : undefined;
}

export function nodeEnforcesClaudeSpawnPolicy(
  capabilities: Pick<WorkerNodeCapabilities, 'claudeSpawnPolicy'> | undefined,
): boolean {
  // Registration capabilities reach the registry unparsed: accept only the exact value.
  return capabilities?.claudeSpawnPolicy === REMOTE_CLAUDE_SPAWN_POLICY_PROTOCOL;
}

/** Fail closed: a policy must never reach a worker that would drop it. */
export function assertRemoteClaudeSpawnPolicySupported(
  policy: RemoteClaudeSpawnPolicy | undefined,
  capabilities: Pick<WorkerNodeCapabilities, 'claudeSpawnPolicy'> | undefined,
): void {
  if (policy && !nodeEnforcesClaudeSpawnPolicy(capabilities)) {
    throw new Error(REMOTE_CLAUDE_POLICY_UNSUPPORTED);
  }
}

/**
 * The policy to send with a remote spawn of `cliType` on a node with these
 * capabilities: `undefined` for non-Claude providers and ordinary sessions.
 * Throws when the node cannot enforce the policy. Called both when the adapter
 * is created and again when it spawns, because the node may have re-registered
 * on an older build in between.
 */
export function remoteClaudeSpawnPolicyFor(
  cliType: CliType,
  options: UnifiedSpawnOptions,
  capabilities: Pick<WorkerNodeCapabilities, 'claudeSpawnPolicy'> | undefined,
): RemoteClaudeSpawnPolicy | undefined {
  if (cliType !== 'claude') return undefined;
  const policy = resolveRemoteClaudeSpawnPolicy(options);
  assertRemoteClaudeSpawnPolicySupported(policy, capabilities);
  return policy;
}
