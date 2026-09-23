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

import type { UserPromptRef } from '../../shared/types/prompt-index.types';
import { OutputStorageManager, mergePromptIndex } from './output-storage';

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

describe('OutputStorageManager.loadMessagesBefore', () => {
  let storage: OutputStorageManager;

  beforeEach(() => {
    tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'output-storage-page-spec-'));
    storage = new OutputStorageManager();
  });

  afterEach(() => {
    fs.rmSync(tempUserData, { recursive: true, force: true });
  });

  /** One chunk per message — the shape buffer-overflow trimming writes. */
  async function storeOnePerChunk(instanceId: string, contents: string[]): Promise<void> {
    for (const content of contents) {
      await storage.storeMessages(instanceId, [msg('assistant', content)]);
    }
  }

  it('pages by message count, not chunk count, across one-message chunks', async () => {
    await storeOnePerChunk('inst-1', Array.from({ length: 12 }, (_, i) => `m${i}`));

    const latest = await storage.loadMessagesBefore('inst-1', { limit: 5 });
    expect(latest.messages.map((m) => m.content)).toEqual(['m7', 'm8', 'm9', 'm10', 'm11']);
    expect(latest.startOffset).toBe(7);
    expect(latest.totalStored).toBe(12);

    const older = await storage.loadMessagesBefore('inst-1', { beforeOffset: latest.startOffset, limit: 5 });
    expect(older.messages.map((m) => m.content)).toEqual(['m2', 'm3', 'm4', 'm5', 'm6']);

    const oldest = await storage.loadMessagesBefore('inst-1', { beforeOffset: older.startOffset, limit: 5 });
    expect(oldest.messages.map((m) => m.content)).toEqual(['m0', 'm1']);
    expect(oldest.startOffset).toBe(0);
  });

  it('pages through a chunk larger than the page without skipping any of it', async () => {
    // Restored history lands as one big chunk, followed by small overflow chunks.
    await storage.storeMessages('inst-1', Array.from({ length: 7 }, (_, i) => msg('assistant', `big${i}`)));
    await storeOnePerChunk('inst-1', ['tail0', 'tail1']);

    const seen: string[] = [];
    let beforeOffset: number | undefined;
    for (;;) {
      const page = await storage.loadMessagesBefore('inst-1', { beforeOffset, limit: 3 });
      seen.unshift(...page.messages.map((m) => m.content));
      if (page.startOffset === 0) break;
      beforeOffset = page.startOffset;
    }

    expect(seen).toEqual(['big0', 'big1', 'big2', 'big3', 'big4', 'big5', 'big6', 'tail0', 'tail1']);
  });

  it('returns an empty page for unknown instances', async () => {
    expect(await storage.loadMessagesBefore('nope', { limit: 10 })).toEqual({
      messages: [],
      startOffset: 0,
      totalStored: 0,
    });
  });

  it('keeps every stored message readable after chunk eviction and further writes', async () => {
    await storeOnePerChunk('inst-1', ['a0', 'a1', 'a2']);
    // Evict exactly chunk 0 on the next write, then keep writing.
    const index = readIndex('inst-1') as { totalSizeBytes: number };
    storage.configure({ maxDiskStorageMB: index.totalSizeBytes / (1024 * 1024) });
    await storeOnePerChunk('inst-1', ['a3']);
    storage.configure({ maxDiskStorageMB: 0 });
    await storeOnePerChunk('inst-1', ['a4', 'a5']);

    const page = await storage.loadMessagesBefore('inst-1', { limit: 50 });
    expect(page.messages.map((m) => m.content)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    expect((await storage.loadMessages('inst-1')).map((m) => m.content)).toEqual([
      'a1', 'a2', 'a3', 'a4', 'a5',
    ]);
  });
});

describe('mergePromptIndex', () => {
  const prompt = (id: string, content: string, timestamp: number) =>
    ({ id, type: 'user', content, timestamp }) as OutputMessage;
  const ref = (id: string, excerpt: string, timestamp: number) =>
    ({ id, excerpt, timestamp }) as UserPromptRef;

  it('lists a prompt compaction evicted without ever writing it to disk', () => {
    // Compaction persists nothing, so this prompt is in neither disk storage
    // nor the live buffer — only the retained set.
    const prompts = mergePromptIndex(
      [],
      [prompt('u9', 'carry on', 20)],
      [prompt('p0', 'Migrate the billing service.', 1)],
    );

    expect(prompts.map((p) => p.excerpt)).toEqual([
      'Migrate the billing service.',
      'carry on',
    ]);
  });

  it('does not double-list a prompt disk storage already returned', () => {
    const prompts = mergePromptIndex(
      [ref('p0', 'Migrate the billing service.', 1)],
      [],
      [prompt('restored-prompt-msg-0', 'Migrate the billing service.', 1)],
    );

    expect(prompts).toHaveLength(1);
  });

  it('does not double-list a prompt the live buffer still holds', () => {
    const opening = prompt('p0', 'Migrate the billing service.', 1);

    const prompts = mergePromptIndex([], [opening], [{ ...opening, id: 'restored-prompt-msg-0' }]);

    expect(prompts).toHaveLength(1);
  });

  it('returns the index in chronological order', () => {
    const prompts = mergePromptIndex(
      [ref('mid', 'middle ask', 50)],
      [prompt('late', 'late ask', 90)],
      [prompt('early', 'early ask', 1)],
    );

    expect(prompts.map((p) => p.excerpt)).toEqual(['early ask', 'middle ask', 'late ask']);
  });
});
