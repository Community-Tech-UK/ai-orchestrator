import { chmodSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UsageScanProgress } from '../../shared/usage-insight/usage-insight.types';
import { ClaudeTranscriptScanner, type ScanLimits } from './claude-transcript-usage-scanner';
import {
  FAKE_MODEL,
  appendTranscript,
  assistantLine,
  compactionLine,
  setModified,
  toolResultLine,
  writeTranscript,
  type FakeRequest,
} from './claude-transcript.test-helpers';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Minutes after the start of "yesterday", inside the 7-day window. */
const at = (minutes: number): number => NOW - DAY + minutes * MINUTE;

describe('ClaudeTranscriptScanner', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'claude-scan-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function path(name: string, rootDir = root): string {
    return join(rootDir, 'projects', '-proj', name);
  }

  function transcript(name: string, lines: string[], modified = NOW - MINUTE, rootDir = root): string {
    const file = path(name, rootDir);
    writeTranscript(file, lines);
    setModified(file, modified);
    return file;
  }

  function scanner(limits: Partial<ScanLimits> = {}, roots: string[] = [root]): ClaudeTranscriptScanner {
    return new ClaudeTranscriptScanner({ roots: () => roots, now: () => NOW, limits });
  }

  async function scan(limits: Partial<ScanLimits> = {}) {
    const instance = scanner(limits);
    await instance.refresh();
    return instance.collect();
  }

  const request = (id: string, minutes: number, extra: Partial<FakeRequest> = {}): string =>
    assistantLine({ id, at: at(minutes), ...extra });

  describe('requests', () => {
    it('keeps one fact per response and merges the lines of a response', async () => {
      transcript('a.jsonl', [
        request('1', 0, { input: 10, cacheRead: 1_000, output: 5 }),
        // The same response again, written as its next content block, now with the final output count.
        request('1', 0, { input: 10, cacheRead: 1_000, output: 40 }),
        request('2', 5, { input: 20, cacheWrite: 300, output: 8 }),
      ]);
      const result = await scan();
      expect(result.requests).toEqual([
        { sessionId: 'session-a', at: at(0), model: FAKE_MODEL, input: 10, cacheWrite: 0, cacheRead: 1_000, output: 40, helper: false, bigResult: false },
        { sessionId: 'session-a', at: at(5), model: FAKE_MODEL, input: 20, cacheWrite: 300, cacheRead: 0, output: 8, helper: false, bigResult: false },
      ]);
    });

    it('keeps no message text', async () => {
      transcript('a.jsonl', [request('1', 0)]);
      expect(JSON.stringify(await scan())).not.toContain('FAKE-REPLY');
    });

    it('marks helper agent requests and attributes them to the session that started them', async () => {
      transcript('main-session.jsonl', [request('1', 0, { sessionId: 'main-session' })]);
      transcript('agent-3.jsonl', [request('2', 1, { sessionId: 'main-session', sidechain: true, agentId: 'agent-3' })]);
      const nested = path('main-session/subagents/agent-8.jsonl');
      writeTranscript(nested, [request('3', 2, { sessionId: 'main-session', sidechain: true, agentId: 'agent-8' })]);
      setModified(nested, NOW - MINUTE);
      const requests = (await scan()).requests.sort((a, b) => a.at - b.at);
      expect(requests.map((entry) => [entry.sessionId, entry.helper])).toEqual([
        ['main-session', false],
        ['main-session', true],
        ['main-session', true],
      ]);
    });

    it('falls back to the file name when a line has no session id', async () => {
      const line = JSON.stringify({
        type: 'assistant', timestamp: new Date(at(0)).toISOString(),
        message: { id: 'm', model: 'claude-opus-5', usage: { input_tokens: 5, output_tokens: 1 } },
      });
      transcript('from-file-name.jsonl', [line]);
      expect((await scan()).requests[0].sessionId).toBe('from-file-name');
    });

    it('counts a response copied into a forked session once, under the session that had it first', async () => {
      transcript('a-original.jsonl', [request('1', 0, { sessionId: 'original' }), request('2', 5, { sessionId: 'original' })]);
      transcript('b-fork.jsonl', [
        request('1', 0, { sessionId: 'fork' }),
        request('2', 5, { sessionId: 'fork' }),
        request('3', 10, { sessionId: 'fork' }),
      ]);
      const requests = (await scan()).requests.sort((a, b) => a.at - b.at);
      expect(requests.map((entry) => entry.sessionId)).toEqual(['original', 'original', 'fork']);
    });

    it('leaves out requests from before the window', async () => {
      transcript('a.jsonl', [
        assistantLine({ id: 'old', at: NOW - 9 * DAY }),
        request('new', 0),
      ]);
      expect((await scan()).requests.map((entry) => entry.at)).toEqual([at(0)]);
    });

    it('only opens transcripts touched inside the window', async () => {
      transcript('stale.jsonl', [request('1', 0)], NOW - 8 * DAY);
      transcript('fresh.jsonl', [request('2', 1)], NOW - MINUTE);
      expect((await scan()).requests).toHaveLength(1);
    });

    it('reads every config home it is given', async () => {
      const other = mkdtempSync(join(tmpdir(), 'claude-scan-other-'));
      try {
        transcript('one.jsonl', [request('1', 0)]);
        transcript('two.jsonl', [request('2', 1)], NOW - MINUTE, other);
        const both = scanner({}, [root, other]);
        await both.refresh();
        expect(both.collect().requests).toHaveLength(2);
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });
  });

  describe('how big a session started', () => {
    it("records the prompt size of the session's first request, even from before the window", async () => {
      transcript('a.jsonl', [
        assistantLine({ id: 'first', at: NOW - 9 * DAY, input: 5_000, cacheWrite: 55_000 }),
        request('later', 0, { input: 10, cacheRead: 120_000 }),
      ]);
      const result = await scan();
      expect(result.sessionStarts.get('session-a')).toBe(60_000);
      expect(result.requests).toHaveLength(1);
    });

    it("never takes a helper agent's request as the start", async () => {
      transcript('a.jsonl', [
        request('helper', 0, { sidechain: true, agentId: 'h', input: 90_000 }),
        request('main', 1, { input: 30_000 }),
      ]);
      expect((await scan()).sessionStarts.get('session-a')).toBe(30_000);
    });

    it('keeps the earliest start when two files carry the same session', async () => {
      transcript('a.jsonl', [request('1', 5, { input: 70_000 })]);
      transcript('b.jsonl', [request('2', 1, { input: 20_000 })]);
      expect((await scan()).sessionStarts.get('session-a')).toBe(20_000);
    });
  });

  describe('big tool results', () => {
    const flags = (requests: { bigResult: boolean }[]): boolean[] => requests.map((entry) => entry.bigResult);

    it('flags requests while a result over 10K tokens is in the chat, until it is compacted or cut', async () => {
      transcript('a.jsonl', [
        request('r1', 0, { input: 20_000 }),
        toolResultLine({ chars: 200_000, at: at(1) }),
        request('r2', 2, { input: 70_000 }),
        request('r3', 3, { input: 71_000 }),
        compactionLine(at(4)),
        request('r4', 5, { input: 25_000 }),
        toolResultLine({ chars: 100_000, at: at(6) }),
        request('r5', 7, { input: 26_000 }),
        // The prompt halves: the chat was cut down, so the big result is gone.
        request('r6', 8, { input: 8_000 }),
        toolResultLine({ chars: 8_000, at: at(9) }),
        request('r7', 10, { input: 9_000 }),
      ]);
      const requests = (await scan()).requests.sort((a, b) => a.at - b.at);
      expect(flags(requests)).toEqual([false, true, true, false, true, false, false]);
    });

    it("keeps a helper agent's big results out of the main chat, and the other way round", async () => {
      transcript('a.jsonl', [
        request('main-1', 0, { input: 10_000 }),
        toolResultLine({ chars: 200_000, at: at(1), sidechain: true, agentId: 'h1' }),
        request('main-2', 2, { input: 11_000 }),
        request('helper-1', 3, { input: 12_000, sidechain: true, agentId: 'h1' }),
        request('helper-other', 4, { input: 12_000, sidechain: true, agentId: 'h2' }),
      ]);
      const requests = (await scan()).requests.sort((a, b) => a.at - b.at);
      expect(flags(requests)).toEqual([false, false, true, false]);
    });

    it('does not flag results at the limit', async () => {
      transcript('a.jsonl', [
        request('r1', 0),
        toolResultLine({ chars: 40_000, at: at(1) }),
        request('r2', 2),
      ]);
      expect(flags((await scan()).requests)).toEqual([false, false]);
    });
  });

  describe('reading again', () => {
    it('reads only what was added, and finishes a line that was still being written', async () => {
      const file = transcript('a.jsonl', [request('1', 0), request('2', 1)]);
      const instance = scanner();
      const progress: UsageScanProgress[] = [];
      await instance.refresh((value) => progress.push(value));
      expect(instance.collect().requests).toHaveLength(2);
      const firstBytes = progress.at(-1)!.bytesTotal;

      const third = request('3', 2);
      const fourth = request('4', 3);
      appendTranscript(file, `${third}\n${fourth.slice(0, 30)}`);
      setModified(file, NOW - MINUTE);
      progress.length = 0;
      await instance.refresh((value) => progress.push(value));
      expect(instance.collect().requests).toHaveLength(3);
      expect(progress.at(-1)!.bytesTotal).toBeLessThan(firstBytes);

      appendTranscript(file, `${fourth.slice(30)}\n`);
      setModified(file, NOW - MINUTE);
      await instance.refresh();
      expect(instance.collect().requests.map((entry) => entry.at)).toEqual([at(0), at(1), at(2), at(3)]);
    });

    it('does no work for a file that has not changed', async () => {
      transcript('a.jsonl', [request('1', 0)]);
      const instance = scanner();
      await instance.refresh();
      const progress: UsageScanProgress[] = [];
      await instance.refresh((value) => progress.push(value));
      expect(progress.at(-1)).toMatchObject({ filesTotal: 0, bytesTotal: 0 });
      expect(instance.collect().requests).toHaveLength(1);
    });

    it('carries the big-result state across a refresh', async () => {
      const file = transcript('a.jsonl', [request('r1', 0, { input: 10_000 }), toolResultLine({ chars: 200_000, at: at(1) })]);
      const instance = scanner();
      await instance.refresh();
      appendTranscript(file, `${request('r2', 2, { input: 60_000 })}\n`);
      setModified(file, NOW - MINUTE);
      await instance.refresh();
      expect(instance.collect().requests.map((entry) => entry.bigResult)).toEqual([false, true]);
    });

    it('starts over for a file that was rewritten shorter', async () => {
      const file = transcript('a.jsonl', [request('1', 0), request('2', 1)]);
      const instance = scanner();
      await instance.refresh();
      writeFileSync(file, `${request('9', 7)}\n`);
      setModified(file, NOW - MINUTE);
      await instance.refresh();
      expect(instance.collect().requests.map((entry) => entry.at)).toEqual([at(7)]);
    });

    it('forgets a file that has gone', async () => {
      const file = transcript('a.jsonl', [request('1', 0)]);
      transcript('b.jsonl', [request('2', 1, { sessionId: 'other' })]);
      const instance = scanner();
      await instance.refresh();
      unlinkSync(file);
      await instance.refresh();
      expect(instance.collect().requests.map((entry) => entry.sessionId)).toEqual(['other']);
    });

    it('can be stopped and carries on from where it left off', async () => {
      transcript('a.jsonl', [request('1', 0), request('2', 1)]);
      const instance = scanner();
      const controller = new AbortController();
      controller.abort();
      await instance.refresh(undefined, controller.signal);
      expect(instance.collect().requests).toHaveLength(0);
      await instance.refresh();
      expect(instance.collect().requests).toHaveLength(2);
    });

    it('reports progress up to the end', async () => {
      transcript('a.jsonl', [request('1', 0), request('2', 1)]);
      transcript('b.jsonl', [request('3', 2)]);
      const progress: UsageScanProgress[] = [];
      await scanner({ chunkBytes: 64 }).refresh((value) => progress.push(value));
      const last = progress.at(-1)!;
      expect(last.filesTotal).toBe(2);
      expect(last.filesDone).toBe(2);
      expect(last.bytesDone).toBe(last.bytesTotal);
      expect(last.bytesTotal).toBeGreaterThan(0);
    });
  });

  describe('limits', () => {
    it('leaves out a transcript over the size limit and says so', async () => {
      transcript('small.jsonl', [request('1', 0)]);
      transcript('huge.jsonl', [request('2', 1, { sessionId: 'huge' }), request('3', 2, { sessionId: 'huge' })]);
      // One fake response is about 340 bytes, so two are over the 500-byte limit and one is under it.
      const result = await scan({ maxFileBytes: 500 });
      expect(result.requests.map((entry) => entry.sessionId)).toEqual(['session-a']);
      expect(result.notes).toContainEqual({ code: 'files-skipped-large', count: 1 });
    });

    it('reads the newest transcripts first when there are too many, and says so', async () => {
      transcript('older.jsonl', [request('1', 0, { sessionId: 'older' })], NOW - 3 * DAY);
      transcript('newer.jsonl', [request('2', 1, { sessionId: 'newer' })], NOW - MINUTE);
      const result = await scan({ maxFiles: 1 });
      expect(result.requests.map((entry) => entry.sessionId)).toEqual(['newer']);
      expect(result.notes).toContainEqual({ code: 'files-skipped-limit', count: 1 });
    });

    it('stops at a total size budget, keeping the newest transcripts, and says what it left out', async () => {
      transcript('oldest.jsonl', [request('1', 0, { sessionId: 'oldest' })], NOW - 3 * DAY);
      transcript('middle.jsonl', [request('2', 1, { sessionId: 'middle' })], NOW - 2 * DAY);
      transcript('newest.jsonl', [request('3', 2, { sessionId: 'newest' })], NOW - MINUTE);
      // One fake response is about 340 bytes: a 700-byte budget fits two files, not three.
      const result = await scan({ maxTotalBytes: 700 });
      expect(result.requests.map((entry) => entry.sessionId).sort()).toEqual(['middle', 'newest']);
      expect(result.notes).toContainEqual({ code: 'files-skipped-limit', count: 1 });
    });

    it('skips a single line over the size limit and says so', async () => {
      transcript('a.jsonl', [request('1', 0), `{"type":"user","note":"${'x'.repeat(2_000)}","k":"usage"}`, request('2', 1)]);
      const result = await scan({ maxLineBytes: 1_500 });
      expect(result.requests).toHaveLength(2);
      expect(result.notes).toContainEqual({ code: 'lines-skipped', count: 1 });
    });

    it('counts damaged lines instead of failing', async () => {
      transcript('a.jsonl', [request('1', 0), '{"type":"assistant","message":{"usage":{"input_tokens":', request('2', 1)]);
      const result = await scan();
      expect(result.requests).toHaveLength(2);
      expect(result.notes).toContainEqual({ code: 'lines-skipped', count: 1 });
    });

    it('keeps the newest requests when there are too many, and says how many were dropped', async () => {
      transcript('a.jsonl', [0, 1, 2, 3, 4].map((minute) => request(`m${minute}`, minute)));
      const result = await scan({ maxRequests: 3 });
      expect(result.requests.map((entry) => entry.at)).toEqual([at(2), at(3), at(4)]);
      expect(result.notes).toContainEqual({ code: 'requests-trimmed', count: 2 });
    });

    // A file mode of 000 only blocks a normal user, so the check is skipped when run as root.
    it.skipIf(process.getuid?.() === 0)('says so when a transcript cannot be read, and recovers once it can', async () => {
      const blocked = transcript('blocked.jsonl', [request('1', 0, { sessionId: 'blocked' })]);
      transcript('fine.jsonl', [request('2', 1, { sessionId: 'fine' })]);
      chmodSync(blocked, 0o000);
      try {
        const instance = scanner();
        await instance.refresh();
        const unreadable = instance.collect();
        expect(unreadable.requests.map((entry) => entry.sessionId)).toEqual(['fine']);
        expect(unreadable.notes).toContainEqual({ code: 'files-unreadable', count: 1 });

        chmodSync(blocked, 0o644);
        await instance.refresh();
        const recovered = instance.collect();
        expect(recovered.requests.map((entry) => entry.sessionId).sort()).toEqual(['blocked', 'fine']);
        expect(recovered.notes).toEqual([]);
      } finally {
        chmodSync(blocked, 0o644);
      }
    });

    it('reports nothing when nothing was left out', async () => {
      transcript('a.jsonl', [request('1', 0)]);
      expect((await scan()).notes).toEqual([]);
    });

    it('copes with a config home that has no transcripts at all', async () => {
      const result = await scan();
      expect(result.requests).toEqual([]);
      expect(result.sessionStarts.size).toBe(0);
    });
  });
});
