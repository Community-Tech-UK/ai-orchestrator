import { describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import { buildChildDiagnosticBundle } from './child-diagnostics';

vi.mock('./child-result-storage', () => ({
  getChildResultStorage: () => ({
    getChildSummary: vi.fn(async () => ({
      resultId: 'result-1',
      childId: 'child-1',
      summary: 'Done',
      success: false,
      artifactCount: 2,
      artifactTypes: ['error', 'screenshot'],
      conclusions: ['failed for a useful reason'],
      hasMoreDetails: true,
      commands: {
        getArtifacts: '{}',
        getDecisions: '{}',
        getFull: '{}',
      },
    })),
  }),
}));

describe('buildChildDiagnosticBundle', () => {
  it('LT-196: never exposes a tool_outcome record to plugin hooks or the diagnostic modal', async () => {
    // This bundle is handed to third-party plugin code via the
    // `orchestration.child.failed` hook and rendered verbatim in the child
    // diagnostic modal. The miner-only record must reach neither.
    const child = {
      id: 'child-lt196',
      parentId: 'parent-1',
      status: 'failed',
      provider: 'claude',
      workingDirectory: '/tmp',
      outputBuffer: [
        { id: 'u1', timestamp: 1, type: 'user', content: 'run it' },
        {
          id: 'o1',
          timestamp: 2,
          type: 'tool_outcome',
          content: 'grep: unrecognized option --bogus-flag',
          metadata: { tool_use_id: 'toolu_1', is_error: true },
        },
        { id: 'a1', timestamp: 3, type: 'assistant', content: 'that failed' },
      ],
    } as unknown as Instance;

    const bundle = await buildChildDiagnosticBundle(child, 'task');

    expect(bundle.recentOutputTail.some((m) => m.type === 'tool_outcome')).toBe(false);
    expect(bundle.recentEvents.some((e) => e.type === 'tool_outcome')).toBe(false);
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain('unrecognized option');
    // Not over-broad: ordinary messages still come through.
    expect(bundle.recentOutputTail.map((m) => m.type)).toEqual(['user', 'assistant']);
  });

  it('captures spawn, routing, status, output, event, and artifact diagnostics', async () => {
    const child = {
      id: 'child-1',
      parentId: 'parent-1',
      status: 'failed',
      provider: 'codex',
      currentModel: 'gpt-5.5',
      workingDirectory: '/repo',
      createdAt: 10,
      lastActivity: 20,
      metadata: {
        orchestration: {
          task: 'Investigate the failing webhook handler',
          routingAudit: {
            requestedProvider: 'codex',
            actualProvider: 'codex',
            actualModel: 'gpt-5.5',
          },
          statusTimeline: [
            { status: 'busy', timestamp: 12 },
            { status: 'failed', timestamp: 20 },
          ],
        },
      },
      outputBuffer: [
        {
          id: 'msg-1',
          type: 'system',
          content: 'diagnostic event',
          timestamp: 15,
          metadata: { kind: 'runtime_error', level: 'error', ignored: true },
        },
      ],
    } as unknown as Instance;

    const bundle = await buildChildDiagnosticBundle(child, 'timeout');

    expect(bundle.childInstanceId).toBe('child-1');
    expect(bundle.parentInstanceId).toBe('parent-1');
    expect(bundle.provider).toBe('codex');
    expect(bundle.model).toBe('gpt-5.5');
    expect(bundle.spawnPromptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(bundle.statusTimeline).toHaveLength(2);
    expect(bundle.recentEvents[0]).toMatchObject({
      type: 'runtime_error',
      metadata: { level: 'error' },
    });
    expect(bundle.artifactsSummary).toMatchObject({
      resultId: 'result-1',
      success: false,
      artifactCount: 2,
      artifactTypes: ['error', 'screenshot'],
      hasMoreDetails: true,
    });
    expect(bundle.timeoutReason).toBe('timeout');
    expect(bundle.recentOutput).toEqual(bundle.recentOutputTail);
  });
});
