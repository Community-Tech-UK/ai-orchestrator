import type { ClaudeCliSpawnOptions } from './claude-cli-adapter.types';
import { resolveClaudeHelperAgentModelSetting } from './claude-env-pack';
import { CLAUDE_HELPER_REVIEWER_RULE, claudeSubagentArmForSession } from './claude-subagent-policy';
import type { ClaudeSessionPolicyRecord } from '../../core/system/session-policy-log';

/** Record only the policy actually placed on a started Claude process. */
export function claudePolicyExposure(
  sessionId: string,
  options: ClaudeCliSpawnOptions,
  env: Record<string, string> | undefined,
  args: readonly string[],
): ClaudeSessionPolicyRecord {
  const promptIndex = args.findIndex(arg => arg === '--append-system-prompt' || arg === '--system-prompt');
  return {
    provider: 'claude', sessionId,
    setting: resolveClaudeHelperAgentModelSetting(),
    arm: claudeSubagentArmForSession(sessionId),
    applied: env?.['CLAUDE_CODE_SUBAGENT_MODEL'] === 'sonnet',
    ...(options.trialKey ? { armKey: options.trialKey, armSource: options.trialKeySource } : {}),
    reviewerRuleDelivered: promptIndex >= 0 && args[promptIndex + 1]?.includes(CLAUDE_HELPER_REVIEWER_RULE) === true,
    waitingRuleDelivered: args.includes('--append-subagent-system-prompt-file'),
  };
}
