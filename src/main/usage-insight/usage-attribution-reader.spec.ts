import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsageAttributionReader, compressEfforts } from './usage-attribution-reader';

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-18T10:00:00Z');

function row(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: T0,
    source: 'instance-turn',
    taskType: 'chat:build',
    instanceId: 'inst-1',
    parentId: null,
    provider: 'claude',
    model: 'claude-opus-5',
    usage: { inputTokens: 10, outputTokens: 5 },
    ...overrides,
  });
}

describe('UsageAttributionReader', () => {
  let directory: string;
  let reader: UsageAttributionReader;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'usage-attribution-'));
    reader = new UsageAttributionReader(() => directory);
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  const day = (date: string, rows: string[]): string => {
    const file = join(directory, `cost-attribution-${date}.jsonl`);
    writeFileSync(file, rows.map((line) => `${line}\n`).join(''));
    return file;
  };

  it('learns which Claude session ran as which Harness session', async () => {
    day('2026-10-18', [row({ sessionId: 'claude-session-1', instanceId: 'inst-1' }), row({ sessionId: 'claude-session-2', instanceId: 'inst-2' })]);
    const digest = await reader.read(T0 - DAY);
    expect([...digest.sessionToInstance]).toEqual([['claude-session-1', 'inst-1'], ['claude-session-2', 'inst-2']]);
  });

  it('records which sessions were started as helpers for another', async () => {
    day('2026-10-18', [
      row({ instanceId: 'child', parentId: 'parent' }),
      row({ instanceId: 'parent', parentId: null }),
    ]);
    const digest = await reader.read(T0 - DAY);
    expect([...digest.parentByInstance]).toEqual([['child', 'parent']]);
  });

  it('collects the effort setting of each turn, oldest first', async () => {
    day('2026-10-18', [
      row({ ts: T0 + 3000, reasoningEffort: 'max' }),
      row({ ts: T0 + 1000, reasoningEffort: 'high' }),
      row({ ts: T0 + 2000 }),
    ]);
    const digest = await reader.read(T0 - DAY);
    expect(digest.effortByInstance.get('inst-1')).toEqual([
      { at: T0 + 1000, effort: 'high' },
      { at: T0 + 3000, effort: 'max' },
    ]);
  });

  it('ignores turns that are not Claude instance turns', async () => {
    day('2026-10-18', [
      row({ provider: 'codex', reasoningEffort: 'high', sessionId: 'codex-thread', instanceId: 'codex-1' }),
      row({ source: 'one-shot', reasoningEffort: 'high', instanceId: 'oneshot' }),
      row({ source: 'auxiliary', taskType: 'aux:title', instanceId: 'aux' }),
      row({ provider: undefined, reasoningEffort: 'high', instanceId: 'no-provider' }),
    ]);
    const digest = await reader.read(T0 - DAY);
    expect(digest.effortByInstance.size).toBe(0);
    expect(digest.sessionToInstance.size).toBe(0);
  });

  it('reads the provider name of a Claude CLI turn too', async () => {
    day('2026-10-18', [row({ provider: 'claude-cli', reasoningEffort: 'max', sessionId: 's' })]);
    const digest = await reader.read(T0 - DAY);
    expect(digest.sessionToInstance.get('s')).toBe('inst-1');
  });

  it('skips damaged lines and lines without the facts it needs', async () => {
    day('2026-10-18', ['{"source":"instance-turn","provider":"claude","instanceId":', row({ instanceId: undefined, reasoningEffort: 'max' }), row({ ts: 'noon', reasoningEffort: 'max' }), row({ reasoningEffort: 'max' })]);
    const digest = await reader.read(T0 - DAY);
    expect(digest.effortByInstance.get('inst-1')).toEqual([{ at: T0, effort: 'max' }]);
  });

  it('leaves out day files from before the window and effort points older than it', async () => {
    day('2026-10-01', [row({ reasoningEffort: 'max', sessionId: 'ancient' })]);
    day('2026-10-18', [row({ ts: T0, reasoningEffort: 'high' }), row({ ts: T0 - 5 * DAY, reasoningEffort: 'max' })]);
    const digest = await reader.read(T0 - DAY);
    expect(digest.sessionToInstance.has('ancient')).toBe(false);
    expect(digest.effortByInstance.get('inst-1')).toEqual([{ at: T0, effort: 'high' }]);
  });

  it('puts efforts from several days together', async () => {
    day('2026-10-17', [row({ ts: T0 - DAY, reasoningEffort: 'high' })]);
    day('2026-10-18', [row({ ts: T0, reasoningEffort: 'max' })]);
    const digest = await reader.read(T0 - 3 * DAY);
    expect(digest.effortByInstance.get('inst-1')).toEqual([{ at: T0 - DAY, effort: 'high' }, { at: T0, effort: 'max' }]);
  });

  it('picks up lines added later without reading the file again, and waits for a half-written line', async () => {
    const file = day('2026-10-18', [row({ ts: T0, reasoningEffort: 'high' })]);
    await reader.read(T0 - DAY);
    const later = row({ ts: T0 + 1000, reasoningEffort: 'max', sessionId: 'new-session' });
    appendFileSync(file, `${later.slice(0, 40)}`);
    let digest = await reader.read(T0 - DAY);
    expect(digest.sessionToInstance.has('new-session')).toBe(false);
    appendFileSync(file, `${later.slice(40)}\n`);
    digest = await reader.read(T0 - DAY);
    expect(digest.sessionToInstance.get('new-session')).toBe('inst-1');
    expect(digest.effortByInstance.get('inst-1')).toEqual([{ at: T0, effort: 'high' }, { at: T0 + 1000, effort: 'max' }]);
  });

  it('forgets a day file that has gone', async () => {
    const file = day('2026-10-18', [row({ reasoningEffort: 'max' })]);
    await reader.read(T0 - DAY);
    rmSync(file);
    expect((await reader.read(T0 - DAY)).effortByInstance.size).toBe(0);
  });

  it('counts a day file it could not read instead of quietly dropping it', async () => {
    // A folder where the day file should be: it can be listed but not read as a file.
    mkdirSync(join(directory, 'cost-attribution-2026-10-17.jsonl'));
    day('2026-10-18', [row({ reasoningEffort: 'max' })]);
    const digest = await reader.read(T0 - 3 * DAY);
    expect(digest.unreadableFiles).toBe(1);
    expect(digest.effortByInstance.get('inst-1')).toEqual([{ at: T0, effort: 'max' }]);
    expect((await new UsageAttributionReader(() => null).read(T0)).unreadableFiles).toBe(0);
  });

  it('gives an empty result when there is no log folder', async () => {
    const empty = await new UsageAttributionReader(() => null).read(T0);
    expect(empty.effortByInstance.size + empty.parentByInstance.size + empty.sessionToInstance.size).toBe(0);
    const missing = await new UsageAttributionReader(() => join(directory, 'not-here')).read(T0);
    expect(missing.effortByInstance.size).toBe(0);
  });
});

describe('compressEfforts', () => {
  const point = (at: number, effort: string) => ({ at, effort });

  it('keeps the first and last point of each run of the same effort', () => {
    const points = [point(1, 'high'), point(2, 'high'), point(3, 'high'), point(4, 'max'), point(5, 'max'), point(6, 'high')];
    expect(compressEfforts(points)).toEqual([point(1, 'high'), point(3, 'high'), point(4, 'max'), point(5, 'max'), point(6, 'high')]);
  });

  it('leaves short lists as they are', () => {
    expect(compressEfforts([])).toEqual([]);
    expect(compressEfforts([point(1, 'high')])).toEqual([point(1, 'high')]);
    expect(compressEfforts([point(1, 'high'), point(2, 'high')])).toEqual([point(1, 'high'), point(2, 'high')]);
  });
});
