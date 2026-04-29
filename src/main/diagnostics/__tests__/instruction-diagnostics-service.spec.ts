import { describe, expect, it, vi } from 'vitest';
import type { InstructionResolution } from '../../../shared/types/instruction-source.types';
import { InstructionDiagnosticsService } from '../instruction-diagnostics-service';

describe('InstructionDiagnosticsService', () => {
  it('maps resolver warnings and Copilot conflicts', async () => {
    const service = new InstructionDiagnosticsService(
      async () => makeResolution({
        warnings: ['Both orchestrator and AGENTS instructions are present at the project level.'],
        sources: [
          { path: '/repo/AGENTS.md', kind: 'agents', scope: 'project', loaded: true, applied: true, priority: 1, label: 'Agents' },
          { path: '/repo/.orchestrator/INSTRUCTIONS.md', kind: 'orchestrator', scope: 'project', loaded: true, applied: true, priority: 2, label: 'Orchestrator' },
          { path: '/repo/.github/copilot-instructions.md', kind: 'copilot', scope: 'project', loaded: true, applied: true, priority: 3, label: 'Copilot' },
        ],
      }),
      vi.fn().mockResolvedValue(1),
    );

    const diagnostics = await service.collect({ workingDirectory: '/repo' });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'conflicting-instruction-sources' }),
      ]),
    );
  });

  it('emits broad-root-scan above the configured file threshold', async () => {
    const countFiles = vi.fn().mockResolvedValue(101);
    const service = new InstructionDiagnosticsService(
      async () => makeResolution({
        sources: [
          { path: '/repo/.orchestrator/INSTRUCTIONS.md', kind: 'orchestrator', scope: 'project', loaded: true, applied: true, priority: 1, label: 'Orchestrator' },
        ],
      }),
      countFiles,
    );

    const diagnostics = await service.collect({
      workingDirectory: '/repo',
      broadRootFileThreshold: 100,
    });

    expect(countFiles).toHaveBeenCalledWith('/repo', { stopAfter: 100 });
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'broad-root-scan' }));
  });

  it('returns a resolution-failed diagnostic when the resolver throws', async () => {
    const service = new InstructionDiagnosticsService(
      async () => {
        throw new Error('bad instructions');
      },
      vi.fn(),
    );

    await expect(service.collect({ workingDirectory: '/repo' })).resolves.toEqual([
      expect.objectContaining({ code: 'resolution-failed', severity: 'error' }),
    ]);
  });
});

function makeResolution(
  partial: Partial<InstructionResolution>,
): InstructionResolution {
  return {
    projectRoot: '/repo',
    workingDirectory: '/repo',
    contextPaths: [],
    mergedContent: '',
    sources: [],
    warnings: [],
    timestamp: 1,
    ...partial,
  };
}
