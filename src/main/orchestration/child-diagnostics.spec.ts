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
