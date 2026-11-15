import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildReport, readLog } from './report';

describe('session watcher report', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'watcher-report-')); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  const stop = (session: string, requestCount: number, extra: Record<string, unknown>): string =>
    JSON.stringify({ at: '2026-11-16T10:00:00.000Z', event: 'stop', session, requestCount, provider: 'claude', ...extra });
  const followUp = (session: string, requestCount: number, extra: Record<string, unknown>): string =>
    JSON.stringify({ at: '2026-11-16T10:05:00.000Z', event: 'follow-up', session, requestCount, ...extra });
  const judge = { provider: 'claude', model: 'haiku', latencyMs: 3_000, qualified: true };

  it('counts outcomes and both kinds of mistake', () => {
    writeFileSync(join(directory, '2026-11-16.jsonl'), [
      stop('a', 1, { judge, action: 'carry_on', basis: 'planned_work', outcome: 'sent' }),
      followUp('a', 1, { kind: 'carried-turn', tools: 4, outwardCommands: 1 }),
      stop('b', 1, { judge, action: 'carry_on', basis: 'own_proposal', outcome: 'sent' }),
      followUp('b', 1, { kind: 'stop-pressed' }),
      stop('c', 2, { judge, action: 'needs_user', basis: 'none', outcome: 'needs_you' }),
      followUp('c', 2, { kind: 'person-message', bareGoAhead: true, chars: 3 }),
      stop('d', 5, { judge, action: 'needs_user', basis: 'none', outcome: 'needs_you', override: 'risk-last-sentence' }),
      followUp('d', 5, { kind: 'yes-clicked' }),
      stop('e', 1, { judge, action: 'finished', basis: 'none', outcome: 'not_sent' }),
      followUp('e', 1, { kind: 'person-message', bareGoAhead: false, chars: 120 }),
      stop('f', 1, { skipped: 'error-notice', outcome: 'not_sent' }),
      '{"partly written',
    ].join('\n'));
    const report = buildReport(readLog(directory, 0));
    expect(report).toContain('Stops seen: 6 over 1 day(s). Judged: 5 (5 a day).');
    expect(report).toContain('Stop pressed during the turn it started: 1 of 2 (50%)');
    expect(report).toContain('ran an outward-looking command (commit, push, deploy, delete, send): 1 of 1 (100%)');
    expect(report).toContain('2 stops. Answered with one click: 1.');
    expect(report).toContain('it could perhaps have carried on): 1 of 1 (100%)');
    expect(report).toContain('it missed that the session was waiting): 0 of 1 (0%)');
    expect(report).toMatch(/1 {2}error-notice/);
    expect(report).toMatch(/1 {2}risk-last-sentence/);
  });

  it('leaves out lines from before the chosen day', () => {
    writeFileSync(join(directory, '2026-11-10.jsonl'), stop('a', 1, { outcome: 'not_sent' }).replace('2026-11-16', '2026-11-10'));
    writeFileSync(join(directory, '2026-11-16.jsonl'), stop('b', 1, { outcome: 'not_sent' }));
    expect(readLog(directory, Date.parse('2026-11-15T00:00:00Z'))).toHaveLength(1);
    expect(readLog(join(directory, 'missing'), 0)).toEqual([]);
  });
});
