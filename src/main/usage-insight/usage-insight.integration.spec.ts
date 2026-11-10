/**
 * The whole "Where your usage went" path on real files: invented Claude
 * transcripts in a temp config home, an invented cost-attribution log, and a real
 * in-memory cost table, read by the real scanner, reader and service.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeTokenCost } from '../../shared/data/model-pricing';
import type { UsageCauseId, UsageInsightReport, UsageInsightResponse } from '../../shared/usage-insight/usage-insight.types';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { ClaudeTranscriptScanner } from './claude-transcript-usage-scanner';
import {
  assistantLine,
  setModified,
  toolResultLine,
  writeTranscript,
} from './claude-transcript.test-helpers';
import { UsageAttributionReader } from './usage-attribution-reader';
import { createCostLogSessionLinks } from './usage-insight-runtime';
import { UsageInsightService } from './usage-insight-service';
import { useSqliteTemplate } from '../db/sqlite-template.test-helpers';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const START = NOW - 2 * DAY;
const at = (minutes: number): number => START + minutes * MINUTE;
const MODEL = 'claude-opus-5';

interface Usage { input?: number; cacheWrite?: number; cacheRead?: number; output?: number }
const cost = (usage: Usage): number => computeTokenCost(MODEL, {
  inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite,
});

/**
 * Session A: started by Harness at max effort; its first request carried 45K of start-up context.
 * Session C: a helper Harness started for A (the link is known only from the cost log), doing most of the work.
 * Session T: run from a terminal, so nothing is known about its effort.
 */
const A = [
  { id: 'a1', at: at(0), input: 45_000, output: 100 },
  { id: 'a2', at: at(2), input: 10, cacheRead: 160_000, output: 100 },
  { id: 'a3', at: at(30), input: 10, cacheWrite: 120_000, cacheRead: 10, output: 100 },
] as const;
const C = [
  { id: 'c1', at: at(5), input: 30_000, output: 30_000 },
  { id: 'c2', at: at(6), input: 30_000, output: 30_000 },
] as const;
const T = [
  { id: 't1', at: at(300), input: 5_000, output: 50 },
  { id: 't2', at: at(301), input: 90_000, output: 50 },
  { id: 't3', at: at(302), input: 90_000, output: 50 },
] as const;

