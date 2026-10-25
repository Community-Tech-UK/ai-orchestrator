import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { CliToolCall } from '../cli/adapters/base-cli-adapter';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import { InstanceToolResultProcessor, type InstanceToolResultProcessorDependencies } from './instance-tool-result-processor';

describe('InstanceToolResultProcessor', () => {
  let instance: Instance;
  let createSnapshot: Mock<NonNullable<InstanceToolResultProcessorDependencies['createSnapshot']>>;
  let captureEvidence: Mock<NonNullable<InstanceToolResultProcessorDependencies['captureContextEvidenceToolResult']>>;
  let liveEvidenceMode: 'off' | 'shadow';
  let processor: InstanceToolResultProcessor;

  beforeEach(() => {
    instance = toolInstance();
    createSnapshot = vi.fn();
    captureEvidence = vi.fn().mockResolvedValue(undefined);
    liveEvidenceMode = 'shadow';
    processor = new InstanceToolResultProcessor({
      createSnapshot,
      captureContextEvidenceToolResult: captureEvidence,
      getContextEvidenceMode: () => liveEvidenceMode,
    });
  });

  it('deduplicates tool results by tool-use id and resets on cleanup', () => {
    const message = toolResult('tool-1');

    expect(processor.acceptForBuffer(instance, message)).toBe(true);
    expect(processor.acceptForBuffer(instance, { ...message, id: 'duplicate' })).toBe(false);

    processor.cleanup(instance.id);
    expect(processor.acceptForBuffer(instance, { ...message, id: 'after-cleanup' })).toBe(true);
  });

  it('creates a bounded soft checkpoint after six autonomous tool results', () => {
    for (let index = 0; index < 7; index++) {
      processor.acceptForBuffer(instance, toolResult(`tool-${index}`, 'Read'));
    }

    expect(createSnapshot).toHaveBeenCalledOnce();
    expect(createSnapshot).toHaveBeenCalledWith(
      instance.id,
      'Auto: after Read (autonomous run, tool #6)',
      undefined,
      'auto',
    );

    processor.resetAutonomousCount(instance.id);
    createSnapshot.mockClear();
    for (let index = 0; index < 4; index++) {
      processor.acceptForBuffer(instance, toolResult(`next-${index}`, 'Write'));
    }
    expect(createSnapshot).not.toHaveBeenCalled();
  });

  it('offers parsed and raw evidence under the same logical capture key', () => {
    processor.captureParsedEvidence(instance, toolResult('tool-1', 'Read'));
    processor.captureRawEvidence(instance, {
      id: 'tool-1',
      name: 'Read',
      arguments: { path: 'README.md' },
      result: 'contents',
    } satisfies CliToolCall);

    expect(captureEvidence).toHaveBeenCalledTimes(2);
    expect(captureEvidence.mock.calls.map((call) => call[0].captureKey)).toEqual([
      'tool-result:turn-1:tool-1',
      'tool-result:turn-1:tool-1',
    ]);
  });

  it('honours the live provider kill switch for an already-running instance', () => {
    liveEvidenceMode = 'off';

    processor.captureParsedEvidence(instance, toolResult('tool-1', 'Read'));
    processor.captureRawEvidence(instance, {
      id: 'tool-1',
      name: 'Read',
      arguments: { path: 'README.md' },
      result: 'contents',
    } satisfies CliToolCall);

    expect(instance.contextEvidence?.mode).toBe('shadow');
    expect(captureEvidence).not.toHaveBeenCalled();
  });

  it.each([['Edit', { file_path: 'file.ts' }, true], ['Bash', { command: 'echo example 2>&1' }, false]])('marks successful structured edit intent only for %s', async (name, input, editIntent) => {
    instance.workingDirectory = '/repo';
    const captureBaseline = vi.fn();
    processor = new InstanceToolResultProcessor({
      getDiffTracker: () => ({ captureBaseline }) as never,
      hookManager: { triggerLifecycleHooks: vi.fn().mockResolvedValue(undefined) } as never,
    });
    await processor.processToolLifecycle(instance.id, instance, { id: 'example', timestamp: 1, type: 'tool_use', content: '', metadata: { id: 'example-call', name, input } });
    expect(captureBaseline.mock.calls.every(call => call[1]?.editIntent === false)).toBe(true);
    await processor.processToolLifecycle(instance.id, instance, { id: 'result', timestamp: 2, type: 'tool_result', content: '', metadata: { tool_use_id: 'example-call', is_error: false } });
    if (editIntent) expect(captureBaseline).toHaveBeenCalledWith('/repo/file.ts', { editIntent: true });
    else expect(captureBaseline.mock.calls.every(call => call[1]?.editIntent === false)).toBe(true);
  });
});

function toolResult(toolUseId: string, name = 'Read'): OutputMessage {
  return {
    id: `message-${toolUseId}`,
    timestamp: 1,
    type: 'tool_result',
    content: 'contents',
    metadata: { tool_use_id: toolUseId, name, turnId: 'turn-1' },
  };
}

function toolInstance(): Instance {
  return {
    id: 'instance-1',
    sessionId: 'session-1',
    providerSessionId: 'provider-session-1',
    activeTurnId: 'turn-1',
    provider: 'claude',
    contextEvidence: {
      mode: 'shadow',
      conversationId: 'conversation-1',
      captureFailureCount: 0,
    },
  } as Instance;
}
