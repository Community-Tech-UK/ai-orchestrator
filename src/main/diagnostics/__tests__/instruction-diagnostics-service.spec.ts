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

  it('emits structured instruction-trust rows with approval anchors (WS12)', async () => {
    const service = new InstructionDiagnosticsService(
      async () => makeResolution({
        warnings: ['Instruction trust: Project CLAUDE.md is not yet approved (/repo/CLAUDE.md).'],
        sources: [
          {
            path: '/repo/CLAUDE.md', kind: 'claude', scope: 'project', loaded: true, applied: true,
            priority: 1, label: 'Project CLAUDE.md', trust: 'unknown', sha256: 'a'.repeat(64),
          },
          {
            path: '/repo/AGENTS.md', kind: 'agents', scope: 'project', loaded: true, applied: false,
            priority: 2, label: 'Project AGENTS.md', trust: 'changed', sha256: 'b'.repeat(64),
            scanFindings: [{ ruleId: 'pipe-to-shell', severity: 'critical', message: 'x', line: 1, excerpt: 'x' }],
          },
          {
            path: '/repo/GEMINI.md', kind: 'gemini', scope: 'project', loaded: true, applied: true,
            priority: 3, label: 'Project GEMINI.md', trust: 'approved', sha256: 'c'.repeat(64),
          },
        ],
      }),
      vi.fn().mockResolvedValue(1),
    );

    const diagnostics = await service.collect({ workingDirectory: '/repo' });
    const trustRows = diagnostics.filter((d) => d.code === 'instruction-trust');

    // Unapproved row: warning severity, carries the approval anchor.
    expect(trustRows).toContainEqual(expect.objectContaining({
      filePath: '/repo/CLAUDE.md', trust: 'unknown', sha256: 'a'.repeat(64), severity: 'warning',
    }));
    // Changed + critical scan: error severity, scanSeverity carried, notes the skip.
    expect(trustRows).toContainEqual(expect.objectContaining({
      filePath: '/repo/AGENTS.md', trust: 'changed', scanSeverity: 'critical', severity: 'error',
    }));
    // Cleanly approved files produce no row.
    expect(trustRows.some((d) => d.filePath === '/repo/GEMINI.md')).toBe(false);
    // The free-text trust warning is superseded by the structured rows (no duplication).
    expect(diagnostics.some((d) => d.message.startsWith('Instruction trust:') && d.code !== 'instruction-trust')).toBe(false);
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
