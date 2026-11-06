import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { claudeTranscriptRoots, indexClaudeTranscripts, readSettledCostState } from './claude-cost-state-reader';

const costState = (total: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'cost-state', totalCostUSD: total, modelUsage: {}, sessionId: 's', startTime: 1, ...extra });
const line = (value: Record<string, unknown>): string => JSON.stringify(value);

describe('Claude transcript index', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'aio-cost-index-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('maps session ids to main transcripts and ignores helper files and other extensions', async () => {
    const projects = join(root, 'projects');
    mkdirSync(join(projects, 'p1', 'abc', 'subagents'), { recursive: true });
    writeFileSync(join(projects, 'p1', 'abc.jsonl'), '');
    writeFileSync(join(projects, 'p1', 'abc', 'subagents', 'agent-1.jsonl'), '');
    writeFileSync(join(projects, 'p1', 'notes.txt'), '');
    mkdirSync(join(projects, 'p2'), { recursive: true });
    writeFileSync(join(projects, 'p2', 'def.jsonl'), '');
    const index = await indexClaudeTranscripts([projects]);
    expect([...index.keys()].sort()).toEqual(['abc', 'def']);
    expect(index.get('abc')).toMatch(/abc\.jsonl$/);
  });

  it('reads a profile that links to the shared projects folder only once and skips missing roots', async () => {
    const shared = join(root, 'shared');
    mkdirSync(join(shared, 'p1'), { recursive: true });
    writeFileSync(join(shared, 'p1', 'abc.jsonl'), '');
    const profile = join(root, 'profile');
    mkdirSync(profile, { recursive: true });
    symlinkSync(shared, join(profile, 'projects'));
    const index = await indexClaudeTranscripts([shared, join(profile, 'projects'), join(root, 'missing')]);
    expect(index.size).toBe(1);
  });
});

describe('Claude transcript roots', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'aio-cost-roots-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('lists the default projects folder, an explicit config dir and one folder per account profile', () => {
    mkdirSync(join(root, 'data', 'profiles', 'work'), { recursive: true });
    mkdirSync(join(root, 'data', 'profiles', 'home'), { recursive: true });
    writeFileSync(join(root, 'data', 'profiles', 'stray-file'), '');
    expect(claudeTranscriptRoots({ homeDir: '/home/u', userDataPath: join(root, 'data'), profilesDirName: 'profiles', configDir: '/cfg' }).sort()).toEqual([
      '/cfg/projects', '/home/u/.claude/projects', join(root, 'data', 'profiles', 'home', 'projects'), join(root, 'data', 'profiles', 'work', 'projects'),
    ].sort());
  });

  it('still returns the default folder when there are no profiles', () => {
    expect(claudeTranscriptRoots({ homeDir: '/home/u', userDataPath: join(root, 'none'), profilesDirName: 'profiles' })).toEqual(['/home/u/.claude/projects']);
  });
});

describe('settled cost-state reader', () => {
  let root: string;
  let file: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'aio-cost-reader-')); file = join(root, 's.jsonl'); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const write = (...lines: string[]): void => writeFileSync(file, lines.join('\n') + '\n');

  it('returns the last cost-state when only bookkeeping records follow it', async () => {
    write(line({ type: 'user' }), line({ type: 'assistant' }), costState(1), costState(2.5),
      line({ type: 'queue-operation' }), line({ type: 'attachment' }), line({ type: 'last-prompt' }));
    expect(await readSettledCostState(file)).toEqual({ kind: 'settled', totalCostUSD: 2.5, hasUnknownModelCost: false });
  });

  it('is unsettled when a user, assistant or request record follows the last cost-state', async () => {
    for (const type of ['user', 'assistant', 'api-request', 'api-request-blob', 'system']) {
      write(costState(2), line({ type }));
      expect(await readSettledCostState(file), type).toEqual({ kind: 'unsettled' });
    }
  });

  it('reports the CLI unknown-model flag and tolerates blank lines after the cost-state', async () => {
    writeFileSync(file, costState(3, { hasUnknownModelCost: true }) + '\n\n   \n');
    expect(await readSettledCostState(file)).toEqual({ kind: 'settled', totalCostUSD: 3, hasUnknownModelCost: true });
  });

  it('is unsettled when anything unreadable follows the last cost-state, because a live reply may be half written', async () => {
    const partialAssistant = '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"half a repl';
    for (const tail of [partialAssistant, '{"type":"user","message":{"role":"us', '{"type":"api-request","requestId":"r', 'not-json', '{"type":"cost-state","totalCostUSD":']) {
      writeFileSync(file, costState(3) + '\n' + tail);
      expect(await readSettledCostState(file), tail.slice(0, 24)).toEqual({ kind: 'unsettled' });
    }
  });

  it('does not let an unreadable line before the last cost-state affect it', async () => {
    writeFileSync(file, 'not-json\n' + costState(3) + '\n');
    expect(await readSettledCostState(file)).toEqual({ kind: 'settled', totalCostUSD: 3, hasUnknownModelCost: false });
  });

  it('skips records with an invalid total and falls back to the previous valid one', async () => {
    write(costState(4), costState(-1), costState('9'), costState(Number.NaN));
    expect(await readSettledCostState(file)).toEqual({ kind: 'settled', totalCostUSD: 4, hasUnknownModelCost: false });
  });

  it('is missing when a small file has no cost-state, and when it cannot be read', async () => {
    write(line({ type: 'user' }), line({ type: 'assistant' }));
    expect(await readSettledCostState(file)).toEqual({ kind: 'missing' });
    expect(await readSettledCostState(join(root, 'absent.jsonl'))).toEqual({ kind: 'missing' });
  });

  it('is unsettled, not missing, when the file is larger than the tail and the tail has no cost-state', async () => {
    write(costState(5), line({ type: 'user', pad: 'x'.repeat(5000) }));
    expect(await readSettledCostState(file, 1024)).toEqual({ kind: 'unsettled' });
  });

  it('finds a cost-state inside the tail of a large file without reading the whole file', async () => {
    write(line({ type: 'user', pad: 'x'.repeat(20_000) }), costState(6));
    expect(await readSettledCostState(file, 2048)).toEqual({ kind: 'settled', totalCostUSD: 6, hasUnknownModelCost: false });
  });
});
