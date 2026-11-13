import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderRuntimeEventSchema } from '@contracts/schemas/provider-runtime-events';
import type { AcpSessionUpdateNotificationParams } from '../../../shared/types/cli.types';
import { AcpCliAdapter } from './acp-cli-adapter';
import { observeAdapterRuntimeEvents } from '../../providers/adapter-runtime-event-bridge';
import { observeToolLoopEvent } from '../../instance/instance-tool-loop-wiring';
import { DoomLoopDetector, getDoomLoopDetector, type ToolLoopDetectionEvent } from '../../orchestration/doom-loop-detector';

// Installed OpenCode 1.19.5: pending bash input contains only cwd; the command
// arrives in an in_progress update, and completed often omits rawInput entirely.
function setup() {
  const adapter = new AcpCliAdapter({ adapterName: 'opencode-acp', command: 'opencode', args: [], workingDirectory: '/fixture' });
  const ingress = adapter as unknown as {
    sessionId: string;
    handleSessionUpdate(params: AcpSessionUpdateNotificationParams): void;
  };
  ingress.sessionId = 'fixture-session';
  const interrupt = vi.fn(() => true);
  const detections: ToolLoopDetectionEvent[] = [];
  getDoomLoopDetector().on('tool-loop-detected', event => detections.push(event));
  observeAdapterRuntimeEvents(adapter, ({ event }) => {
    expect(ProviderRuntimeEventSchema.parse(event)).toEqual(event);
    observeToolLoopEvent({
      getProvider: () => 'opencode', getAutoInterruptSetting: () => false,
      interruptInstance: interrupt,
    }, 'fixture-instance', event);
  });
  const send = (update: AcpSessionUpdateNotificationParams['update']) => ingress.handleSessionUpdate({
    sessionId: 'fixture-session', update,
  });
  const start = (toolCallId: string, rawInput: Record<string, unknown> = { cwd: '/fixture' }) => send({
    sessionUpdate: 'tool_call', toolCallId, title: 'bash', kind: 'execute', status: 'pending', rawInput,
  });
  const progress = (toolCallId: string, command: string) => send({
    sessionUpdate: 'tool_call_update', toolCallId, title: command, kind: 'execute', status: 'in_progress',
    rawInput: { command, description: `Caption for ${toolCallId}`, cwd: '/fixture' },
  });
  const finish = (toolCallId: string) => send({
    sessionUpdate: 'tool_call_update', toolCallId, status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: '(no output)' } }],
  });
  return { start, progress, finish, interrupt, detections };
}

afterEach(() => DoomLoopDetector._resetForTesting());

describe('OpenCode streamed command identity', () => {
  it('does not stop different commands that began in the same folder and returned equal results', () => {
    const { start, progress, finish, interrupt, detections } = setup();
    for (let i = 0; i < 6; i++) {
      start(`call-${i}`);
      progress(`call-${i}`, `find folder-${i} -name '*.md'`);
      finish(`call-${i}`);
    }
    expect(detections).toEqual([]);
    expect(interrupt).not.toHaveBeenCalled();
  });

  it('still stops a genuinely repeated command when only its caption changes', () => {
    const { start, progress, finish, interrupt, detections } = setup();
    for (let i = 0; i < 6; i++) {
      start(`call-${i}`);
      progress(`call-${i}`, 'printf same');
      finish(`call-${i}`);
    }
    expect(detections.map(({ severity, count }) => ({ severity, count }))).toEqual([
      { severity: 'warn', count: 3 }, { severity: 'critical', count: 6 },
    ]);
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it('does not infer identical commands when their command text never arrives', () => {
    const { start, finish, interrupt, detections } = setup();
    for (let i = 0; i < 6; i++) {
      start(`call-${i}`);
      finish(`call-${i}`);
    }
    expect(detections).toEqual([]);
    expect(interrupt).not.toHaveBeenCalled();
  });

  it('retains call pairing when the pending input is empty', () => {
    const { start, progress, finish, interrupt } = setup();
    for (let i = 0; i < 6; i++) {
      start(`call-${i}`, {});
      progress(`call-${i}`, 'printf same');
      finish(`call-${i}`);
    }
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it('pairs overlapping calls by id when their results arrive in reverse order', () => {
    const { start, progress, finish, interrupt, detections } = setup();
    for (let i = 0; i < 6; i += 2) {
      start(`call-${i}`);
      start(`call-${i + 1}`);
      progress(`call-${i}`, `find folder-${i}`);
      progress(`call-${i + 1}`, `find folder-${i + 1}`);
      finish(`call-${i + 1}`);
      finish(`call-${i}`);
    }
    expect(detections).toEqual([]);
    expect(interrupt).not.toHaveBeenCalled();
  });
});
