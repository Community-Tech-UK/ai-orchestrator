import { describe, expect, it } from 'vitest';
import { combineRows, pickCeiling, replay, simulateSession } from '../context-ceiling-replay.mjs';
import { p90 } from '../lib/claude-transcripts.mjs';

const prices = { fixture: { inputPerMTok: 1, outputPerMTok: 1 } };
function session(summaries: number, className = 'plan-queue') {
  const contexts = Array.from({ length: summaries }, (_, i) => 200_000 + i * 140_000);
  contexts.push(...Array<number>(10).fill(contexts.at(-1) ?? 0));
  return { className, requests: contexts.map((context, at) => ({
    at, context, model: 'fixture', input: 0, cacheRead: 0, cacheWrite5m: context, cacheWrite1h: 0, output: 10,
  })) };
}
describe('Harness replay summary population', () => {
  it('rejects a ceiling when actual session p90 is five although the class median is one', () => {
    const sessions = [1, 1, 1, 1, 1, 1, 1, 1, 5, 5].map(n => session(n));
    const counts = sessions.map(s => simulateSession(s.requests, 200_000, 40_000, 1000, prices).summaries);
    expect(counts).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 5, 5]);
    const rows = replay(sessions, 40_000, 1000, prices);
    const combined = combineRows(rows, ['plan-queue']);
    expect(rows['plan-queue']['200000'].summariesP50).toBe(1);
    expect(combined['200000'].summariesP90).toBe(p90(counts));
    expect(combined['200000'].summariesP90).toBe(5);
    expect(pickCeiling(combined, 3).ceiling).not.toBe(200_000);
  });

  it('weights individual sessions across unequal classes and excludes nonsummarising sessions', () => {
    const sessions = [session(5, 'loop'), ...Array.from({ length: 10 }, () => session(1)), session(0, 'loop')];
    const combined = combineRows(replay(sessions, 40_000, 1000, prices), ['plan-queue', 'loop']);
    expect(combined['200000'].sessions).toBe(12);
    expect(combined['200000'].summarisingShare).toBeCloseTo(11 / 12);
    expect(combined['200000'].summariesP90).toBe(1);
    const uniform = combineRows(replay([session(3), session(3)], 40_000, 1000, prices), ['plan-queue']);
    expect(uniform['200000'].summariesP90).toBe(3);
    expect(pickCeiling(uniform, 3).ceiling).toBe(200_000);
    const empty = combineRows({}, []);
    expect(empty['200000'].summariesP90).toBeNull();
    expect(pickCeiling(empty, 3).ceiling).toBeNull();
  });
});
