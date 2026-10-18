import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
const home = vi.hoisted(() => ({ path: '' }));
vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => home.path;
  return { ...actual, homedir, default: { ...actual, homedir } };
});
import { readLastClaudeCostState } from './claude-transcript-registry';

describe('readLastClaudeCostState', () => {
  let root: string;
  let cwd: string;
  const encode = (value: string) => value.replace(/[^a-zA-Z0-9]/g, '-');
  const transcript = (workDir: string) => {
    const project = join(home.path, '.claude', 'projects', encode(workDir));
    mkdirSync(project, { recursive: true });
    return join(project, 'session.jsonl');
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aio-cost-state-'));
    home.path = join(root, 'home'); cwd = join(root, 'workspace');
    mkdirSync(cwd, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  it('reads the last CLI-shaped record in a bounded tail, ignoring malformed and partial last lines', () => {
    const modelUsage = { 'claude-opus-5': { inputTokens: 10, outputTokens: 2, costUSD: 1.25 } };
    const state = { type: 'cost-state', totalCostUSD: 1.25, modelUsage, sessionId: 'session', startTime: 123 };
    writeFileSync(transcript(cwd), 'x'.repeat(300_000) + '\n' + JSON.stringify({ ...state, totalCostUSD: 0.5 })
      + '\n' + JSON.stringify(state) + '\nnot-json\n{"type":"cost-state","totalCostUSD":');
    expect(readLastClaudeCostState(cwd, 'session')).toEqual({ totalCostUSD: 1.25, modelUsage });
  });
  it('returns undefined with no transcript or no matching valid record', () => {
    expect(readLastClaudeCostState(cwd, 'session')).toBeUndefined();
    writeFileSync(transcript(cwd), '{"type":"cost-state","total_cost_usd":99}\n');
    expect(readLastClaudeCostState(cwd, 'session')).toBeUndefined();
  });
  it('finds the transcript through the realpath candidate directory', () => {
    const linked = join(root, 'linked'); symlinkSync(cwd, linked);
    writeFileSync(transcript(realpathSync(cwd)), '{"type":"cost-state","totalCostUSD":2}\n');
    expect(readLastClaudeCostState(linked, 'session')?.totalCostUSD).toBe(2);
  });
  it('uses the selected CLI profile and refuses unsafe session paths', () => {
    const profile = join(root, 'profile');
    const folder = join(profile, 'projects', encode(cwd)); mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'session.jsonl'), '{"type":"cost-state","totalCostUSD":3}\n');
    expect(readLastClaudeCostState(cwd, 'session', profile)?.totalCostUSD).toBe(3);
    expect(readLastClaudeCostState(cwd, '../session', profile)).toBeUndefined();
  });
});
