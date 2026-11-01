import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { PROVIDER_MODEL_LIST } from '../../../../shared/types/provider.types';
import {
  classifyAntigravityModelFamily,
  classifyAntigravityModelTier,
  discoverAntigravityModels,
  parseAntigravityModelList,
  toAntigravityModelDisplayInfos,
} from '../antigravity-cli-adapter.models';

// Verbatim `agy models` output from agy 1.4.11 (signed in), 2026-10-30.
const SAMPLE_OUTPUT = [
  'Fetching available models...',
  'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
  'gemini-4-argon-high\tGemini 4 Argon (High)',
  'gemini-4-argon-low\tGemini 4 Argon (Low)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
  'claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)',
  'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
  'claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)',
  'claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)',
  'claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
  '',
].join('\n');

describe('parseAntigravityModelList', () => {
  it('keeps the label column of each row, in agy order, and skips the progress line', () => {
    const labels = parseAntigravityModelList(SAMPLE_OUTPUT);

    expect(labels).toHaveLength(13);
    expect(labels[0]).toBe('Gemini 4 Argon (Medium)');
    expect(labels).toContain('GPT-OSS 120B (Medium)');
    expect(labels).not.toContain('Fetching available models...');
  });

  it('ignores colour codes, duplicate rows and prose', () => {
    const output = [
      '\u001B[32mgemini-3.8-flash-low\tGemini 3.8 Flash (Low)\u001B[0m',
      'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
      'error: invalid model selection',
      '  Gemini 3.8 Flash (High)',
    ].join('\n');

    expect(parseAntigravityModelList(output)).toEqual(['Gemini 3.8 Flash (Low)']);
  });

  it('returns nothing for output with no model rows', () => {
    expect(parseAntigravityModelList('You are not signed in.\n')).toEqual([]);
  });
});

describe('toAntigravityModelDisplayInfos', () => {
  it('builds exactly the static offline list from the same agy output', () => {
    // The static list is the fallback copy of this output; if the classifier
    // and the hand-kept rows disagree, the picker changes shape the moment
    // discovery lands.
    expect(toAntigravityModelDisplayInfos(parseAntigravityModelList(SAMPLE_OUTPUT)))
      .toEqual(PROVIDER_MODEL_LIST['antigravity']);
  });

  it('classifies future releases without a code edit', () => {
    expect(classifyAntigravityModelTier('Gemini 3.9 Flash (Low)')).toBe('fast');
    expect(classifyAntigravityModelTier('Gemini 3.9 Flash (High)')).toBe('balanced');
    expect(classifyAntigravityModelTier('Gemini 5 Boron (Medium)')).toBe('powerful');
    expect(classifyAntigravityModelTier('Claude Opus 6 (Low)')).toBe('powerful');
    expect(classifyAntigravityModelTier('Claude Sonnet 6 (High)')).toBe('balanced');
    expect(classifyAntigravityModelFamily('Gemini 5 Boron (Medium)')).toBe('Gemini Pro');
    expect(classifyAntigravityModelFamily('Gemini 3.9 Flash (Medium)')).toBe('Gemini Flash');
    expect(classifyAntigravityModelFamily('Mystery Model (Medium)')).toBeUndefined();
  });
});

function makeFakeProc(): ChildProcess & {
  emitStdout(chunk: string): void;
  emitStderr(chunk: string): void;
  emitClose(code: number): void;
} {
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  proc['stdout'] = stdout;
  proc['stderr'] = stderr;
  proc['kill'] = () => true;
  proc['emitStdout'] = (chunk: string) => stdout.emit('data', Buffer.from(chunk));
  proc['emitStderr'] = (chunk: string) => stderr.emit('data', Buffer.from(chunk));
  proc['emitClose'] = (code: number) => proc.emit('close', code);
  return proc as unknown as ChildProcess & {
    emitStdout(chunk: string): void;
    emitStderr(chunk: string): void;
    emitClose(code: number): void;
  };
}

describe('discoverAntigravityModels', () => {
  it('parses rows from either stream into picker models', async () => {
    const proc = makeFakeProc();
    const promise = discoverAntigravityModels(() => proc);
    proc.emitStderr('Fetching available models...\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n');
    proc.emitStdout(SAMPLE_OUTPUT);
    proc.emitClose(0);

    // A row repeated across streams collapses, and stdout's order wins.
    expect(await promise).toEqual(PROVIDER_MODEL_LIST['antigravity']);
  });

  it('rejects a failed run even when it printed model names', async () => {
    const proc = makeFakeProc();
    const promise = discoverAntigravityModels(() => proc);
    proc.emitStdout('gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n');
    proc.emitClose(1);

    await expect(promise).rejects.toThrow(/exit 1/);
  });

  it('rejects a successful run with no model rows', async () => {
    const proc = makeFakeProc();
    const promise = discoverAntigravityModels(() => proc);
    proc.emitStdout('You are not signed in.\n');
    proc.emitClose(0);

    await expect(promise).rejects.toThrow(/Failed to read Antigravity model list/);
  });
});
