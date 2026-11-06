import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { priceFor, rateForModel, transcriptProjectsDirs } from '../lib/claude-transcripts.mjs';
import { realSessionUsd } from '../context-ceiling-replay.mjs';
import { compareTranscriptCosts } from '../claude-transcript-cost-comparison.mjs';
import { requestUsd } from '../claude-cost-audit-report.mjs';

const tempDirs: string[] = [];
const configEnv = process.env['CLAUDE_CONFIG_DIR'];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  if (configEnv === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
  else process.env['CLAUDE_CONFIG_DIR'] = configEnv;
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const millionInput = (model: string) => ({
  at: 0, input: 1_000_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, model, context: 0,
});

describe('the shared Claude price table', () => {
  it('prices current models at their MODEL_PRICING rates, not family rates', () => {
    expect(priceFor('claude-opus-4-6-20260401')).toEqual({ inputPerMTok: 5, outputPerMTok: 25, known: true });
    expect(priceFor('claude-opus-5')).toEqual({ inputPerMTok: 5, outputPerMTok: 25, known: true });
    expect(priceFor('claude-opus-4-8')).toEqual({ inputPerMTok: 5, outputPerMTok: 25, known: true });
    expect(priceFor('claude-opus-4-7')).toEqual({ inputPerMTok: 5, outputPerMTok: 25, known: true });
    expect(priceFor('claude-opus-5-5')).toEqual({ inputPerMTok: 4, outputPerMTok: 20, known: true });
    expect(priceFor('claude-sonnet-5')).toEqual({ inputPerMTok: 2, outputPerMTok: 10, known: true });
    expect(priceFor('claude-sonnet-5-5')).toEqual({ inputPerMTok: 2, outputPerMTok: 10, known: true });
    expect(priceFor('claude-sonnet-4-5-20250929')).toEqual({ inputPerMTok: 3, outputPerMTok: 15, known: true });
    expect(priceFor('claude-haiku-5-5')).toEqual({ inputPerMTok: 0.1, outputPerMTok: 0.5, known: true });
  });

  it('keeps the legacy per-id rates and the bare family names of Phase 0\'s table', () => {
    expect(priceFor('claude-opus-4-20250514')).toEqual({ inputPerMTok: 15, outputPerMTok: 75, known: true });
    expect(priceFor('claude-3-opus')).toEqual({ inputPerMTok: 15, outputPerMTok: 75, known: true });
    expect(priceFor('claude-3-5-haiku')).toEqual({ inputPerMTok: 0.8, outputPerMTok: 4, known: true });
    expect(priceFor('claude-3-haiku')).toEqual({ inputPerMTok: 0.25, outputPerMTok: 1.25, known: true });
    expect(priceFor('claude-fable-5-1')).toEqual({ inputPerMTok: 10, outputPerMTok: 50, known: true });
    expect(priceFor('haiku')).toEqual({ inputPerMTok: 1, outputPerMTok: 5, known: true });
    expect(priceFor('sonnet')).toEqual({ inputPerMTok: 3, outputPerMTok: 15, known: true });
    expect(priceFor('opus')).toEqual({ inputPerMTok: 5, outputPerMTok: 25, known: true });
  });

  it('falls back to Sonnet-class numbers with an unknown flag, and lets overrides win', () => {
    expect(priceFor('mystery-model')).toEqual({ inputPerMTok: 3, outputPerMTok: 15, known: false });
    expect(rateForModel('mystery-model')).toBeUndefined();
    expect(priceFor('claude-opus-5', { 'claude-opus-5': { inputPerMTok: 1, outputPerMTok: 1 } }))
      .toEqual({ inputPerMTok: 1, outputPerMTok: 1, known: true });
  });

  it('prices one 1M-input request identically in the replay, the comparison and the helper report', () => {
    for (const [model, usd] of [['claude-opus-5', 5], ['claude-opus-4-6-20260401', 5], ['claude-sonnet-5', 2]] as const) {
      expect(realSessionUsd([millionInput(model)], null), model).toBeCloseTo(usd, 9);
      expect(requestUsd(millionInput(model), null), model).toBeCloseTo(usd, 9);
      const root = tempDir('shared-price-');
      const projects = join(root, 'projects', 'fixture');
      mkdirSync(projects, { recursive: true });
      writeFileSync(join(projects, 's1.jsonl'), JSON.stringify({
        type: 'assistant', sessionId: 's1', timestamp: '2026-10-09T12:00:00Z',
        message: { id: 'm1', model, usage: { input_tokens: 1_000_000, output_tokens: 0 } },
      }));
      const report = compareTranscriptCosts({
        rows: [], roots: [join(root, 'projects')], prices: {},
        start: Date.parse('2026-10-09T00:00:00Z'), end: Date.parse('2026-10-10T00:00:00Z'),
      });
      expect(report.transcript, model).toBeCloseTo(usd, 9);
    }
  });

  it('still reports unpriced models in the comparison instead of guessing', () => {
    const root = tempDir('shared-price-unpriced-');
    const projects = join(root, 'projects', 'fixture');
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, 's1.jsonl'), JSON.stringify({
      type: 'assistant', sessionId: 's1', timestamp: '2026-10-09T12:00:00Z',
      message: { id: 'm1', model: 'mystery-model', usage: { input_tokens: 10, output_tokens: 0 } },
    }));
    const report = compareTranscriptCosts({
      rows: [], roots: [join(root, 'projects')], prices: {},
      start: Date.parse('2026-10-09T00:00:00Z'), end: Date.parse('2026-10-10T00:00:00Z'),
    });
    expect(report.unpricedModels).toEqual(['mystery-model']);
    expect(report.transcript).toBe(0);
  });
});

describe('transcript root discovery', () => {
  it('adds every managed account profile\'s projects home to the default root', () => {
    const dir = tempDir('transcript-roots-');
    const userData = join(dir, 'userData');
    const config = join(dir, 'config');
    process.env['CLAUDE_CONFIG_DIR'] = config;
    mkdirSync(join(userData, 'claude-cli-profiles', 'profile-a', 'projects', 'project-a'), { recursive: true });
    mkdirSync(join(userData, 'claude-cli-profiles', 'profile-b', 'projects'), { recursive: true });
    mkdirSync(join(userData, 'claude-cli-profiles', 'not-a-profile'), { recursive: true });
    writeFileSync(join(userData, 'claude-cli-profiles', 'not-a-profile', 'projects'), 'file, not a dir');
    mkdirSync(join(userData, 'claude-cli-profiles', 'empty-profile'), { recursive: true });
    const dirs = transcriptProjectsDirs(userData);
    expect(dirs[0]).toBe(join(config, 'projects'));
    expect([...dirs].sort()).toEqual([
      join(config, 'projects'),
      join(userData, 'claude-cli-profiles', 'profile-a', 'projects'),
      join(userData, 'claude-cli-profiles', 'profile-b', 'projects'),
    ].sort());
  });

  it('lets an explicit override replace discovery entirely', () => {
    const dir = tempDir('transcript-roots-override-');
    const userData = join(dir, 'userData');
    mkdirSync(join(userData, 'claude-cli-profiles', 'profile-a', 'projects'), { recursive: true });
    expect(transcriptProjectsDirs(userData, '/somewhere/projects')).toEqual(['/somewhere/projects']);
  });
});
