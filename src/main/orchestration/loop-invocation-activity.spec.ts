import { EventEmitter } from 'events';
import { afterEach, describe, it, expect, vi } from 'vitest';
vi.mock('../instance/stall-process-facts', async (original) => {
  const actual = await original<typeof import('../instance/stall-process-facts')>();
  return { ...actual, sampleStallProcessFacts: vi.fn() };
});
import { sampleStallProcessFacts, type StallProcessFacts } from '../instance/stall-process-facts';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import { createLoopInvocationCapture } from './loop-invoker-capture';
import { attachInvocationActivity, boundActivityDetail } from './loop-invocation-activity';

/**
 * LT-021 follow-up. Widening the renderer-boundary schema means `tool_use` and
 * `tool_result` details cross IPC for the first time, and those carry raw tool
 * input and results. This bounds them; only the IPC copy is truncated, never
 * the record kept for the loop's own evidence.
 */
describe('boundActivityDetail', () => {
  it('passes short strings and non-string scalars through unchanged', () => {
    const detail = {
      name: 'Read',
      count: 42,
      ok: true,
      missing: null,
      absent: undefined,
    };
    expect(boundActivityDetail(detail)).toEqual(detail);
  });

  it('truncates a long string and says how much was dropped', () => {
    const long = 'x'.repeat(2500);
    const out = boundActivityDetail({ result: long });
    const result = out['result'] as string;

    expect(result.startsWith('x'.repeat(2000))).toBe(true);
    expect(result).toContain('[truncated 500 chars]');
    expect(result.length).toBeLessThan(long.length);
  });

  it('keeps a small object as an object, but truncates a large one to a string', () => {
    const small = { a: 1, b: 'two' };
    expect(boundActivityDetail({ input: small })['input']).toEqual(small);

    const large = { blob: 'y'.repeat(4000) };
    const out = boundActivityDetail({ input: large })['input'];
    expect(typeof out).toBe('string');
    expect(out as string).toContain('[truncated');
  });

  it('does not throw on a circular structure', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular['self'] = circular;

    const out = boundActivityDetail({ input: circular });
    expect(out['input']).toBe('[unserializable]');
  });

  it('replaces a function rather than letting structured clone throw', () => {
    const out = boundActivityDetail({ cb: () => 'nope' });
    expect(out['cb']).toBe('[function]');
  });

  it('bounds every key, not just the first', () => {
    const out = boundActivityDetail({
      a: 'a'.repeat(2500),
      b: 'b'.repeat(2500),
    });
    expect(out['a'] as string).toContain('[truncated');
    expect(out['b'] as string).toContain('[truncated');
  });

  it('does not mutate the caller\'s object — the evidence record keeps the full detail', () => {
    const original = { result: 'z'.repeat(2500) };
    const snapshot = original.result;
    boundActivityDetail(original);
    expect(original.result).toBe(snapshot);
    expect(original.result.length).toBe(2500);
  });
});

