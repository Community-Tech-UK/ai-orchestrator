import { describe, expect, it } from 'vitest';
import type { CliAdapter } from './adapter-factory';
import type { OutputMessage } from '../../../shared/types/instance.types';
import type { AcpToolKind } from '../../../shared/types/cli.types';
import type { ProviderRuntimeEvent } from '@contracts/types/provider-runtime-events';
import { AcpCliAdapter } from './acp-cli-adapter';
import { observeAdapterRuntimeEvents } from '../../providers/adapter-runtime-event-bridge';
import { bindRawAdapterProviderEvents } from '../../instance/instance-communication-provider-events';
import { attachInvocationActivity, type LoopInvocationActivity } from '../../orchestration/loop-invocation-activity';

describe('actual ACP result transport to main and loop consumers', () => {
  it.each([
    { kind: 'execute', command: 'npm test', exitCode: 1, failed: true, check: true },
    { kind: 'execute', command: 'cd /missing && npm test', exitCode: 1, failed: false, check: false },
    { kind: 'execute', command: 'rg test src', exitCode: 1, failed: false, check: false },
    { kind: 'execute', command: './script.sh', exitCode: 127, failed: false, check: false },
    { kind: 'edit', exitCode: 1, failed: true },
  ] as const)('preserves the outcome of %o', ({ kind, exitCode, failed, ...fields }) => {
    const adapter = new AcpCliAdapter({ workingDirectory: '/tmp/placeholder', adapterName: 'cursor' });
    const main: ProviderRuntimeEvent[] = [];
    const loop: ProviderRuntimeEvent[] = [];
    const activity: LoopInvocationActivity[] = [];
    const output: OutputMessage[] = [];
    adapter.on('output', message => output.push(message));
    observeAdapterRuntimeEvents(adapter, event => loop.push(event.event));
    bindRawAdapterProviderEvents({ adapter: adapter as unknown as CliAdapter, isStale: () => false, emit: event => main.push(event) });
    attachInvocationActivity(adapter as unknown as CliAdapter, item => activity.push(item));
    const wire = adapter as unknown as {
      handleToolCallCreated(update: Record<string, unknown>): void;
      handleToolCallDelta(update: Record<string, unknown>): void;
    };
    const command = 'command' in fields ? fields.command : undefined;
    wire.handleToolCallCreated({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Tool', kind: kind as AcpToolKind, status: 'pending', rawInput: command ? { command } : {} });
    wire.handleToolCallDelta({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', kind, status: 'failed', rawOutput: { exitCode, stdout: '' } });
    expect(main.find(event => event.kind === 'tool_result')).toMatchObject({ success: !failed });
    expect(loop.find(event => event.kind === 'tool_result')).toMatchObject({ success: !failed });
    const rawActivity = activity.filter(item => item.kind === 'tool_result').at(-1);
    expect(rawActivity?.detail).toMatchObject({ success: !failed });
    if (kind === 'edit') {
      expect(output.find(message => message.type === 'tool_result')?.metadata).toMatchObject({ is_error: true });
    } else {
      expect(output.find(message => message.type === 'tool_result')?.metadata).toMatchObject({ is_error: false, exitCode, checkFailed: 'check' in fields && fields.check === true });
    }
  });
});
