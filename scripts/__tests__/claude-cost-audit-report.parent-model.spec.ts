import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { collectSubagentSessions, requestUsd, SUBAGENT_VERDICT_RULES } from '../claude-cost-audit-report.mjs';
import * as transcripts from '../lib/claude-transcripts.mjs';

const roots: string[] = [];
const start = Date.parse('2026-10-01T00:00:00Z');

function request(id: string, at: number | null, model: string | null): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: at === null ? undefined : new Date(at).toISOString(),
    message: { id, model, usage: { input_tokens: 10, output_tokens: 1 } },
  });
}

function fixture(parents: [number | null, string | null][], helperTimes: number[]) {
  const root = mkdtempSync(join(tmpdir(), 'claude-parent-model-'));
  roots.push(root);
  const project = join(root, '-fixture');
  const children = join(project, 'session-a1', 'subagents');
  mkdirSync(children, { recursive: true });
  const parentPath = join(project, 'session-a1.jsonl');
  writeFileSync(parentPath, parents.map(([at, model], i) => request(`parent-${i}`, at, model)).join('\n'));
  helperTimes.forEach((at, i) => {
    const name = `agent-${i}`;
    writeFileSync(join(children, `${name}.jsonl`), request(name, at, 'claude-sonnet-4-5'));
    writeFileSync(join(children, `${name}.meta.json`), JSON.stringify({ toolUseId: name }));
  });
  return { root };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('parent model attribution in the Claude helper report', () => {
  it('keeps latest-at-spawn, equal-time and earliest-model fallback semantics', async () => {
    const { root } = fixture([
      [null, 'claude-haiku-4-5'],
      [start + 30, 'claude-haiku-4-5'],
      [start + 10, 'claude-opus-4-7'],
      [start + 20, 'claude-sonnet-4-5'],
      [start + 20, 'claude-opus-4-6'],
      [start + 40, null],
    ], [5, 10, 19, 20, 21, 30, 40, 50].map(offset => start + offset));
    const [session] = await collectSubagentSessions(root);
    expect(session.parentModel).toBe('claude-opus-4-7');
    expect(session.firstAt).toBe(start + 10);
    expect(session.activityAt).toEqual([10, 20, 20, 30, 40].map(offset => start + offset));
    const models = new Map(session.subagents.map(agent => [agent.meta?.toolUseId, agent.parentModel]));
    expect([...models.entries()].sort()).toEqual([
      ['agent-0', 'claude-opus-4-7'],
      ['agent-1', 'claude-opus-4-7'],
      ['agent-2', 'claude-opus-4-7'],
      ['agent-3', 'claude-opus-4-6'],
      ['agent-4', 'claude-opus-4-6'],
      ['agent-5', 'claude-haiku-4-5'],
      ['agent-6', 'claude-opus-4-7'],
      ['agent-7', 'claude-opus-4-7'],
    ]);
  });

  it.each([
    { name: 'empty', parents: [] },
    { name: 'undated', parents: [[null, 'claude-opus-4-7']] },
  ] satisfies { name: string; parents: [number | null, string | null][] }[])(
    'keeps parent-model evidence unknown for an $name parent', async ({ parents }) => {
    const { root } = fixture(parents, [start]);
    const [session] = await collectSubagentSessions(root);
    expect(session.parentModel).toBeNull();
    expect(session.firstAt).toBeNull();
    expect(session.activityAt).toEqual([]);
    expect(session.subagents).toHaveLength(1);
    expect(session.subagents[0].parentModel).toBeNull();
    });

  it.each([128, 256])('avoids a whole parent-history scan for each of %i helpers', async size => {
    let parentTimestampReads = 0;
    const parent = {
      requests: Array.from({ length: size }, (_, i) => ({
        get at() { parentTimestampReads++; return start + i; },
        model: 'claude-opus-4-7',
      })),
    };
    const helper = { requests: [{ at: start + size, model: 'claude-sonnet-4-5',
      input: 10, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, context: 10 }] };
    const source = readFileSync(join(process.cwd(), 'scripts/claude-cost-audit-report.mjs'), 'utf8');
    const functionSource = (signature: string) => {
      const from = source.indexOf(signature);
      const to = source.indexOf('\n}\n', from);
      if (from < 0 || to < 0) throw new Error(`Missing production function: ${signature}`);
      return source.slice(from, to + 2);
    };
    // Native ESM imports retain their bindings, so a Vitest spy cannot observe
    // the parser used inside this module. Run the unchanged collector with
    // in-memory reader boundaries; real filesystem/parser semantics are above.
    const collect: typeof collectSubagentSessions = runInNewContext(
      `${functionSource('function indexSubagentUsage(')}\n`
      + `${functionSource('async function collectSubagentSessions(')}\ncollectSubagentSessions`,
      {
        listTranscripts: () => [
          { path: 'parent', kind: 'main', sessionId: 'session-a1' },
          ...Array.from({ length: size }, (_, i) => ({ path: `helper-${i}`, kind: 'subagent', sessionId: 'session-a1' })),
        ],
        realpathSync: (path: string) => path,
        parseTranscript: async (path: string) => path === 'parent' ? parent : helper,
        parseTaskToolOutcomes: () => new Map<string, never>(), readSubagentMeta: () => null,
        basename, requestUsd, armForSessionId: () => 'sonnet',
        activityReturns: transcripts.activityReturns, SUBAGENT_VERDICT_RULES,
      },
    );
    const [session] = await collect('fixture');
    expect(session.subagents).toHaveLength(size);
    expect(session.subagents.every(agent => agent.parentModel === 'claude-opus-4-7')).toBe(true);
    // A generous operation budget catches the old helpers × requests scan
    // without relying on elapsed time or the exact binary-search implementation.
    expect(parentTimestampReads).toBeGreaterThan(0);
    expect(parentTimestampReads).toBeLessThan(32 * size);
  });
});
