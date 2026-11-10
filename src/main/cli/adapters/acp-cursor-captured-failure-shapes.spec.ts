import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, OutputMessage } from '../../../shared/types/instance.types';
const storage = vi.hoisted(() => ({ flushInstance: vi.fn(async () => undefined), loadMessages: vi.fn(async (): Promise<OutputMessage[]> => []) }));
vi.mock('../../memory/output-storage', () => ({ getOutputStorageManager: () => storage }));
import { recordToolOutcome, _resetToolOutcomeStoreForTesting } from '../../learning/tool-outcome-store';
import { getCompleteInstanceMessages } from '../../history/complete-instance-messages';
import { AcpCliAdapter } from './acp-cli-adapter';
import { extractToolInvocations, mineCorrections } from '../../learning/correction-miner';

/**
 * Wire shapes captured from a real `cursor-agent 2026.10.22-27dcf5f acp` session
 * on 2026-11-10 (strings replaced by neutral placeholders, keys and enums kept).
 *
 * - A native Read of a missing file reached `completed` with no `rawOutput` and
 *   no `content`. The failure ("File not found") reached the model only; the wire
 *   carries no failure signal, so the adapter must not invent one.
 * - A failing shell command reached `completed` with
 *   `rawOutput { exitCode: 1, stdout: '', stderr }`. The status is neutral by the
 *   shared rule (shared/tool-outcome.ts), but its number and stderr must survive.
 */
function replay(
  created: Record<string, unknown>,
  settled: Record<string, unknown>,
): OutputMessage[] {
  const adapter = new AcpCliAdapter({ workingDirectory: '/tmp/placeholder', adapterName: 'cursor' });
  const output: OutputMessage[] = [];
  adapter.on('output', message => output.push(message));
  const wire = adapter as unknown as {
    handleToolCallCreated(update: Record<string, unknown>): void;
    handleToolCallDelta(update: Record<string, unknown>): void;
  };
  wire.handleToolCallCreated(created);
  wire.handleToolCallDelta({ sessionUpdate: 'tool_call_update', toolCallId: created['toolCallId'], status: 'in_progress' });
  wire.handleToolCallDelta(settled);
  return output;
}

describe('captured Cursor failure wire shapes', () => {
  beforeEach(() => { vi.clearAllMocks(); _resetToolOutcomeStoreForTesting(); });

  it('records a failed native read, which carries no wire signal, as a neutral outcome and no result', () => {
    const output = replay(
      { sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Read File', kind: 'read', status: 'pending', rawInput: { path: 'placeholder' }, locations: [{ path: 'placeholder' }] },
      { sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed' },
    );
    expect(output.map(message => message.type)).toEqual(['tool_use', 'tool_outcome']);
    expect(output[1]?.metadata).toMatchObject({ is_error: false });
    expect(extractToolInvocations(output as never)).toEqual([]);
    expect(mineCorrections(output as never)).toEqual([]);
  });

  it('keeps the exit status and stderr of a failing shell command through to the miner', () => {
    const output = replay(
      { sessionUpdate: 'tool_call', toolCallId: 'sh-1', title: 'Shell', kind: 'execute', status: 'pending', rawInput: { command: 'ls --placeholder-option .' } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'sh-1', status: 'completed', rawOutput: { exitCode: 1, stdout: '', stderr: 'placeholder: unrecognized option' } },
    );
    const result = output.find(message => message.type === 'tool_result');
    expect(result?.content).toContain('unrecognized option');
    expect(result?.content).toContain('(exit code 1)');
    expect(result?.metadata).toMatchObject({ exitCode: 1, is_error: false });
    expect(output.some(message => message.type === 'tool_outcome')).toBe(false);
    const [invocation] = extractToolInvocations(output as never);
    expect(invocation).toMatchObject({ command: 'ls --placeholder-option .', isError: false });
  });

  it('archives the hidden outcome of a failed read exactly once and keeps it out of the visible buffer', async () => {
    const output = replay(
      { sessionUpdate: 'tool_call', toolCallId: 'read-2', title: 'Read File', kind: 'read', status: 'pending', rawInput: { path: 'placeholder' } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'read-2', status: 'completed' },
    );
    // The same split InstanceCommunication makes: hidden outcomes to the side store, the rest to the buffer.
    const visible = output.filter(message => message.type !== 'tool_outcome');
    for (const message of output.filter(message => message.type === 'tool_outcome')) recordToolOutcome('cursor-1', message);
    expect(visible.map(message => message.type)).toEqual(['tool_use']);
    const archived = await getCompleteInstanceMessages({ id: 'cursor-1', retainedPrompts: [], outputBuffer: visible } as unknown as Instance);
    expect(archived.filter(message => message.type === 'tool_outcome')).toHaveLength(1);
    expect(mineCorrections(archived as never)).toEqual([]);
  });
});
