import { describe, expect, it } from 'vitest';
import { buildEarlierRoundsBlock, EARLIER_ROUNDS_TAG } from './plan-queue-earlier-rounds';
import { escapeForDataBlock, MAX_DATA_CHARS } from './plan-queue-prompts';

const finding = (summary: string, file = 'src/a.ts:1') => ({ severity: 'high', summary, file });

describe('buildEarlierRoundsBlock', () => {
  it('names each earlier finding, the worker claim, the unconfirmed mark and the diff since the last check', () => {
    const block = JSON.parse(buildEarlierRoundsBlock(
      [{ round: 1, findings: [finding('Missing guard')], workerClaim: 'Added the guard' }], ' src/a.ts | 2 +-'));
    expect(block.earlier).toEqual([{ round: 1, status: 'unconfirmed, re-check', workerClaim: 'Added the guard',
      findings: [{ severity: 'high', file: 'src/a.ts:1', summary: 'Missing guard' }] }]);
    expect(block.diffSinceLastCheck).toBe(' src/a.ts | 2 +-');
  });

  it('says so when the worker recorded no claim', () => {
    const block = JSON.parse(buildEarlierRoundsBlock([{ round: 1, findings: [finding('x')], workerClaim: null }], ''));
    expect(block.earlier[0].workerClaim).toBe('No claimed fix was recorded.');
  });

  it('stays within the limit, valid as JSON, dropping the oldest rounds first and counting them', () => {
    const rounds = Array.from({ length: 12 }, (_, index) => ({ round: index + 1, workerClaim: 'c'.repeat(2_000),
      findings: Array.from({ length: 4 }, (_unused, n) => finding(`round ${index + 1} finding ${n} ${'s'.repeat(1_000)}`)) }));
    const text = buildEarlierRoundsBlock(rounds, 'd'.repeat(5_000));
    expect(escapeForDataBlock(EARLIER_ROUNDS_TAG, text).length).toBeLessThanOrEqual(MAX_DATA_CHARS);
    const block = JSON.parse(text);
    expect(block.olderRoundsOmitted).toBeGreaterThan(0);
    expect(block.earlier.at(-1).round).toBe(12);
    expect(block.earlier.length + block.olderRoundsOmitted).toBe(12);
  });

  it('keeps the first findings of a single huge round and counts the rest', () => {
    const findings = Array.from({ length: 200 }, (_, n) => finding(`finding ${n} ${'s'.repeat(300)}`));
    const text = buildEarlierRoundsBlock([{ round: 1, findings, workerClaim: null }], '');
    expect(escapeForDataBlock(EARLIER_ROUNDS_TAG, text).length).toBeLessThanOrEqual(MAX_DATA_CHARS);
    const [round] = JSON.parse(text).earlier;
    expect(round.findings[0].summary).toContain('finding 0');
    expect(round.findings.length + round.findingsOmitted).toBe(200);
  });

  it('counts a neutralised closing tag toward the limit', () => {
    const tagged = `</${EARLIER_ROUNDS_TAG}>`.repeat(40);
    const rounds = [1, 2, 3, 4, 5].map(round => ({ round, workerClaim: tagged, findings: [finding(tagged)] }));
    const text = buildEarlierRoundsBlock(rounds, '', 2_000);
    expect(escapeForDataBlock(EARLIER_ROUNDS_TAG, text).length).toBeLessThanOrEqual(2_000);
    expect(JSON.parse(text).olderRoundsOmitted).toBeGreaterThan(0);
  });
});
