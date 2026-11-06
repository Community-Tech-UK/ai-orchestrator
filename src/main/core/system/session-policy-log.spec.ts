import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexSessionPolicyRecord, recordSessionPolicy as RecordFn } from './session-policy-log';

// The module reads `electron` with a bare require(), which vi.mock does not
// reach, so the fake is seeded into the shared require cache instead.
const nodeRequire = createRequire(import.meta.url);
const electronKey = nodeRequire.resolve('electron');
const savedElectron = nodeRequire.cache[electronKey];

const NOW = new Date('2026-10-19T12:00:00.000Z');
const record: CodexSessionPolicyRecord = {
  provider: 'codex', threadId: 'thread-1', sessionKind: 'chat', level: 'economy',
  outputLimit: 8000, postTurnCompactPercent: 80, applied: true,
};

let userData: string;
let getPath: ReturnType<typeof vi.fn>;
let record_: typeof RecordFn;
const logDir = () => join(userData, 'session-policy');
const todayFile = () => join(logDir(), '2026-10-19.jsonl');

function setProcess(electron: string | undefined, type: string | undefined): void {
  Object.defineProperty(process.versions, 'electron', { value: electron, configurable: true, enumerable: true, writable: true });
  Object.defineProperty(process, 'type', { value: type, configurable: true, writable: true });
}

async function load(): Promise<void> {
  vi.resetModules();
  record_ = (await import('./session-policy-log')).recordSessionPolicy;
}

describe('recordSessionPolicy', () => {
  beforeEach(async () => {
    userData = mkdtempSync(join(tmpdir(), 'aio-session-policy-'));
    getPath = vi.fn(() => userData);
    nodeRequire.cache[electronKey] = {
      id: electronKey, filename: electronKey, loaded: true, exports: { app: { getPath } },
    } as unknown as NodeJS.Module;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    setProcess('42.0.0', 'browser');
    await load();
  });

  afterEach(() => {
    vi.useRealTimers();
    setProcess(undefined, undefined);
    if (savedElectron) nodeRequire.cache[electronKey] = savedElectron;
    else delete nodeRequire.cache[electronKey];
    rmSync(userData, { recursive: true, force: true });
  });

  it('appends one JSON line per record with a timestamp and the record fields', () => {
    record_(record);
    record_({ ...record, threadId: 'thread-2', applied: false });
    expect(existsSync(logDir())).toBe(true);

    const lines = readFileSync(todayFile(), 'utf8').split('\n');
    expect(lines.pop()).toBe('');
    expect(lines.map(line => JSON.parse(line))).toEqual([
      { at: NOW.toISOString(), ...record },
      { at: NOW.toISOString(), ...record, threadId: 'thread-2', applied: false },
    ]);
  });

  it('writes only in the Electron main process', () => {
    setProcess(undefined, undefined);
    record_(record);
    setProcess('42.0.0', 'renderer');
    record_(record);

    // (The logger also asks the fake for userData, so the folder is the signal.)
    expect(existsSync(logDir())).toBe(false);
  });

  it('prunes day files older than 60 days, once a day, and leaves other files alone', () => {
    mkdirSync(logDir(), { recursive: true });
    for (const name of ['2026-08-10.jsonl', '2026-08-25.jsonl', 'notes.txt']) writeFileSync(join(logDir(), name), 'x');

    record_(record);
    expect(readdirSync(logDir()).sort()).toEqual(['2026-08-25.jsonl', '2026-10-19.jsonl', 'notes.txt']);

    writeFileSync(join(logDir(), '2026-08-11.jsonl'), 'x');
    record_(record);
    expect(existsSync(join(logDir(), '2026-08-11.jsonl'))).toBe(true);
  });

  it('still appends when one old file cannot be deleted, and prunes the others', () => {
    mkdirSync(logDir(), { recursive: true });
    // unlink on a directory throws, standing in for a locked or read-only file.
    mkdirSync(join(logDir(), '2026-07-01.jsonl'));
    writeFileSync(join(logDir(), '2026-07-02.jsonl'), 'x');
    writeFileSync(join(logDir(), '2026-07-03.jsonl'), 'x');

    record_(record);

    expect(JSON.parse(readFileSync(todayFile(), 'utf8').trim())).toMatchObject({ threadId: 'thread-1' });
    expect(existsSync(join(logDir(), '2026-07-02.jsonl'))).toBe(false);
    expect(existsSync(join(logDir(), '2026-07-03.jsonl'))).toBe(false);
  });

  it('writes a helper-count follow-up record that the trial report reads as helper counts, not as a policy entry', async () => {
    record_(record);
    record_({ provider: 'codex', recordType: 'helper-count', threadId: 'thread-1', instanceId: 'instance-1', helperThreads: 1 });
    record_({ provider: 'codex', recordType: 'helper-count', threadId: 'thread-1', instanceId: 'instance-1', helperThreads: 2 });

    const lines = readFileSync(todayFile(), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    expect(lines[1]).toEqual({
      at: NOW.toISOString(), provider: 'codex', recordType: 'helper-count', threadId: 'thread-1',
      instanceId: 'instance-1', helperThreads: 1,
    });

    // The real writer's output through the real reader (a plain-Node script).
    const report = await import('../../../../scripts/codex-helper-trial-report.mjs');
    const { entries: helperRecords, unparsableLines } = report.parsePolicyLog(logDir(), 0, Number.MAX_SAFE_INTEGER, 'helper-count');
    expect(unparsableLines).toBe(0);
    expect(helperRecords).toHaveLength(2);
    expect([...report.helperCountsFromLog(helperRecords)]).toEqual([['thread-1', 2]]);
    // Policy readers never see the follow-up records, and old-format handling is untouched.
    const { entries: policy } = report.parsePolicyLog(logDir(), 0, Number.MAX_SAFE_INTEGER);
    expect(policy).toHaveLength(1);
    expect(policy[0]).toMatchObject({ threadId: 'thread-1', legacyFormat: false });
  });

  it('never throws when the log cannot be written', () => {
    getPath.mockImplementation(() => { throw new Error('no userData'); });
    expect(() => record_(record)).not.toThrow();
  });
});
