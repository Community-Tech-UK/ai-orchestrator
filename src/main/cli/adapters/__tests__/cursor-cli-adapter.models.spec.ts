import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import {
  CURSOR_AUTO_MODEL_ID,
  classifyCursorModelFamily,
  classifyCursorModelTier,
  discoverCursorModels,
  ensureCursorAutoModel,
  parseCursorModelList,
  toCursorModelDisplayInfo,
  _resetCursorModelCacheForTesting,
} from '../cursor-cli-adapter.models';

// Representative slice of real `cursor-agent --list-models` output, including the
// `Available models` header, the `(current)` / `(default)` status suffixes, blank
// lines, and the trailing `Tip:` hint that must all be ignored.
const SAMPLE_OUTPUT = `Available models

auto - Auto
gpt-5.3-codex-low - Codex 5.3 Low
gpt-5.3-codex - Codex 5.3 (current)
composer-2.5 - Composer 2.5
composer-2.5-fast - Composer 2.5 Fast (default)
claude-opus-4-8-thinking-high - Opus 4.8 1M Thinking
gpt-5.5-high - GPT-5.5 1M High
gemini-3.1-pro - Gemini 3.1 Pro
grok-4.3 - Grok 4.3 1M
kimi-k2.5 - Kimi K2.5

Tip: use --model <id> (or /model <id> in interactive mode) to switch.
`;

describe('parseCursorModelList', () => {
  it('extracts id/name pairs and skips the header, blank lines, and Tip footer', () => {
    const entries = parseCursorModelList(SAMPLE_OUTPUT);
    const ids = entries.map((e) => e.id);

    expect(ids).toContain('auto');
    expect(ids).toContain('gpt-5.3-codex');
    expect(ids).toContain('composer-2.5-fast');
    expect(ids).toContain('kimi-k2.5');

    // Header / footer / blanks must not become entries.
    expect(ids).not.toContain('Available');
    expect(ids).not.toContain('Tip:');
    expect(ids.some((id) => id.toLowerCase().includes('tip'))).toBe(false);
  });

  it('strips the (current) / (default) status suffix from display names', () => {
    const entries = parseCursorModelList(SAMPLE_OUTPUT);
    const codex = entries.find((e) => e.id === 'gpt-5.3-codex');
    const fast = entries.find((e) => e.id === 'composer-2.5-fast');

    expect(codex?.name).toBe('Codex 5.3');
    expect(fast?.name).toBe('Composer 2.5 Fast');
  });

  it('de-duplicates repeated ids', () => {
    const entries = parseCursorModelList('auto - Auto\nauto - Auto Again\n');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ id: 'auto', name: 'Auto' });
  });

  it('returns an empty array for non-model output', () => {
    expect(parseCursorModelList('')).toEqual([]);
    expect(parseCursorModelList('command not found')).toEqual([]);
  });
});

describe('classifyCursorModelTier', () => {
  it('classifies fast variants', () => {
    expect(classifyCursorModelTier('gemini-3-flash')).toBe('fast');
    expect(classifyCursorModelTier('gpt-5.4-mini-low')).toBe('fast');
  });
  it('classifies powerful variants', () => {
    expect(classifyCursorModelTier('claude-opus-4-8-thinking-high')).toBe('powerful');
    expect(classifyCursorModelTier('gemini-3.1-pro')).toBe('powerful');
    expect(classifyCursorModelTier('grok-4.3')).toBe('powerful');
  });
  it('falls back to balanced', () => {
    expect(classifyCursorModelTier('gpt-5.2')).toBe('balanced');
    expect(classifyCursorModelTier('composer-2.5')).toBe('balanced');
  });
});

