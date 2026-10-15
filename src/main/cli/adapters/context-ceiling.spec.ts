import { expect, it } from 'vitest';
import { resolveContextCeilingTokens, selfCompactThreshold } from './context-ceiling';
it('selects chat or machine settings, disabled by default and clamps enabled ceilings', () => {
 const read = (key: string) => key === 'machineContextCeilingTokens' ? 120_000 : 200_000;
 expect(resolveContextCeilingTokens(false, read)).toBe(200_000);
 expect(resolveContextCeilingTokens(true, read)).toBe(120_000);
 expect(resolveContextCeilingTokens(false, () => 0)).toBeUndefined();
 expect(resolveContextCeilingTokens(true, () => 1)).toBe(100_000);
 expect(resolveContextCeilingTokens(true, () => 2_000_000)).toBe(1_000_000);
 expect(selfCompactThreshold(1_000_000, 120_000)).toBe(87_000);
 expect(selfCompactThreshold(200_000)).toBe(167_000);
});
