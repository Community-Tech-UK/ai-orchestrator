import { describe, expect, it } from 'vitest';
import type { ContextAttributionReport } from '../../../../shared/types/context-attribution.types';
import {
  buildAttributionRows,
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
