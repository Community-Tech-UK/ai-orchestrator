import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// October's 16 planned settings need about 64 type lines and 80 policy lines,
// plus comments/refinements. Preserve another 50 lines of working margin.
describe('October settings headroom', () => {
  it('leaves at least 130 lines for new settings without raising ceilings', () => {
    for (const [file, cap] of [
      ['src/shared/types/settings.types.ts', 889],
      ['src/main/core/config/settings-control-policy.ts', 890],
    ] as const) {
      const lines = readFileSync(resolve(__dirname, '../..', file), 'utf8').split('\n').length;
      expect(cap - lines, file).toBeGreaterThanOrEqual(130);
    }
  });
});
