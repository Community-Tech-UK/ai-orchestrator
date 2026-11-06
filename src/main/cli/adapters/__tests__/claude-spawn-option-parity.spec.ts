import { describe, expect, it } from 'vitest';
import type { ClaudeCliSpawnOptions } from '../claude-cli-adapter.types';
import { RemoteClaudeSpawnPolicySchema } from '../../../remote-node/claude-spawn-policy-schema';
import { InstanceSpawnParamsSchema } from '../../../remote-node/rpc-schemas';

// A new local option must deliberately travel or carry a reason here. The
// exhaustive type check prevents adding an unclassified Claude option.
const transport = {
  sessionKind: 'policy', machineSession: 'policy', contextCeilingTokens: 'policy', readOnlyReview: 'policy',
  bashOutputMaxChars: 'policy', maxTurns: 'policy', maxBudgetUsd: 'policy', timeout: 'policy',
  systemPromptMode: 'policy', fastMode: 'policy', fallbackModel: 'policy', jsonSchema: 'policy',
  residentClaude: 'policy', bare: 'policy', name: 'policy', chrome: 'policy', excludeDynamicSystemPromptSections: 'policy',
  trialKey: 'spawn',
  trialKeySource: 'local: only labels the policy-log line the executing machine writes for itself',
  sessionId: 'spawn', workingDirectory: 'spawn', model: 'spawn', yoloMode: 'spawn', resume: 'spawn', forkSession: 'spawn',
  allowedTools: 'spawn', disallowedTools: 'spawn', systemPrompt: 'spawn', mcpConfig: 'spawn', reasoningEffort: 'spawn', rtk: 'spawn',
  env: 'local: environment and credentials are composed on the executing worker',
  envRemove: 'local: account authentication isolation is derived on the executing worker',
  permissionHookPath: 'local: worker resolves its installed hook, coordinator paths are invalid remotely',
  debugLogging: 'local: worker reads its own debug setting; not exposed through UnifiedSpawnOptions',
  maxTokens: 'local: not exposed through UnifiedSpawnOptions or createClaudeAdapter',
  betas: 'local: not exposed through UnifiedSpawnOptions or createClaudeAdapter',
} satisfies Record<keyof ClaudeCliSpawnOptions, string>;

describe('local and remote Claude spawn option parity', () => {
  it('carries every classified option in the corresponding validated wire schema', () => {
    for (const [key, route] of Object.entries(transport)) {
      if (route === 'policy') expect(RemoteClaudeSpawnPolicySchema.shape, key).toHaveProperty(key);
      else if (route === 'spawn') expect(InstanceSpawnParamsSchema.shape, key).toHaveProperty(key);
      else expect(route, key).toMatch(/^local: .+/);
    }
  });
});