describe('Where your usage went, end to end', () => {
  const rlmTemplate = useSqliteTemplate((db) => {
    createTables(db);
    createMigrationsTable(db);
    runMigrations(db);
  });
  let home: string;
  let logs: string;
  let db: SqliteDriver;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'usage-e2e-home-'));
    logs = mkdtempSync(join(tmpdir(), 'usage-e2e-logs-'));
    db = rlmTemplate.open();
    arrange();
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(logs, { recursive: true, force: true });
  });

  function transcript(name: string, lines: string[]): void {
    const file = join(home, 'projects', '-work-app', name);
    writeTranscript(file, lines);
    setModified(file, NOW - MINUTE);
  }

  function arrange(): void {
    transcript('sess-A.jsonl', [
      assistantLine({ ...A[0], sessionId: 'sess-A', model: MODEL }),
      toolResultLine({ chars: 200_000, at: at(1), sessionId: 'sess-A' }),
      assistantLine({ ...A[1], sessionId: 'sess-A', model: MODEL }),
      assistantLine({ ...A[2], sessionId: 'sess-A', model: MODEL }),
    ]);
    transcript('sess-C.jsonl', C.map((request) => assistantLine({ ...request, sessionId: 'sess-C', model: MODEL })));
    transcript('sess-T.jsonl', T.map((request) => assistantLine({ ...request, sessionId: 'sess-T', model: MODEL })));
    writeFileSync(
      join(logs, 'cost-attribution-2026-10-18.jsonl'),
      [
        { ts: at(3), instanceId: 'inst-A', sessionId: 'sess-A', reasoningEffort: 'max' },
        { ts: at(31), instanceId: 'inst-A', sessionId: 'sess-A', reasoningEffort: 'max' },
        { ts: at(7), instanceId: 'inst-C', parentId: 'inst-A', reasoningEffort: 'high' },
      ].map((row) => `${JSON.stringify({ source: 'instance-turn', provider: 'claude', parentId: null, ...row })}\n`).join(''),
    );
    for (const [instanceId, sessionId, timestamp] of [['inst-A', 'sess-A', at(3)], ['inst-C', 'sess-C', at(7)]] as const) {
      db.prepare(`INSERT INTO cost_entries(id,timestamp,instance_id,session_id,model,input_tokens,output_tokens,cost)
        VALUES(?,?,?,?,?,?,?,?)`).run(`${instanceId}-${timestamp}`, timestamp, instanceId, sessionId, MODEL, 1, 1, 0);
    }
  }

  function service(instances: Record<string, { provider: string; sessionId?: string }> = {}): UsageInsightService {
    return new UsageInsightService({
      scanner: new ClaudeTranscriptScanner({ roots: () => [home], now: () => NOW }),
      attribution: new UsageAttributionReader(() => logs),
      loadSessionLinks: createCostLogSessionLinks(() => db),
      resolveInstance: (id) => instances[id],
      now: () => NOW,
    });
  }

  async function ready(target: UsageInsightService, instanceId?: string): Promise<UsageInsightReport> {
    const latest: { response?: UsageInsightResponse } = {};
    await vi.waitFor(() => {
      const response = target.getResponse(instanceId ? { instanceId } : {});
      latest.response = response;
      expect(response.status === 'ready' && !response.refreshing).toBe(true);
    }, { timeout: 5_000 });
    const final = latest.response;
    if (final?.status !== 'ready') throw new Error('not ready');
    return final.report;
  }

  const cause = (report: UsageInsightReport, id: UsageCauseId) => report.causes.find((entry) => entry.id === id)!;

  it('measures the causes across every session, from the files', async () => {
    const report = await ready(service());
    expect(report.totals).toEqual({ requests: 8, sessions: 3, harnessSessions: 2 });
    // Only a3 read more than 100K fresh. Only a2 sent a prompt over 150K.
    expect(cause(report, 'cacheMiss').requests).toBe(1);
    expect(cause(report, 'longContext').requests).toBe(1);
    // Helper session C did most of the work in A's group, so both are helper-heavy; T worked alone.
    expect(cause(report, 'helperHeavy')).toMatchObject({ requests: 5, sessions: 2 });
    // A's first request carried 45K; C and T started smaller.
    expect(cause(report, 'alwaysOnContext')).toMatchObject({ requests: 3, sessions: 1, typicalTokens: 45_000 });
    // The 50K-token result was in A's chat for a2 and a3.
    expect(cause(report, 'bigToolResults').requests).toBe(2);
    expect(cause(report, 'parallelSessions').requests).toBe(0);
    expect(cause(report, 'longRunning').requests).toBe(0);
  });

  it('weights each cause by what its requests would cost, not by how many there were', async () => {
    const report = await ready(service());
    const a = A.map(cost);
    const c = C.map(cost);
    const total = [...A, ...C, ...T].map(cost).reduce((sum, value) => sum + value, 0);
    expect(cause(report, 'cacheMiss').share).toBeCloseTo(a[2] / total, 8);
    expect(cause(report, 'longContext').share).toBeCloseTo(a[1] / total, 8);
    expect(cause(report, 'helperHeavy').share).toBeCloseTo((a[0] + a[1] + a[2] + c[0] + c[1]) / total, 8);
    expect(cause(report, 'bigToolResults').share).toBeCloseTo((a[1] + a[2]) / total, 8);
  });

  it('knows the effort only for sessions Harness recorded, so max effort is "at least"', async () => {
    const report = await ready(service());
    expect(cause(report, 'maxEffort')).toMatchObject({ requests: 3, atLeast: true });
    expect(cause(report, 'workflows')).toMatchObject({ requests: 0, share: 0 });
    const known = [...A, ...C].map(cost).reduce((sum, value) => sum + value, 0);
    const total = [...A, ...C, ...T].map(cost).reduce((sum, value) => sum + value, 0);
    expect(report.coverage.effortKnown).toBeCloseTo(known / total, 8);
    expect(report.notes).toContainEqual({ code: 'effort-partly-recorded', knownPercent: Math.round((known / total) * 100) });
  });

  it('reports one session by itself, found through the cost log and the current session id', async () => {
    const report = await ready(service({ 'inst-A': { provider: 'claude', sessionId: 'sess-A' } }), 'inst-A');
    expect(report.scope).toEqual({ kind: 'session', instanceId: 'inst-A' });
    expect(report.totals.requests).toBe(3);
    expect(cause(report, 'cacheMiss').requests).toBe(1);
    // Effort is known for all of this session's usage, so the figure is exact.
    expect(cause(report, 'maxEffort').atLeast).toBeUndefined();
    expect(cause(report, 'maxEffort').share).toBe(1);
  });

  it('reads a helper agent kept in its own file under the session', async () => {
    const file = join(home, 'projects', '-work-app', 'sess-T', 'subagents', 'agent-1.jsonl');
    writeTranscript(file, [assistantLine({
      id: 'th1', at: at(303), sessionId: 'sess-T', model: MODEL, input: 10, cacheRead: 400_000, output: 60_000, sidechain: true, agentId: 'agent-1',
    })]);
    setModified(file, NOW - MINUTE);
    const report = await ready(service());
    expect(report.totals.requests).toBe(9);
    // The helper's one big request now outweighs everything else T did.
    expect(cause(report, 'helperHeavy').sessions).toBe(3);
  });

  it('answers with no usage when there are no transcripts', async () => {
    rmSync(join(home, 'projects'), { recursive: true, force: true });
    const report = await ready(service());
    expect(report.totals.requests).toBe(0);
    expect(report.notes).toContainEqual({ code: 'no-claude-usage' });
  });
});
