import { describe, expect, it } from 'vitest';
import { analyze } from '../ui-hints/analyze';
import { compare, measure, readBaseline } from '../ui-hints/baseline.js';
import { checkLedger, readLedger } from '../ui-hints/wording-ledger.js';
const analysis = analyze(process.cwd());
const ledger = readLedger('scripts/ui-hints/wording-ledger.json');
describe('committed UI hints records', () => {
  it('exactly match source counts and carry every active recorded sentence', () => {
    expect(analysis.counts['controls']).toBeGreaterThan(1000);
    expect(analysis.violations.filter(v => v.code === 'H12')).toEqual([]);
    expect(compare(measure(analysis), readBaseline('scripts/ui-hints/baseline.json'))).toEqual([]);
    expect(checkLedger(analysis, ledger)).toEqual([]); expect(ledger.length).toBeGreaterThan(50);
  });
  it('pins both real Close session consequences to their owner', () => {
    const close = ledger.filter(entry => entry.owner.endsWith('instance-row.component.ts') && entry.text.startsWith('Close session'));
    expect(close.some(entry => entry.text.includes('stops this child agent') && entry.text.includes('removes it from the tree'))).toBe(true);
    expect(close.some(entry => entry.text.includes('stops the agent') && entry.text.includes('moves this thread to history'))).toBe(true);
  });
});