describe('attachInvocationActivity', () => {
  afterEach(() => vi.restoreAllMocks());
  it('leaves deferred permission to the operator without terminating or auto-answering', () => {
    const emitter = Object.assign(new EventEmitter(), { terminate: vi.fn(async () => undefined),
      sendRaw: vi.fn(), hasPendingResidentRequest: () => true });
    const detach = attachInvocationActivity(emitter as unknown as CliAdapter, vi.fn(), { autoAnswerInputRequired: true });
    emitter.emit('input_required', { id: 'held', prompt: 'Approve command', metadata: { type: 'deferred_permission' } });
    expect(emitter.terminate).not.toHaveBeenCalled();
    expect(emitter.sendRaw).not.toHaveBeenCalled();
    detach();
  });

  const stopped: StallProcessFacts = { pid: 100, state: 'stopped', cpuPercent: 0, rssMb: 2, child: null, sampledAt: 1234 };
  it('sends the base stream-idle line then a notable process observation', async () => {
    vi.mocked(sampleStallProcessFacts).mockResolvedValue(stopped);
    const emitter = new EventEmitter();
    const sink = vi.fn();
    const detach = attachInvocationActivity(emitter as unknown as CliAdapter, sink);
    emitter.emit('stream:idle', { timeoutMs: 70_000, pid: 100 });
    expect(sink.mock.calls[0][0]).toMatchObject({ kind: 'stream-idle', message: 'No CLI output for 70s; still waiting for the iteration to finish' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sink.mock.calls[1][0]).toMatchObject({ kind: 'stream-idle', message: expect.stringContaining('paused by the system'), detail: { processFacts: stopped } });
    detach();
  });

  it('discards a process observation that resolves after the remover runs', async () => {
    let resolve!: (facts: StallProcessFacts) => void;
    vi.mocked(sampleStallProcessFacts).mockReturnValue(new Promise((r) => { resolve = r; }));
    const emitter = new EventEmitter();
    const sink = vi.fn();
    const detach = attachInvocationActivity(emitter as unknown as CliAdapter, sink);
    emitter.emit('stream:idle', { timeoutMs: 70_000, pid: 100 });
    detach();
    resolve(stopped);
    await new Promise<void>((r) => setImmediate(r));
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it.each([null, { ...stopped, state: 'sleeping' as const }])('adds no line for a missing or ordinary quiet observation', async (facts) => {
    vi.mocked(sampleStallProcessFacts).mockResolvedValue(facts);
    const emitter = new EventEmitter();
    const sink = vi.fn();
    const detach = attachInvocationActivity(emitter as unknown as CliAdapter, sink);
    emitter.emit('stream:idle', { timeoutMs: 70_000, pid: 100 });
    await new Promise<void>((r) => setImmediate(r));
    expect(sink).toHaveBeenCalledTimes(1);
    detach();
  });

  it('preserves adapter tool identity so a matching result settles the capture', () => {
    const emitter = new EventEmitter();
    const capture = createLoopInvocationCapture({ workspaceDir: '/workspace/project' });
    const detach = attachInvocationActivity(emitter as unknown as CliAdapter, capture.recordActivity);

    emitter.emit('output', {
      type: 'tool_use',
      content: 'Running command: npm run test:quiet',
      metadata: {
        id: 'cmd-1',
        name: 'Bash',
        input: { command: 'npm run test:quiet' },
      },
    });
    emitter.emit('output', {
      type: 'tool_result',
      content: 'Command exited with code 0',
      metadata: { id: 'cmd-1', name: 'Bash', is_error: false },
    });
    detach();

    expect(capture.finalize()).toMatchObject({
      unresolvedToolCalls: false,
      toolCalls: [{ toolName: 'Bash', success: true, resultHash: expect.any(String) }],
    });
  });

  describe('tool_result success follows the per-kind failure rule (U1 step 5)', () => {
    function runCommand(resultMetadata: Record<string, unknown>, content = 'out'): {
      success: boolean | undefined;
      activityDetail: Record<string, unknown> | undefined;
    } {
      const emitter = new EventEmitter();
      const capture = createLoopInvocationCapture({ workspaceDir: '/workspace/project' });
      const activities: { kind: string; detail?: Record<string, unknown> }[] = [];
      const detach = attachInvocationActivity(emitter as unknown as CliAdapter, (activity) => {
        activities.push(activity);
        capture.recordActivity(activity);
      });
      emitter.emit('output', {
        type: 'tool_use',
        content: 'Running command',
        metadata: { id: 'cmd-1', name: 'Bash', input: { command: 'npm test' } },
      });
      emitter.emit('output', {
        type: 'tool_result',
        content,
        metadata: { id: 'cmd-1', name: 'Bash', ...resultMetadata },
      });
      detach();
      return {
        success: capture.finalize().toolCalls[0]?.success,
        activityDetail: activities.find((activity) => activity.kind === 'tool_result')?.detail,
      };
    }

    it('keeps a command that ran and exited non-zero neutral: the loop is not told it failed', () => {
      const { success, activityDetail } = runCommand({ is_error: false, exitCode: 1, isCheck: false, checkFailed: false });
      expect(success).toBe(true);
      expect(activityDetail).toMatchObject({ success: true, exitCode: 1 });
    });

    it('still fails a real failing check, so a red test run is not reported as a success', () => {
      const { success, activityDetail } = runCommand({ is_error: false, exitCode: 1, isCheck: true, checkFailed: true }, '2 failed');
      expect(success).toBe(false);
      expect(activityDetail).toMatchObject({ success: false, exitCode: 1, checkFailed: true });
    });

    it('fails a check recorded with only its exit status and check flag', () => {
      expect(runCommand({ exitCode: 2, isCheck: true }).success).toBe(false);
    });

    it('fails a command that could not run', () => {
      expect(runCommand({ is_error: true, status: 'declined' }).success).toBe(false);
    });

    it('fails a result whose message carries the error flag at the top level', () => {
      const emitter = new EventEmitter();
      const sink = vi.fn();
      const detach = attachInvocationActivity(emitter as unknown as CliAdapter, sink);
      emitter.emit('output', { type: 'tool_result', content: 'boom', is_error: true, metadata: { id: 'x', name: 'Bash' } });
      detach();
      expect(sink.mock.calls[0][0]).toMatchObject({ kind: 'tool_result', detail: { success: false } });
    });

    it('fails an edit only on its error flag', () => {
      const emitter = new EventEmitter();
      const sink = vi.fn();
      const detach = attachInvocationActivity(emitter as unknown as CliAdapter, sink);
      emitter.emit('output', { type: 'tool_result', content: 'failed', metadata: { id: 'e1', name: 'Edit', is_error: true } });
      emitter.emit('output', { type: 'tool_result', content: 'ok', metadata: { id: 'e2', name: 'Edit', is_error: false, checkFailed: true } });
      detach();
      expect(sink.mock.calls.map((call) => call[0].detail.success)).toEqual([false, true]);
    });
  });

  it('preserves distinct output content when tool input metadata is missing', () => {
    const emitter = new EventEmitter();
    const capture = createLoopInvocationCapture({ workspaceDir: '/workspace/project' });
    const detach = attachInvocationActivity(emitter as unknown as CliAdapter, capture.recordActivity);

    emitter.emit('output', {
      type: 'tool_use',
      content: 'Running command: npm run lint',
      metadata: { id: 'cmd-1', name: 'Bash' },
    });
    emitter.emit('output', {
      type: 'tool_use',
      content: 'Running command: npm run test:quiet',
      metadata: { id: 'cmd-2', name: 'Bash' },
    });
    detach();

    const [lintCall, testCall] = capture.finalize().toolCalls;
    expect(lintCall.argsHash).not.toBe(testCall.argsHash);
  });

  it('auto-approves hidden ACP permission prompts via sendRaw allow, not autonomous prose', async () => {
    const emitter = new EventEmitter() as EventEmitter & {
      sendRaw: (text: string, permissionKey?: string) => Promise<void>;
    };
    const sendRaw = vi.fn(async () => undefined);
    emitter.sendRaw = sendRaw;
    const activities: { kind: string; message: string }[] = [];
    const detach = attachInvocationActivity(
      emitter as unknown as CliAdapter,
      (activity) => activities.push({ kind: activity.kind, message: activity.message }),
      { autoAnswerInputRequired: true },
    );

    emitter.emit('input_required', {
      id: 'acp_permission:9',
      prompt: 'ACP agent requests permission to continue tool execution.',
      metadata: { type: 'acp_permission_request', action: 'acp_permission' },
    });
    await new Promise<void>((r) => setImmediate(r));
    detach();

    expect(sendRaw).toHaveBeenCalledWith('allow', 'acp_permission:9');
    expect(sendRaw).not.toHaveBeenCalledWith(expect.stringContaining('Loop Mode is unattended'));
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'status',
          message: 'Auto-approving hidden ACP tool permission',
        }),
      ]),
    );
  });
});
