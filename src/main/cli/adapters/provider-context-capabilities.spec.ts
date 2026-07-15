import { describe, expect, it, vi } from 'vitest';
import type { ProviderContextCapabilities } from '@contracts/types/context-evidence';
import { ClaudeCliAdapter } from './claude-cli-adapter';
import { CodexCliAdapter } from './codex-cli-adapter';
import { GeminiCliAdapter } from './gemini-cli-adapter';
import { createCopilotAdapter } from './adapter-factory';

const postRetentionBase = {
  toolResultControl: 'post-retention',
  toolResultVisibility: 'full',
  cumulativeReporting: 'available',
} as const;

const expected = {
  codexAppServer: {
    ...postRetentionBase,
    transcriptControl: 'native-compaction',
    occupancyReporting: 'current',
    interruptProof: 'observed',
    compactionProof: 'observed',
    sameThreadContinuation: true,
  },
  codexExec: {
    ...postRetentionBase,
    transcriptControl: 'none',
    occupancyReporting: 'aggregate-only',
    interruptProof: 'none',
    compactionProof: 'none',
    sameThreadContinuation: false,
  },
  claudeResident: {
    ...postRetentionBase,
    transcriptControl: 'none',
    occupancyReporting: 'current',
    interruptProof: 'acknowledged-only',
    compactionProof: 'none',
    sameThreadContinuation: true,
  },
  claudeNonresident: {
    ...postRetentionBase,
    transcriptControl: 'none',
    occupancyReporting: 'aggregate-only',
    interruptProof: 'none',
    compactionProof: 'none',
    sameThreadContinuation: false,
  },
  geminiStateless: {
    ...postRetentionBase,
    transcriptControl: 'none',
    occupancyReporting: 'aggregate-only',
    interruptProof: 'none',
    compactionProof: 'none',
    sameThreadContinuation: false,
  },
  copilotAcp: {
    ...postRetentionBase,
    transcriptControl: 'none',
    occupancyReporting: 'aggregate-only',
    interruptProof: 'none',
    compactionProof: 'none',
    sameThreadContinuation: false,
  },
} satisfies Record<string, ProviderContextCapabilities>;

describe('provider context-capability matrix', () => {
  it('locks Codex app-server and exec to different proof-backed capabilities', () => {
    const adapter = new CodexCliAdapter();

    expect(adapter.getContextCapabilities()).toEqual(expected.codexExec);

    (adapter as unknown as { useAppServer: boolean }).useAppServer = true;
    expect(adapter.getContextCapabilities()).toEqual(expected.codexAppServer);
  });

  it('drops Codex app-server proof after terminate, runtime exit, or unavailable fallback', async () => {
    const terminated = new CodexCliAdapter();
    (terminated as unknown as { useAppServer: boolean }).useAppServer = true;
    await terminated.terminate();
    expect(terminated.getContextCapabilities()).toEqual(expected.codexExec);

    const exited = new CodexCliAdapter();
    (exited as unknown as { useAppServer: boolean }).useAppServer = true;
    (exited as unknown as { handleAppServerRuntimeExit(error: Error | null): void })
      .handleAppServerRuntimeExit(new Error('synthetic disconnect'));
    expect(exited.getContextCapabilities()).toEqual(expected.codexExec);

    const fallback = new CodexCliAdapter();
    (fallback as unknown as { useAppServer: boolean }).useAppServer = true;
    vi.spyOn(fallback, 'checkStatus').mockResolvedValue({
      available: true,
      metadata: { appServerAvailable: false },
    });
    await fallback.spawn();
    expect(fallback.getContextCapabilities()).toEqual(expected.codexExec);
    await fallback.terminate();
  });

  it('locks resident and nonresident Claude without treating protocol acknowledgement as observation', () => {
    const adapter = new ClaudeCliAdapter({ residentClaude: true });

    expect(adapter.getContextCapabilities()).toEqual(expected.claudeNonresident);

    adapter.getAdapterCapabilities = () => ({
      residentSession: true,
      liveInterrupt: true,
      liveSteer: true,
    });
    expect(adapter.getContextCapabilities()).toEqual(expected.claudeResident);
    expect(adapter.getContextCapabilities().interruptProof).toBe('acknowledged-only');
  });

  it('locks stateless Gemini to aggregate-only accounting', () => {
    const adapter = new GeminiCliAdapter();

    expect(adapter.getContextCapabilities()).toEqual(expected.geminiStateless);
  });

  it('locks the factory-produced Copilot ACP adapter without upgrading generic ACP', () => {
    const adapter = createCopilotAdapter({ workingDirectory: '/tmp' });

    expect(adapter.getName()).toBe('copilot-acp');
    expect(adapter.getContextCapabilities()).toEqual(expected.copilotAcp);
  });

  it('never treats provider thread/session identifiers as proof', () => {
    const codex = new CodexCliAdapter();
    const gemini = new GeminiCliAdapter();
    const copilot = createCopilotAdapter({ workingDirectory: '/tmp' });

    for (const adapter of [codex, gemini, copilot]) {
      const before = adapter.getContextCapabilities();
      adapter.setSessionId('provider-returned-thread-or-session-id');
      expect(adapter.getContextCapabilities()).toEqual(before);
      expect(adapter.getContextCapabilities().interruptProof).toBe('none');
      expect(adapter.getContextCapabilities().compactionProof).toBe('none');
    }
  });
});
