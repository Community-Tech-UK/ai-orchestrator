import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { appendCodexEphemeralUsage, readCodexEphemeralUsage } from './codex-ephemeral-usage-store';
import type { CodexEphemeralUsage } from '../../../shared/types/codex-ephemeral-usage.types';
const electronPaths = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => electronPaths.userData } }));
const tokens = { input: 10, cache: 4, output: 2, reasoning: null, total: 12, estimated: false };
function row(threadId: string): CodexEphemeralUsage {
  return { version: 1, threadId, jobId: null, instanceId: null, kind: 'review', trialKey: null, trialArm: 'unassigned',
    requests: null, requestsAvailable: false, tokens, helpers: { count: 0, tokens }, compactions: 0,
    startedAt: 100, endedAt: 120, durationMs: 20, finishReason: 'stopped' };
}
describe('Codex ephemeral usage log boundary', () => {
  let dir: string; let file: string;
  beforeEach(() => { mkdirSync(resolve('_scratch'), { recursive: true }); dir = mkdtempSync(resolve('_scratch/step13-store-')); file = join(dir, 'usage.jsonl'); electronPaths.userData = dir; });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it('uses the app userData logs directory by default', () => {
    appendCodexEphemeralUsage(row('default-file'));
    expect(JSON.parse(readFileSync(join(dir,'logs','codex-ephemeral-usage.jsonl'),'utf8'))).toMatchObject({threadId:'default-file'});
    expect(readCodexEphemeralUsage().entries).toEqual([row('default-file')]);
  });
  it('round trips durable numeric receipts and rejects message-bearing records before writing', () => {
    appendCodexEphemeralUsage(row('one'), file);
    expect(readCodexEphemeralUsage(file).entries).toEqual([row('one')]);
    expect(() => appendCodexEphemeralUsage({ ...row('two'), content: 'PRIVATE_CONTENT' } as CodexEphemeralUsage, file)).toThrow();
    expect(readFileSync(file, 'utf8')).not.toContain('PRIVATE_CONTENT');
  });
  it('reads newest first across rotations, skips malformed/untrusted/partial lines, and deduplicates', () => {
    writeFileSync(file + '.1', JSON.stringify(row('old')) + '\n' + JSON.stringify(row('duplicate')) + '\n');
    writeFileSync(file, 'invalid\n' + JSON.stringify({ ...row('unsafe'), tokens: { ...tokens, output: 'PRIVATE_CONTENT' } })
      + '\n' + JSON.stringify(row('duplicate')) + '\n' + JSON.stringify(row('new')) + '\n' + JSON.stringify(row('unfinished')));
    expect(readCodexEphemeralUsage(file, 2)).toMatchObject({ entries: [{threadId:'new'}, {threadId:'duplicate'}], truncated: true, skippedLines: 3 });
    expect(readCodexEphemeralUsage(file, 10).entries.map(row => row.threadId)).toEqual(['new', 'duplicate', 'old']);
  });
  it('repairs a crash-truncated last line before appending so the next valid receipt is readable', () => {
    writeFileSync(file, JSON.stringify(row('first')) + '\n{"unfinished":');
    appendCodexEphemeralUsage(row('next'), file);
    expect(readCodexEphemeralUsage(file).entries.map(row => row.threadId)).toEqual(['next', 'first']);
  });
  it('bounds oversized files and rotates on append', () => {
    writeFileSync(file, 'x'.repeat(2 * 1024 * 1024 + 20) + '\n' + JSON.stringify(row('tail')) + '\n');
    expect(readCodexEphemeralUsage(file)).toMatchObject({entries:[{threadId:'tail'}],truncated:true});
    appendCodexEphemeralUsage(row('current'), file);
    expect(readCodexEphemeralUsage(file).entries.map(row => row.threadId)).toEqual(['current', 'tail']);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1); expect(JSON.parse(lines[0])).toEqual(row('current'));
  });
  it.each([0, -1, 1.5, 1001])('rejects an out of bounds read limit %s', limit => {
    expect(() => readCodexEphemeralUsage(file, limit)).toThrow('Invalid usage limit');
  });
});
