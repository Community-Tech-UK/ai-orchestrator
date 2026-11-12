import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
type Summary = Record<string, unknown>;
const { format, readRuns, summarise } = require('./report.js') as {
  format: (summary: Summary) => string;
  readRuns: (dir: string) => Record<string, unknown>[];
  summarise: (runs: Record<string, unknown>[], since?: string, names?: Record<string, string>) => Summary;
};

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function logFolder(lines: string[], older: string[] = []): string {
  const folder = mkdtempSync(join(tmpdir(), 'where-work-ran-'));
  folders.push(folder);
  writeFileSync(join(folder, 'runs.jsonl'), lines.join('\n'));
  if (older.length) writeFileSync(join(folder, 'runs.old.jsonl'), older.join('\n'));
  return folder;
}

const line = (run: Record<string, unknown>) => JSON.stringify({ ranOn: 'pc', tookMs: 60_000, fellBackBecause: null, ...run });

describe('where work ran', () => {
  it('groups each day by kind and computer, with minutes and why runs stayed here', () => {
    const runs = readRuns(logFolder([
      line({ at: '2026-11-06T10:00:00Z' }),
      line({ at: '2026-11-06T11:00:00Z', ranOn: 'mac', tookMs: 120_000, fellBackBecause: 'the PC could not be reached' }),
      line({ at: '2026-11-06T12:00:00Z', ranOn: 'mac', kind: 'local', tookMs: 30_000 }),
      line({ at: '2026-11-06T13:00:00Z', ranOn: 'ct-test-mac', kind: 'ios', tookMs: 120_000 }),
      '{"at": "half a line',
    ], [line({ at: '2026-11-05T10:00:00Z' })]));
    expect(runs).toHaveLength(5);
    expect(format(summarise(runs, '2026-11-06', { pc: 'the Windows PC', 'ct-test-mac': 'the test Mac' }))).toBe([
      '2026-11-06',
      '  full test runs: 1 on the Windows PC (1 min), 1 on this Mac (2 min)',
      '  small test runs: 1 on this Mac (1 min)',
      '  iPhone builds and simulators: 1 on the test Mac (2 min)',
      '  ran here 1x because the PC could not be reached',
    ].join('\n'));
  });

  it('lists a run no machine took as not run, never as a computer', () => {
    const runs = readRuns(logFolder([line({ at: '2026-11-06T10:00:00Z', ranOn: 'none', kind: 'targeted', tookMs: 0 })]));
    expect(format(summarise(runs, '2026-11-06'))).toContain('long test lists: 1 on no computer (not run)');
  });

  it('says so when there is nothing to report', () => {
    expect(format(summarise(readRuns(join(tmpdir(), 'no-such-folder'))))).toBe('No runs recorded.');
  });
});
