import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveLoopArtifactPaths } from './loop-artifact-paths';
import {
  parseLoopPlanPacketMarkdown,
  readLoopPlanPacket,
  renderPlanPacketInstructions,
} from './loop-plan-packet';

let workspace: string;

const SAMPLE = `# Loop Roadmap

## Phase 1: Baseline Audit

Acceptance Criteria:
- [ ] Captures repo baseline before first child iteration.
- [ ] Writes repo-baseline.json under the scoped state dir.

Required Commands:
- npx vitest run src/main/orchestration/loop-repo-state.spec.ts

Evidence:
- src/main/orchestration/loop-repo-state.spec.ts:12
`;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-plan-packet-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('parseLoopPlanPacketMarkdown', () => {
  it('parses phase acceptance criteria, required commands, and evidence', () => {
    const summary = parseLoopPlanPacketMarkdown('/repo/.aio-loop-state/loop/ROADMAP.md', SAMPLE);

    expect(summary.malformed).toBe(false);
    expect(summary.criteriaTotal).toBe(2);
    expect(summary.criteriaWithEvidence).toBe(1);
    expect(summary.phases).toEqual([{
      id: 'phase-1',
      title: 'Baseline Audit',
      acceptanceCriteria: [
        'Captures repo baseline before first child iteration.',
        'Writes repo-baseline.json under the scoped state dir.',
      ],
      requiredCommands: ['npx vitest run src/main/orchestration/loop-repo-state.spec.ts'],
      evidence: ['src/main/orchestration/loop-repo-state.spec.ts:12'],
    }]);
  });

  it('marks packets malformed when required sections are missing', () => {
    const summary = parseLoopPlanPacketMarkdown('/repo/ROADMAP.md', '## Phase 1: Missing Sections\n\n- item');

    expect(summary.malformed).toBe(true);
    expect(summary.phases[0]?.id).toBe('phase-1');
  });

  it('ignores evidence lines that do not include a path:line shape', () => {
    const summary = parseLoopPlanPacketMarkdown('/repo/ROADMAP.md', SAMPLE.replace(
      'src/main/orchestration/loop-repo-state.spec.ts:12',
      'tests passed locally',
    ));

    expect(summary.criteriaWithEvidence).toBe(0);
    expect(summary.phases[0]?.evidence).toEqual([]);
  });
});

describe('renderPlanPacketInstructions', () => {
  it('uses scoped absolute artifact paths', () => {
    const paths = resolveLoopArtifactPaths(workspace, 'loop-1');
    const text = renderPlanPacketInstructions(paths);

    expect(text).toContain(paths.roadmap);
    expect(text).toContain(paths.phasesDir);
    expect(text).toContain(paths.tasks);
    expect(text).not.toContain('SUPERGOAL_PHASE_DONE');
  });
});

describe('readLoopPlanPacket', () => {
  it('reads phase files before falling back to ROADMAP.md', async () => {
    const paths = resolveLoopArtifactPaths(workspace, 'loop-1');
    mkdirSync(paths.phasesDir, { recursive: true });
    writeFileSync(join(paths.phasesDir, 'phase-01.md'), SAMPLE, 'utf8');
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.roadmap, 'not used', 'utf8');

    const summary = await readLoopPlanPacket(paths);

    expect(summary?.phases[0]?.title).toBe('Baseline Audit');
  });

  it('ignores recovery fix specs when choosing phase packet files', async () => {
    const paths = resolveLoopArtifactPaths(workspace, 'loop-1');
    mkdirSync(paths.phasesDir, { recursive: true });
    writeFileSync(join(paths.phasesDir, 'phase-1.fix.md'), '# Phase Fix Spec: phase-1\n', 'utf8');
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.roadmap, SAMPLE, 'utf8');

    const summary = await readLoopPlanPacket(paths);

    expect(summary?.malformed).toBe(false);
    expect(summary?.phases[0]?.title).toBe('Baseline Audit');
  });

  it('returns null when no packet exists', async () => {
    const paths = resolveLoopArtifactPaths(workspace, 'loop-1');

    await expect(readLoopPlanPacket(paths)).resolves.toBeNull();
  });
});
