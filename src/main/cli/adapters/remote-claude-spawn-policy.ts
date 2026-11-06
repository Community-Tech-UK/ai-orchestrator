/**
 * Claude spawn policy for remote (worker-node) execution.
 *
 * A local Claude spawn applies these policies inside `createClaudeAdapter`
 * (argv and env). A remote spawn carries them over `instance.spawn` so the
 * worker's own `createClaudeAdapter` applies them identically. Workers that do
 * not advertise support would silently drop them, so a policy-bearing session
 * is refused there rather than run unprotected.
 */
import { getLogger } from '../../logging/logger';
import { isVersionAtLeast } from './claude-cli-feature-probes';
import { BASH_OUTPUT_MAX_CHARS_MIN_VERSION, resolveClaudeBashOutputMaxChars } from './claude-output-caps';
import type { CliType } from '../cli-detection';
import type { UnifiedSpawnOptions } from './adapter-factory.types';
import { resolveContextCeilingTokens } from './context-ceiling';
import type { WorkerNodeCapabilities } from '../../../shared/types/worker-node.types';
import {
  RemoteClaudeSpawnPolicySchema,
  type RemoteClaudeSpawnPolicy,
} from '../../remote-node/claude-spawn-policy-schema';

/** The `claudeSpawnPolicy` capability value whose wire shape this coordinator sends. */
export const REMOTE_CLAUDE_SPAWN_POLICY_PROTOCOL = 2;

const logger = getLogger('RemoteClaudeSpawnPolicy');
const V2_OPTIONS = [
  'sessionKind', 'timeout', 'systemPromptMode', 'fastMode', 'fallbackModel', 'jsonSchema',
  'residentClaude', 'bare', 'name', 'chrome', 'excludeDynamicSystemPromptSections',
] as const;

export const REMOTE_CLAUDE_POLICY_UNSUPPORTED =
  'Remote Claude execution cannot enforce read-only review, machine-session policy or turn/context limits on this worker yet. Update the worker, or use local execution for this session.';

/**
 * The policies a local Claude spawn with these options would apply, or
 * `undefined` when none would. The context ceiling is resolved from the
 * controller's settings here because the worker has no Harness settings.
 * The configured command-output cap is resolved here for the same reason.
 */
export function resolveRemoteClaudeSpawnPolicy(
  options: UnifiedSpawnOptions,
  readContextCeiling: (machineSession: boolean) => number | undefined = resolveContextCeilingTokens,
): RemoteClaudeSpawnPolicy | undefined {
  const contextCeilingTokens = options.contextCeilingTokens
    ?? readContextCeiling(Boolean(options.machineSession));
  const bashOutputMaxChars = resolveClaudeBashOutputMaxChars(options.bashOutputMaxChars);
  const policy: RemoteClaudeSpawnPolicy = {
    ...Object.fromEntries(V2_OPTIONS.filter(key => options[key] !== undefined).map(key => [key, options[key]])),
    ...(bashOutputMaxChars !== undefined ? { bashOutputMaxChars } : {}),
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
  capabilities: Pick<WorkerNodeCapabilities, 'claudeSpawnPolicy' | 'cliVersions'> | undefined,
): boolean {
  // Registration capabilities reach the registry unparsed: accept only the exact value.
  return capabilities?.claudeSpawnPolicy === 1 || capabilities?.claudeSpawnPolicy === REMOTE_CLAUDE_SPAWN_POLICY_PROTOCOL;
}

/** Fail closed: a policy must never reach a worker that would drop it. */
export function assertRemoteClaudeSpawnPolicySupported(
  policy: RemoteClaudeSpawnPolicy | undefined,
  capabilities: Pick<WorkerNodeCapabilities, 'claudeSpawnPolicy' | 'cliVersions'> | undefined,
): void {
  if (policy && !nodeEnforcesClaudeSpawnPolicy(capabilities)) {
    throw new Error(REMOTE_CLAUDE_POLICY_UNSUPPORTED);
  }
}

/**
 * The policy to send with a remote spawn of `cliType` on a node with these
 * capabilities: `undefined` for non-Claude providers or when no policy applies.
 * Throws when the node cannot enforce the policy. Called both when the adapter
 * is created and again when it spawns, because the node may have re-registered
 * on an older build in between.
 */
export function remoteClaudeSpawnPolicyFor(
  cliType: CliType,
  options: UnifiedSpawnOptions,
  capabilities: Pick<WorkerNodeCapabilities, 'claudeSpawnPolicy' | 'cliVersions'> | undefined,
): RemoteClaudeSpawnPolicy | undefined {
  if (cliType !== 'claude') return undefined;
  const resolved = resolveRemoteClaudeSpawnPolicy(options);
  if (!resolved) return undefined;
  // Older workers keep their original spawn behaviour. Lifecycle always sends
  // several v2 booleans, so their presence must not disable ordinary v1 spawns.
  // Original machine/read-only/context/turn/budget protections still fail closed.
  const policy = { ...resolved };
  if (capabilities?.claudeSpawnPolicy !== 2) {
    const omittedOptions = V2_OPTIONS.filter(key => key !== 'sessionKind' && policy[key] !== undefined);
    for (const key of V2_OPTIONS) delete policy[key];
    if (omittedOptions.length > 0) {
      logger.warn('Worker uses its original Claude options; update the worker to apply the new options', { omittedOptions });
    }
  }
  if (policy.bashOutputMaxChars !== undefined
      && (capabilities?.claudeSpawnPolicy !== 2
        || !isVersionAtLeast(capabilities.cliVersions?.claude, BASH_OUTPUT_MAX_CHARS_MIN_VERSION))) {
    logger.warn('Worker Claude command output cap unavailable; spawning without the requested cap', {
      cliVersion: capabilities?.cliVersions?.claude ?? 'unknown', minimumVersion: BASH_OUTPUT_MAX_CHARS_MIN_VERSION,
    });
    delete policy.bashOutputMaxChars;
  }
  const result = Object.keys(policy).length > 0 ? policy : undefined;
  assertRemoteClaudeSpawnPolicySupported(result, capabilities);
  return result;
}
