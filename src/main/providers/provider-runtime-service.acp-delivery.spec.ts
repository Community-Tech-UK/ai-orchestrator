import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import { createInitializedAgentHarness, TestAcpCliAdapter, type FakeAcpProcess } from '../cli/adapters/acp-cli-adapter.test-helpers';
import { buildAcpSystemPromptBlock } from '../cli/adapters/acp-system-prompt-delivery';
import { _resetAllContextManifestsForTesting, getLatestContextManifest, recordContextManifest } from '../context/context-manifest-store';
import { ProviderRuntimeRegistry } from './provider-runtime-registry';
import { ProviderRuntimeService } from './provider-runtime-service';

describe('ACP manifest accepted-write boundary', () => {
  let proc: FakeAcpProcess;
  beforeEach(() => {
    _resetAllContextManifestsForTesting();
    proc = createInitializedAgentHarness();
    proc.onRequest('session/prompt', request => proc.respond(request.id, { stopReason: 'end_turn' }));
  });
  afterEach(() => proc.exit());

  it.each(['copilot', 'opencode', 'cursor', 'grok'] as const)('records actual cuts once after accepted retry for %s', async cliType => {
    recordContextManifest('instance', 'spawn', []);
    const systemPrompt = '# Rules\n' + 'a'.repeat(1000) + '\n# Omitted details\n' + 'b'.repeat(120000) + '\n# Permissions\nKeep permissions.';
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', systemPrompt, systemPromptMaxChars: 1200 });
    const service = new ProviderRuntimeService({ registry: new ProviderRuntimeRegistry(), createAdapter: () => adapter as CliAdapter });
    service.createAdapter({ cliType, options: { instanceId: 'instance', systemPrompt } });
    expect(getLatestContextManifest('instance')?.note).toBeUndefined();
    await adapter.spawn();
    const originalWrite = proc.stdin.write;
    proc.stdin.write = () => { throw new Error('Synthetic write failure'); };
    await expect(adapter.sendMessage({ role: 'user', content: 'First' })).rejects.toThrow('Synthetic write failure');
    expect(getLatestContextManifest('instance')?.note).toBeUndefined();
    proc.stdin.write = originalWrite;
    await adapter.sendMessage({ role: 'user', content: 'Retry' });
    await adapter.sendMessage({ role: 'user', content: 'Next' });
    const actual = buildAcpSystemPromptBlock(systemPrompt, 1200);
    expect(getLatestContextManifest('instance')?.note).toBe(`ACP first message: delivered ${actual.deliveredChars} of ${actual.originalChars} characters; omitted sections: ${actual.omittedHeadings.join('; ')}.`);
  });
});
