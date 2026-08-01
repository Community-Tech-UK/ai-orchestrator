import { describe, expect, it } from 'vitest';
import type { ContextAttributionReport } from '../../../../shared/types/context-attribution.types';
import type { ContextManifestSnapshot } from '../../../../shared/types/context-manifest.types';
import {
  buildAttributionRows,
  buildManifestEpochRows,
  buildSparklinePoints,
} from './context-attribution-panel.component';

function report(buckets: ContextAttributionReport['buckets']): ContextAttributionReport {
  return { instanceId: 'i1', computedAt: 1, buckets };
}

describe('context-attribution panel presentation', () => {
  it('drops empty buckets and computes percentages of the known total', () => {
    const rows = buildAttributionRows(
      report([
        { key: 'instructionFiles', tokens: 3_000 },
        { key: 'mcpToolSchemas', tokens: 1_000 },
        { key: 'conversationHistory', tokens: 0 },
      ]),
    );
    expect(rows.map((row) => row.key)).toEqual(['instructionFiles', 'mcpToolSchemas']);
    expect(rows[0].percent).toBeCloseTo(75);
    expect(rows[1].percent).toBeCloseTo(25);
    expect(rows[0].label).toBe('Instruction files');
  });

  it('returns no rows for a missing report and never divides by zero', () => {
    expect(buildAttributionRows(null)).toEqual([]);
    expect(buildAttributionRows(report([]))).toEqual([]);
  });

  it('carries per-source detail through to the row', () => {
    const rows = buildAttributionRows(
      report([
        {
          key: 'instructionFiles',
          tokens: 10,
          detail: [{ label: '/p/CLAUDE.md', tokens: 10 }],
        },
      ]),
    );
    expect(rows[0].detail).toEqual([{ label: '/p/CLAUDE.md', tokens: 10 }]);
  });

  it('maps cache ratios onto the sparkline viewBox, high ratio at the top', () => {
    expect(buildSparklinePoints([])).toBe('');
    expect(buildSparklinePoints([{ ratio: 1 }])).toBe('');
    const points = buildSparklinePoints([{ ratio: 1 }, { ratio: 0.5 }, { ratio: 0 }]);
    expect(points).toBe('0.00,2.00 50.00,12.00 100.00,22.00');
  });
});

describe('context-manifest panel presentation (WS-C6)', () => {
  function snapshot(overrides: Partial<ContextManifestSnapshot> = {}): ContextManifestSnapshot {
    return {
      epoch: 0,
      at: 1000,
      trigger: 'spawn',
      entries: [
        { kind: 'instructions', status: 'supplied', contentHash: 'abcdef0123456789', charLength: 42, position: 0 },
        { kind: 'lessons', status: 'skipped-empty' },
      ],
      ...overrides,
    };
  }

  it('returns no rows for missing/empty history', () => {
    expect(buildManifestEpochRows(undefined)).toEqual([]);
    expect(buildManifestEpochRows([])).toEqual([]);
  });

  it('orders epochs newest-first and derives human labels', () => {
    const rows = buildManifestEpochRows([
      snapshot({ epoch: 0, trigger: 'spawn' }),
      snapshot({ epoch: 1, trigger: 'restart-compact', note: 'no blocks re-injected' }),
    ]);
    expect(rows.map((row) => row.epoch)).toEqual([1, 0]);
    expect(rows[0].triggerLabel).toBe('Restart (compaction)');
    expect(rows[0].note).toBe('no blocks re-injected');
    expect(rows[1].triggerLabel).toBe('Spawn');
  });

  it('counts supplied entries against the total block count', () => {
    const rows = buildManifestEpochRows([snapshot()]);
    expect(rows[0].suppliedCount).toBe(1);
    expect(rows[0].totalCount).toBe(2);
  });

  it('truncates the content hash to a short display form and carries status/length', () => {
    const rows = buildManifestEpochRows([snapshot()]);
    const instructions = rows[0].entries.find((entry) => entry.kind === 'instructions');
    const lessons = rows[0].entries.find((entry) => entry.kind === 'lessons');
    expect(instructions).toMatchObject({
      label: 'Instructions',
      status: 'supplied',
      statusLabel: 'supplied',
      shortHash: 'abcdef01',
      charLength: 42,
    });
    expect(lessons).toMatchObject({ label: 'Lessons', status: 'skipped-empty', statusLabel: 'skipped (empty)' });
    expect(lessons?.shortHash).toBeUndefined();
  });

  it('never carries raw content — only kind, status, hash, and length', () => {
    const rows = buildManifestEpochRows([snapshot()]);
    for (const entry of rows[0].entries) {
      expect(Object.keys(entry).sort()).toEqual(
        ['charLength', 'kind', 'label', 'shortHash', 'status', 'statusLabel'].sort(),
      );
    }
  });
});
