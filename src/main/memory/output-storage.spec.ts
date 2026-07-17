/**
 * OutputStorageManager spec — the persisted user-prompt tally.
 *
 * Tests (against a real temp dir so gzip/index round-trips are exercised):
 *   1. storeMessages appends user prompts (excerpted, in order) to the index;
 *      non-user messages are ignored.
 *   2. getUserPrompts backfills a legacy index (no userPrompts field) by
 *      scanning chunks once and persists the result.
 *   3. storeMessages does NOT create the tally on a legacy index, so the
 *      backfill still sees the full history.
 *   4. Chunk eviction under the storage limit prunes tallied prompts that
 *      lived in the evicted chunk.
 *   5. getUserPrompts returns [] for unknown instances.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { OutputMessage } from '../../shared/types/instance.types';

let tempUserData = '';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tempUserData) },
}));

vi.mock('../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { OutputStorageManager } from './output-storage';

let nextId = 0;

function msg(type: OutputMessage['type'], content: string): OutputMessage {
  nextId++;
  return { id: `msg-${nextId}`, timestamp: nextId * 1000, type, content };
}

function indexPath(instanceId: string): string {
  return path.join(tempUserData, 'output-storage', instanceId, 'index.json');
}

function readIndex(instanceId: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(indexPath(instanceId), 'utf-8'));
}

describe('OutputStorageManager user-prompt tally', () => {
  let storage: OutputStorageManager;

  beforeEach(() => {
    tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'output-storage-spec-'));
    storage = new OutputStorageManager();
  });

  afterEach(() => {
    fs.rmSync(tempUserData, { recursive: true, force: true });
  });

  it('appends user prompts to the tally as messages are stored', async () => {
    await storage.storeMessages('inst-1', [
      msg('user', 'first question'),
      msg('assistant', 'an answer'),
      msg('tool_use', ''),
    ]);
    await storage.storeMessages('inst-1', [msg('user', '  second\n question  ')]);

    const prompts = await storage.getUserPrompts('inst-1');
    expect(prompts.map((p) => p.excerpt)).toEqual(['first question', 'second question']);
    expect(prompts.every((p) => p.id && p.timestamp > 0)).toBe(true);
  });

  it('bounds prompt excerpts in the tally', async () => {
    await storage.storeMessages('inst-1', [msg('user', 'word '.repeat(100))]);
    const [prompt] = await storage.getUserPrompts('inst-1');
    expect(prompt.excerpt.length).toBeLessThanOrEqual(200);
    expect(prompt.excerpt.endsWith('…')).toBe(true);
  });

  it('backfills a legacy index by scanning chunks and persists the result', async () => {
    await storage.storeMessages('inst-1', [msg('user', 'old prompt'), msg('assistant', 'old reply')]);

    // Simulate an index written before the tally existed.
    const legacy = readIndex('inst-1');
    delete legacy['userPrompts'];
    fs.writeFileSync(indexPath('inst-1'), JSON.stringify(legacy));
    const reloaded = new OutputStorageManager();

    const prompts = await reloaded.getUserPrompts('inst-1');
    expect(prompts.map((p) => p.excerpt)).toEqual(['old prompt']);
    expect(readIndex('inst-1')['userPrompts']).toEqual(prompts);
  });

  it('does not start a partial tally on a legacy index — backfill sees full history', async () => {
    await storage.storeMessages('inst-1', [msg('user', 'pre-tally prompt')]);
    const legacy = readIndex('inst-1');
    delete legacy['userPrompts'];
    fs.writeFileSync(indexPath('inst-1'), JSON.stringify(legacy));

    const reloaded = new OutputStorageManager();
    await reloaded.storeMessages('inst-1', [msg('user', 'post-tally prompt')]);

    const prompts = await reloaded.getUserPrompts('inst-1');
    expect(prompts.map((p) => p.excerpt)).toEqual(['pre-tally prompt', 'post-tally prompt']);
  });

  it('prunes tallied prompts when their chunk is evicted by the storage limit', async () => {
    await storage.storeMessages('inst-1', [msg('user', 'doomed prompt'), msg('assistant', 'x')]);
    await storage.storeMessages('inst-1', [msg('user', 'surviving prompt')]);

    // Cap at exactly the current total: the next (tiny, prompt-free) store
    // pushes it over, and evicting chunk 0 (two messages — always larger than
    // the one-message filler chunk) brings it back under in one step.
    const index = readIndex('inst-1') as { totalSizeBytes: number };
    storage.configure({ maxDiskStorageMB: index.totalSizeBytes / (1024 * 1024) });
    await storage.storeMessages('inst-1', [msg('assistant', 'filler')]);

    const prompts = await storage.getUserPrompts('inst-1');
    expect(prompts.map((p) => p.excerpt)).toEqual(['surviving prompt']);
  });

  it('returns an empty tally for unknown instances', async () => {
    expect(await storage.getUserPrompts('nope')).toEqual([]);
  });
});
