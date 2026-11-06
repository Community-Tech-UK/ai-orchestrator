import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { aggregateSubagentMetrics, collectSubagentSessions, type ParentSessionRecord, type SubagentRecord } from '../claude-cost-audit-report.mjs';

const t = Date.parse('2026-10-18T10:00:00Z');
const minute = 60_000;
function agent(start: number, returned: number, turn = 'turn-a') {
  return { meta: { agentType: 'general-purpose' }, model: 'claude-sonnet-4-6', parentModel: 'claude-opus-4-8',
    firstAt: t + start * minute, lastAt: t + returned * minute, returnedAt: t + returned * minute,
    parentTurnId: turn, spendUsd: 0.01, finalContext: 100, runMs: (returned - start) * minute, isError: false, longWaits: [] };
}
function session(id: string, agents: SubagentRecord[]): ParentSessionRecord {
  return { sessionId: id, arm: 'sonnet', parentModel: 'claude-opus-4-8', firstAt: t,
    activityAt: [t], subagents: agents };
}
function aggregate(sessions: ParentSessionRecord[]) {
  return aggregateSubagentMetrics(sessions, {
    sinceMs: t - minute, untilMs: t + 120 * minute,
    policyEntries: sessions.map(s => ({ provider: 'claude', sessionId: s.sessionId,
      at: new Date(t - minute).toISOString(), setting: 'trial', arm: 'sonnet', applied: true, reviewerRuleDelivered: true })),
  }).arms.sonnet;
}

describe('Claude helper respawn ownership', () => {
  it('does not combine unrelated parents in the same trial arm', () => {
    expect(aggregate([session('parent-1', [agent(0, 1)]), session('parent-2', [agent(2, 3)])]).respawnRate).toBe(0);
  });
  it('excludes overlapping helpers and different turns while retaining exact ten-minute and nine-minute controls', () => {
    expect(aggregate([session('parent-1', [agent(0, 60), agent(1, 2)])]).respawnRate).toBe(0);
    expect(aggregate([session('parent-1', [agent(0, 1), agent(2, 3, 'turn-b')])]).respawnRate).toBe(0);
    expect(aggregate([session('parent-1', [agent(0, 1), agent(10, 12)])]).respawnRate).toBe(0.5);
    expect(aggregate([session('parent-1', [agent(0, 1), agent(11, 12)])]).respawnRate).toBe(0.5);
    expect(aggregate([session('parent-1', [agent(0, 1), agent(12, 13)])]).respawnRate).toBe(0);
  });
  it('an overlapping start does not hide a valid respawn after an earlier return', () => {
    expect(aggregate([session('parent-1', [agent(0, 2), agent(1, 60), agent(3, 4)])]).respawnRate).toBeCloseTo(1 / 3);
  });
  it('reports missing turn identity or an early background-launch receipt as unknown lifecycle evidence', () => {
    const unknownTurn = { ...agent(0, 1), parentTurnId: undefined };
    const backgroundReceipt = { ...agent(2, 60), returnedAt: t + 3 * minute };
    const metrics = aggregate([session('parent-1', [unknownTurn, backgroundReceipt])]);
    expect(metrics.respawnUnknown).toBe(2);
    expect(metrics.respawnRate).toBe(0);
  });
  it('collects real parent-turn and return identity before aggregating and printing the CLI report', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-respawn-owner-'));
    try {
      const project = join(root, 'projects', 'fixture');
      const policy = join(root, 'session-policy'); mkdirSync(policy, { recursive: true });
      const assistant = (id: string, at: number, content: unknown[] = []) => ({ type: 'assistant',
        timestamp: new Date(at).toISOString(), message: { id, model: 'claude-opus-4-8', role: 'assistant', content,
          usage: { input_tokens: 10, output_tokens: 1 } } });
      const user = (turn: string, at: number, content: unknown) => ({ type: 'user', uuid: turn,
        timestamp: new Date(at).toISOString(), message: { role: 'user', content } });
      const id = 'parent-1'; const subs = join(project, id, 'subagents'); mkdirSync(subs, { recursive: true });
      writeFileSync(join(project, `${id}.jsonl`), [
        user('turn-one', t, 'Start the task'),
        assistant('start-a', t, [{ type: 'tool_use', name: 'Agent', id: 'a', input: {} }]),
        user('result-a', t + minute, [{ type: 'tool_result', tool_use_id: 'a', content: 'finished' }]),
        assistant('start-b', t + 10 * minute, [{ type: 'tool_use', name: 'Task', id: 'b', input: {} }]),
        user('result-b', t + 11 * minute, [{ type: 'tool_result', tool_use_id: 'b', content: 'finished' }]),
        user('turn-two', t + 12 * minute, 'A different task'),
        assistant('start-c', t + 12 * minute, [{ type: 'tool_use', name: 'Task', id: 'c', input: {} }]),
        user('result-c', t + 13 * minute, [{ type: 'tool_result', tool_use_id: 'c', content: 'finished' }]),
      ].map(entry => JSON.stringify(entry)).join('\n'));
      for (const [helper, start] of [['a', 0], ['b', 10], ['c', 12]] as const) {
        writeFileSync(join(subs, `agent-${helper}.jsonl`), JSON.stringify(assistant(helper, t + start * minute)));
        writeFileSync(join(subs, `agent-${helper}.meta.json`), JSON.stringify({ agentType: 'general-purpose', toolUseId: helper }));
      }
      writeFileSync(join(policy, 'fixture.jsonl'), JSON.stringify({ provider: 'claude', sessionId: id,
        at: new Date(t - minute).toISOString(), setting: 'trial', arm: 'sonnet', applied: true, reviewerRuleDelivered: true }));
      const collected = await collectSubagentSessions(join(root, 'projects'));
      expect(aggregate(collected).respawnRate).toBeCloseTo(1 / 3);
      const output = execFileSync(process.execPath, ['scripts/claude-cost-audit-report.mjs', '--subagents',
        '--projects', join(root, 'projects'), '--userdata', root, '--since', '2026-10-01'], { encoding: 'utf8' });
      expect(output).toContain('| re-spawn rate | 33.3%');
      expect(output).toContain('pending (sample)');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
