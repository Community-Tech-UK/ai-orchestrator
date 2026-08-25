import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import {
  classifyGrokModelTier,
  discoverGrokModels,
  formatGrokModelName,
  parseGrokModelList,
  toGrokModelDisplayInfos,
  _resetGrokModelCacheForTesting,
} from '../grok-cli-adapter.models';

// Verbatim `grok models` output from Grok Build CLI 1.0.5 (signed in), plus a
// second bulleted row so multi-model accounts are covered. The auth banner and
// the unbulleted `Default model:` line must both be ignored.
const SAMPLE_OUTPUT = `You are logged in with grok.com.

Default model: grok-4.6

Available models:
  * grok-4.6 (default)
  * grok-4.6-mini
`;

describe('parseGrokModelList', () => {
  it('extracts bulleted rows and ignores the banner and the Default model line', () => {
    const entries = parseGrokModelList(SAMPLE_OUTPUT);

    expect(entries).toEqual([
      { id: 'grok-4.6', isDefault: true },
      { id: 'grok-4.6-mini', isDefault: false },
    ]);
  });

  it('returns nothing for output with no model rows', () => {
    expect(parseGrokModelList('You are not authenticated.\n')).toEqual([]);
    expect(parseGrokModelList('')).toEqual([]);
  });

  it('tolerates trailing annotations and descriptions a future CLI might add', () => {
    // If a description suffix made every row unparseable, discovery would fall
    // silently back to the static list — the exact staleness this prevents.
    expect(parseGrokModelList([
      '  * grok-5 (default) (preview)',
      '  * grok-5-mini — Cheaper and faster',
      '  * grok-4.6 - Grok 4.6',
    ].join('\n'))).toEqual([
      { id: 'grok-5', isDefault: true },
      { id: 'grok-5-mini', isDefault: false },
      { id: 'grok-4.6', isDefault: false },
    ]);
  });

  it('rejects a bulleted prose line rather than inventing a model id', () => {
    expect(parseGrokModelList([
      '  * Run grok login to see more models',
      '  * Note: billing is per token',
    ].join('\n'))).toEqual([]);
  });

  it('de-duplicates repeated ids without losing the default marker', () => {
    expect(parseGrokModelList('* grok-4.6\n* grok-4.6 (default)\n')).toEqual([
      { id: 'grok-4.6', isDefault: true },
    ]);
  });
});

describe('Grok model display metadata', () => {
  it('pins the CLI default and tags the family', () => {
    const models = toGrokModelDisplayInfos(parseGrokModelList(SAMPLE_OUTPUT));

    expect(models[0]).toEqual({
      id: 'grok-4.6',
      name: 'Grok 4.6',
      tier: 'powerful',
      family: 'Grok',
      pinned: true,
    });
    expect(models[1].pinned).toBeUndefined();
  });

  it('pins the first row when the CLI marks no default', () => {
    const models = toGrokModelDisplayInfos([
      { id: 'grok-9', isDefault: false },
      { id: 'grok-8', isDefault: false },
    ]);

    expect(models[0].pinned).toBe(true);
    expect(models[1].pinned).toBeUndefined();
  });

  it('classifies tiers from the id', () => {
    expect(classifyGrokModelTier('grok-4.6')).toBe('powerful');
    expect(classifyGrokModelTier('grok-4.6-mini')).toBe('fast');
    expect(classifyGrokModelTier('grok-4.20-0309-non-reasoning')).toBe('fast');
    expect(classifyGrokModelTier('grok-build-0.1')).toBe('balanced');
  });

  it('formats a readable name and falls back to the raw id', () => {
    expect(formatGrokModelName('grok-4.6')).toBe('Grok 4.6');
    expect(formatGrokModelName('grok-code-fast-1')).toBe('Grok code fast 1');
    expect(formatGrokModelName('something-else')).toBe('something-else');
  });
});

function makeFakeProc(): ChildProcess & {
  emitStdout(chunk: string): void;
  emitStderr(chunk: string): void;
  emitClose(code: number): void;
  emitError(err: Error): void;
} {
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  proc['stdout'] = stdout;
  proc['stderr'] = stderr;
  proc['kill'] = () => true;
  (proc as unknown as { emitStdout(c: string): void }).emitStdout = (chunk: string) =>
    stdout.emit('data', Buffer.from(chunk));
  (proc as unknown as { emitStderr(c: string): void }).emitStderr = (chunk: string) =>
    stderr.emit('data', Buffer.from(chunk));
  (proc as unknown as { emitClose(c: number): void }).emitClose = (code: number) =>
    proc.emit('close', code);
  (proc as unknown as { emitError(e: Error): void }).emitError = (err: Error) =>
    proc.emit('error', err);
  return proc as unknown as ChildProcess & {
    emitStdout(chunk: string): void;
    emitStderr(chunk: string): void;
    emitClose(code: number): void;
    emitError(err: Error): void;
  };
}

describe('discoverGrokModels', () => {
  beforeEach(() => {
    _resetGrokModelCacheForTesting();
  });

  it('parses the CLI output into ModelDisplayInfo and caches it', async () => {
    let spawnCount = 0;
    const proc = makeFakeProc();
    const spawn = () => {
      spawnCount += 1;
      return proc;
    };

    const promise = discoverGrokModels(spawn);
    proc.emitStdout(SAMPLE_OUTPUT);
    proc.emitClose(0);

    const models = await promise;
    expect(models.map((m) => m.id)).toEqual(['grok-4.6', 'grok-4.6-mini']);
    expect(spawnCount).toBe(1);

    // Second call inside the TTL is served from cache without re-spawning.
    expect(await discoverGrokModels(spawn)).toBe(models);
    expect(spawnCount).toBe(1);
  });

  it('parses a list the CLI wrote to stderr', async () => {
    const proc = makeFakeProc();
    const promise = discoverGrokModels(() => proc);
    proc.emitStderr(SAMPLE_OUTPUT);
    proc.emitClose(0);

    expect((await promise).map((m) => m.id)).toEqual(['grok-4.6', 'grok-4.6-mini']);
  });

  it('rejects (rather than caching an empty list) when nothing parses', async () => {
    const proc = makeFakeProc();
    const promise = discoverGrokModels(() => proc);
    proc.emitStderr('You are not authenticated.\n');
    proc.emitClose(1);

    await expect(promise).rejects.toThrow(/Failed to parse Grok model list/);
  });

  it('rejects when the CLI cannot be spawned', async () => {
    const proc = makeFakeProc();
    const promise = discoverGrokModels(() => proc);
    proc.emitError(new Error('spawn grok ENOENT'));

    await expect(promise).rejects.toThrow(/ENOENT/);
  });
});
