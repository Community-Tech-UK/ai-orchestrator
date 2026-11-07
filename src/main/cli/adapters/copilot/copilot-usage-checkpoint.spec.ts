import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copilotEventsPath, parseCopilotCheckpointLine, readCopilotCheckpointTail } from './copilot-usage-checkpoint';

const line = (id: string, total: number) => JSON.stringify({ type: 'session.usage_checkpoint', id,
  timestamp: '2026-10-20T12:00:00Z', data: { totalNanoAiu: total, totalPremiumRequests: 2,
    modelCacheState: [{ modelId: 'model', cacheExpiresAt: '2026-10-20T12:05:00Z', cacheTtlSeconds: 300 }] } });
describe('Copilot checkpoint reader', () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
  it('reads both checkpoint versions and float totals without reading accountingSnapshot as the bill', () => {
    expect(parseCopilotCheckpointLine(line('a', 12.5))).toMatchObject({ eventId: 'a', totalNanoAiu: 12.5,
      modelCache: [{ modelId: 'model', ttlSeconds: 300 }] });
    const latest = JSON.parse(line('b', 20)); latest.data.accountingSnapshot = { totalNanoAiu: 1 };
    expect(parseCopilotCheckpointLine(JSON.stringify(latest))?.totalNanoAiu).toBe(20);
    expect(parseCopilotCheckpointLine('{')).toBeUndefined();
    expect(parseCopilotCheckpointLine(JSON.stringify({ type: 'user.message', data: {} }))).toBeUndefined();
  });
  it('returns last and previous complete checkpoints and skips a partial final line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkpoint-')); dirs.push(dir);
    const path = join(dir, 'events.jsonl');
    await writeFile(path, `${line('a', 5)}\n${line('b', 10)}\n${line('partial', 30)}`);
    expect(await readCopilotCheckpointTail(path)).toMatchObject({ last: { eventId: 'b' }, previous: { eventId: 'a' },
      truncated: false });
    await writeFile(path, 'no checkpoint\n');
    expect(await readCopilotCheckpointTail(path)).toEqual({ truncated: false });
    await writeFile(path, `${line('only', 5)}\n`);
    expect(await readCopilotCheckpointTail(path)).toEqual({ last: expect.objectContaining({ eventId: 'only' }),
      truncated: false });
  });
  it('expands past 256 KiB for the previous checkpoint and marks a tail beyond 1 MiB truncated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkpoint-')); dirs.push(dir);
    const path = join(dir, 'events.jsonl');
    const filler = (bytes: number) => JSON.stringify({ type: 'tool_use', data: 'x'.repeat(bytes) });
    await writeFile(path, `${line('previous', 5)}\n${filler(300 * 1024)}\n${line('current', 10)}\n`);
    expect(await readCopilotCheckpointTail(path)).toMatchObject({ last: { eventId: 'current' },
      previous: { eventId: 'previous' }, truncated: false });
    await writeFile(path, `${line('first', 5)}\n${filler(1300 * 1024)}\n${line('current', 10)}\n`);
    const tail = await readCopilotCheckpointTail(path);
    expect(tail).toMatchObject({ last: { eventId: 'current' }, truncated: true });
    expect(tail.previous).toBeUndefined();
  });
  it('refuses path traversal on either platform', () => {
    for (const id of ['../bad', 'a/b', 'a\\b', '..', '']) expect(() => copilotEventsPath('/home', id)).toThrow();
    expect(copilotEventsPath('/home', 'safe-session')).toBe(join('/home', 'session-state', 'safe-session', 'events.jsonl'));
  });
});