describe('classifyCursorModelFamily', () => {
  it('routes codex ids to Codex before the generic GPT bucket', () => {
    expect(classifyCursorModelFamily('gpt-5.3-codex')).toBe('Codex');
    expect(classifyCursorModelFamily('gpt-5.2')).toBe('GPT');
  });
  it('maps the well-known families', () => {
    expect(classifyCursorModelFamily('auto')).toBe('Auto');
    expect(classifyCursorModelFamily('composer-2.5')).toBe('Composer');
    expect(classifyCursorModelFamily('claude-4.5-sonnet')).toBe('Claude');
    expect(classifyCursorModelFamily('gemini-3-flash')).toBe('Gemini');
    expect(classifyCursorModelFamily('grok-4.3')).toBe('Grok');
    expect(classifyCursorModelFamily('kimi-k2.5')).toBe('Kimi');
  });
});

describe('toCursorModelDisplayInfo / ensureCursorAutoModel', () => {
  it('marks only the auto entry as pinned and assigns a family + tier', () => {
    const auto = toCursorModelDisplayInfo({ id: 'auto', name: 'Auto' });
    expect(auto).toEqual({
      id: 'auto',
      name: 'Auto',
      tier: 'balanced',
      family: 'Auto',
      pinned: true,
    });

    const codex = toCursorModelDisplayInfo({ id: 'gpt-5.3-codex', name: 'Codex 5.3' });
    expect(codex.pinned).toBeUndefined();
    expect(codex.family).toBe('Codex');
  });

  it('prepends a pinned auto entry when the list lacks one', () => {
    const models = ensureCursorAutoModel([
      toCursorModelDisplayInfo({ id: 'composer-2.5', name: 'Composer 2.5' }),
    ]);
    expect(models[0].id).toBe(CURSOR_AUTO_MODEL_ID);
    expect(models[0].pinned).toBe(true);
  });

  it('leaves an existing auto entry in place', () => {
    const source = [toCursorModelDisplayInfo({ id: 'auto', name: 'Auto' })];
    expect(ensureCursorAutoModel(source)).toBe(source);
  });
});

/** Minimal ChildProcess stand-in driven by emitting stdout data + a close code. */
function makeFakeProc(): ChildProcess & {
  emitStdout(chunk: string): void;
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
  (proc as unknown as { emitClose(c: number): void }).emitClose = (code: number) =>
    proc.emit('close', code);
  (proc as unknown as { emitError(e: Error): void }).emitError = (err: Error) =>
    proc.emit('error', err);
  return proc as unknown as ChildProcess & {
    emitStdout(chunk: string): void;
    emitClose(code: number): void;
    emitError(err: Error): void;
  };
}

describe('discoverCursorModels', () => {
  beforeEach(() => {
    _resetCursorModelCacheForTesting();
  });

  it('parses the CLI output into pinned-auto-first ModelDisplayInfo and caches it', async () => {
    const proc = makeFakeProc();
    let spawnCount = 0;
    const spawn = () => {
      spawnCount += 1;
      return proc;
    };

    const promise = discoverCursorModels(spawn);
    proc.emitStdout('Available models\n\nauto - Auto\ngpt-5.3-codex - Codex 5.3 (current)\n');
    proc.emitClose(0);

    const models = await promise;
    expect(models[0]).toMatchObject({ id: 'auto', pinned: true, family: 'Auto' });
    expect(models.map((m) => m.id)).toContain('gpt-5.3-codex');

    // Second call within TTL returns the cache without re-spawning.
    const again = await discoverCursorModels(spawn);
    expect(again).toBe(models);
    expect(spawnCount).toBe(1);
  });

  it('rejects when the CLI emits no parseable models', async () => {
    const proc = makeFakeProc();
    const promise = discoverCursorModels(() => proc);
    proc.emitStdout('command not found\n');
    proc.emitClose(127);
    await expect(promise).rejects.toThrow(/Failed to parse Cursor model list/);
  });

  it('rejects on spawn error', async () => {
    const proc = makeFakeProc();
    const promise = discoverCursorModels(() => proc);
    proc.emitError(new Error('ENOENT'));
    await expect(promise).rejects.toThrow('ENOENT');
  });
});
