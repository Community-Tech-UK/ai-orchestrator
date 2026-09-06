import { describe, expect, it } from 'vitest';

import {
  routingMatrixRows,
  routingMatrixToJson,
  tierLabel,
  withRoutingValue,
  ROUTING_MATRIX_TIERS,
} from './routing-matrix';
import { DEFAULT_ORCHESTRATION_ROUTING_POLICY } from './settings-defaults';

describe('routingMatrixRows (S4.2)', () => {
  it('gives a row per orchestration gate', () => {
    const rows = routingMatrixRows(JSON.stringify(DEFAULT_ORCHESTRATION_ROUTING_POLICY));
    expect(rows.map((r) => r.key).sort())
      .toEqual(Object.keys(DEFAULT_ORCHESTRATION_ROUTING_POLICY).sort());
  });

  it('marks nothing as overridden on the shipped defaults', () => {
    const rows = routingMatrixRows(JSON.stringify(DEFAULT_ORCHESTRATION_ROUTING_POLICY));
    expect(rows.filter((r) => r.overridden)).toEqual([]);
  });

  it('reads a real override and flags it', () => {
    const rows = routingMatrixRows(JSON.stringify({ debateSynthesis: 'fast' }));
    const row = rows.find((r) => r.key === 'debateSynthesis')!;
    expect(row.value).toBe('fast');
    expect(row.overridden).toBe(true);
    expect(row.defaultValue).toBe('balanced');
  });

  /** A settings typo must not blank the table or take orchestration down. */
  it('falls back to defaults for malformed JSON rather than throwing', () => {
    for (const bad of ['{ not json', '', '   ', null, undefined, 42, '[]']) {
      const rows = routingMatrixRows(bad);
      expect(rows.length, String(bad)).toBeGreaterThan(0);
      expect(rows.every((r) => !r.overridden), String(bad)).toBe(true);
    }
  });

  it('falls back per key, keeping the good ones', () => {
    const rows = routingMatrixRows(JSON.stringify({ loop: 'fast', verify: 'nonsense' }));
    expect(rows.find((r) => r.key === 'loop')!.value).toBe('fast');
    expect(rows.find((r) => r.key === 'verify')!.value).toBe('balanced');
  });

  it('ignores unknown keys instead of rendering rows for them', () => {
    const rows = routingMatrixRows(JSON.stringify({ notAGate: 'fast' }));
    expect(rows.some((r) => (r.key as string) === 'notAGate')).toBe(false);
  });

  /** The expensive gate needs its cost named, or nobody knows why it matters. */
  it('says why debate synthesis is the one to watch', () => {
    const row = routingMatrixRows('{}').find((r) => r.key === 'debateSynthesis')!;
    expect(row.description).toContain('38.3%');
  });
});

describe('routingMatrixToJson', () => {
  /** A partial blob silently changes meaning if a default ever moves. */
  it('writes every key, not only the overrides', () => {
    const rows = withRoutingValue(routingMatrixRows('{}'), 'loop', 'fast');
    const parsed = JSON.parse(routingMatrixToJson(rows));
    expect(Object.keys(parsed).sort())
      .toEqual(Object.keys(DEFAULT_ORCHESTRATION_ROUTING_POLICY).sort());
    expect(parsed.loop).toBe('fast');
  });

  it('round-trips without drift', () => {
    const rows = withRoutingValue(routingMatrixRows('{}'), 'review', 'powerful');
    expect(routingMatrixRows(routingMatrixToJson(rows)).find((r) => r.key === 'review')!.value)
      .toBe('powerful');
  });
});

describe('withRoutingValue', () => {
  it('changes only the row asked for', () => {
    const rows = routingMatrixRows('{}');
    const next = withRoutingValue(rows, 'loop', 'fast');
    expect(next.find((r) => r.key === 'loop')!.value).toBe('fast');
    expect(next.find((r) => r.key === 'verify')!.value)
      .toBe(rows.find((r) => r.key === 'verify')!.value);
  });

  it('clears the override flag when set back to the default', () => {
    const rows = withRoutingValue(routingMatrixRows('{}'), 'loop', 'fast');
    expect(withRoutingValue(rows, 'loop', 'balanced').find((r) => r.key === 'loop')!.overridden)
      .toBe(false);
  });
});

describe('tierLabel', () => {
  it('says what each tier costs you, not just its name', () => {
    expect(tierLabel('fast')).toContain('cheapest');
    expect(tierLabel('powerful')).toContain('most expensive');
    expect(tierLabel('auto')).toContain('router decides');
  });

  it('labels every offered tier', () => {
    for (const tier of ROUTING_MATRIX_TIERS) {
      expect(tierLabel(tier).length, tier).toBeGreaterThan(4);
    }
  });
});
