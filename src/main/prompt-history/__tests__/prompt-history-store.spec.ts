import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptHistoryRecord, PromptHistoryStoreV1 } from '../../../shared/types/prompt-history.types';
import { PromptHistoryFileStore } from '../prompt-history-store';

function record(instanceId: string): PromptHistoryRecord {
  return { instanceId, updatedAt: 1, entries: [{ id: `${instanceId}-1`, text: 'hello', createdAt: 1 }] };
}

describe('PromptHistoryFileStore', () => {
  let root: string;
  let filePath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-history-store-'));
    filePath = path.join(root, 'prompt-history.json');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function readFile(): PromptHistoryStoreV1 {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as PromptHistoryStoreV1;
  }

  it('starts empty when there is no file', () => {
    const store = new PromptHistoryFileStore(filePath);

    expect(store.get('byInstance')).toEqual({});
    expect(store.get('byProject')).toEqual({});
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('reads the file once and serves later reads from memory', async () => {
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, byInstance: { a: record('a') }, byProject: {} }, null, '\t'));
    const store = new PromptHistoryFileStore(filePath, 60_000);
    // A re-read would pick this up; the in-memory copy must not.
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, byInstance: {}, byProject: {} }));

    expect(store.get('byInstance')['a']?.entries[0]?.text).toBe('hello');
    store.setMany({ byProject: {} });
    expect(store.get('byInstance')['a']).toBeDefined();
    await store.flush();
    expect(Object.keys(readFile().byInstance)).toEqual(['a']);
  });

  it('coalesces several changes into one background write', async () => {
    vi.useFakeTimers();
    const rename = vi.spyOn(fs.promises, 'rename');
    const store = new PromptHistoryFileStore(filePath, 1_000);

    store.setMany({ byInstance: { a: record('a') } });
    store.setMany({ byInstance: { a: record('a'), b: record('b') } });
    expect(fs.existsSync(filePath)).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    vi.useRealTimers();
    await store.flush();

    expect(rename).toHaveBeenCalledOnce();
    expect(Object.keys(readFile().byInstance)).toEqual(['a', 'b']);
  });

  it('flush writes a pending change straight away', async () => {
    const store = new PromptHistoryFileStore(filePath, 60_000);
    store.setMany({ byInstance: { a: record('a') } });

    await store.flush();

    expect(readFile()).toMatchObject({ schemaVersion: 1, byInstance: { a: record('a') }, byProject: {} });
    expect(fs.readdirSync(root)).toEqual(['prompt-history.json']);
  });

  it('writes a change made during a save in a second save', async () => {
    const store = new PromptHistoryFileStore(filePath, 60_000);
    store.setMany({ byInstance: { a: record('a') } });
    const first = store.flush();
    store.setMany({ byInstance: { a: record('a'), b: record('b') } });

    await first;
    await store.flush();

    expect(Object.keys(readFile().byInstance)).toEqual(['a', 'b']);
  });

  it('moves an unreadable file aside and starts empty', () => {
    fs.writeFileSync(filePath, '{ not json');

    const store = new PromptHistoryFileStore(filePath);

    expect(store.get('byInstance')).toEqual({});
    expect(fs.existsSync(filePath)).toBe(false);
    const aside = fs.readdirSync(root).filter((name) => /^prompt-history\.corrupt-\d+\.json$/.test(name));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, aside[0]!), 'utf8')).toBe('{ not json');
  });

  it('keeps one backup copy and never overwrites it', async () => {
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, byInstance: { first: record('first') }, byProject: {} }));
    const store = new PromptHistoryFileStore(filePath, 60_000);
    const backupPath = path.join(root, 'prompt-history.before-cleanup.json');

    await store.keepBackupCopy();
    store.setMany({ byInstance: {} });
    await store.flush();
    await store.keepBackupCopy();

    expect(Object.keys((JSON.parse(fs.readFileSync(backupPath, 'utf8')) as PromptHistoryStoreV1).byInstance)).toEqual(['first']);
  });

  it('keeps a failed save pending so the next flush retries it', async () => {
    const store = new PromptHistoryFileStore(filePath, 60_000);
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('disk full'));
    store.setMany({ byInstance: { a: record('a') } });

    await store.flush();
    expect(fs.existsSync(filePath)).toBe(false);
    await store.flush();

    expect(Object.keys(readFile().byInstance)).toEqual(['a']);
  });
});
