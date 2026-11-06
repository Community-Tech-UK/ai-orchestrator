import { describe, expect, it, vi } from 'vitest';
import { runPlanQueueCli } from './plan-queue-cli';

const SELF = 'self-session';
const env = { AI_ORCHESTRATOR_INSTANCE_ID: SELF };

function run(argv: string[], result: unknown = {}) {
  const output: string[] = [];
  const client = { call: vi.fn(async () => result) };
  return { client, output, done: runPlanQueueCli(argv, { client, env, cwd: '/repo', stdout: text => { output.push(text); } }) };
}

const STATUS = { runs: [
  { runId: 'run-mine', parentInstanceId: SELF, kind: 'plans', status: 'running', workspace: '/repo', items: [{ state: 'working' }, { state: 'queued' }] },
  { runId: 'run-theirs', parentInstanceId: 'other-session', kind: 'livetests', status: 'paused', workspace: '/repo', items: [{ state: 'queued' }] },
  { runId: 'run-done', parentInstanceId: 'other-session', kind: 'plans', status: 'completed', workspace: '/repo', items: [{ state: 'landed' }] },
  { runId: 'run-set-aside', parentInstanceId: 'other-session', kind: 'plans', status: 'completed', workspace: '/repo', items: [{ state: 'parked', branch: 'queue/a' }] },
  { runId: 'run-discarded', parentInstanceId: 'other-session', kind: 'plans', status: 'cancelled', workspace: '/repo', items: [{ state: 'parked', discardedAt: 1 }] },
  { runId: 'run-elsewhere', parentInstanceId: 'other-session', kind: 'plans', status: 'completed', workspace: '/other-repo', items: [{ state: 'parked', branch: 'queue/b' }] },
  { runId: 'run-live-elsewhere', parentInstanceId: 'other-session', kind: 'plans', status: 'running', workspace: '/other-repo', items: [{ state: 'working' }] },
], alerts: [] };

describe('aio-mcp plan-queue', () => {
  it('prints help without contacting Harness', async () => {
    const { client, output, done } = run(['--help']);
    await done;
    expect(client.call).not.toHaveBeenCalled();
    expect(output.join('')).toContain('aio-mcp plan-queue move <run-id> [--to <session-id>]');
    expect(output.join('')).toContain('acts for James');
  });

  it('lists running and paused runs with their owners, never printing this session\'s own id', async () => {
    const { client, output, done } = run(['list'], STATUS);
    await done;
    expect(client.call).toHaveBeenCalledWith('orchestrator_tools.plan_queue_status', {});
    const text = output.join('');
    expect(text).toContain('run-mine | running | plans | 2 document(s) | owner: this session');
    expect(text).toContain('run-theirs | paused | livetests | 1 document(s) | owner: session other-session');
    expect(text).toContain('take over: aio-mcp plan-queue move run-theirs');
    expect(text).not.toContain('move run-mine');
    expect(text).not.toContain('run-done');
    expect(text).toContain('run-set-aside | completed | plans | 1 document(s), 1 set aside | owner: session other-session');
    expect(text).not.toContain('run-discarded');
    expect(text).toContain('run-live-elsewhere | running');
    expect(text).not.toContain('run-elsewhere |');
    expect(text).toContain('1 finished run(s) in other folders still hold set-aside jobs; add --all to list them.');
    expect(text).not.toContain(SELF);
  });

  it('keeps its own id out of list JSON too', async () => {
    const { output, done } = run(['list', '--json'], STATUS);
    await done;
    const parsed = JSON.parse(output.join('')) as { runs: { runId: string; ownerInstanceId: string | null; ownedByThisSession: boolean }[] };
    expect(parsed.runs.map(entry => [entry.runId, entry.ownerInstanceId, entry.ownedByThisSession]))
      .toEqual([['run-mine', null, true], ['run-theirs', 'other-session', false], ['run-set-aside', 'other-session', false], ['run-live-elsewhere', 'other-session', false]]);
    expect(JSON.parse(output.join('')).hiddenElsewhere).toBe(1);
    expect(output.join('')).not.toContain(SELF);
  });

  it('treats a run in a folder around this one as here, and a sibling folder named like ../x as elsewhere', async () => {
    const status = { runs: [
      { runId: 'run-parent-folder', parentInstanceId: 'other-session', kind: 'plans', status: 'completed', workspace: '/', items: [{ state: 'parked', branch: 'queue/a' }] },
      { runId: 'run-dotted-sibling', parentInstanceId: 'other-session', kind: 'plans', status: 'completed', workspace: '/..repo', items: [{ state: 'parked', branch: 'queue/b' }] },
    ] };
    const { output, done } = run(['list'], status);
    await done;
    expect(output.join('')).toContain('run-parent-folder |');
    expect(output.join('')).not.toContain('run-dotted-sibling |');
  });

  it('lists finished runs in other folders with --all', async () => {
    const { output, done } = run(['list', '--all'], STATUS);
    await done;
    expect(output.join('')).toContain('run-elsewhere | completed | plans | 1 document(s), 1 set aside');
    expect(output.join('')).not.toContain('add --all');
  });

  it('moves a run to this session by default, or to the session named with --to', async () => {
    const first = run(['move', 'run-theirs'], { runId: 'run-theirs', ownerInstanceId: null });
    await first.done;
    expect(first.client.call).toHaveBeenCalledWith('orchestrator_tools.plan_queue_cli.move', { runId: 'run-theirs' });
    expect(first.output.join('')).toBe('Moved Plan Queue run run-theirs to this session.\n');

    const second = run(['move', 'run-mine', '--to=target'], { runId: 'run-mine', ownerInstanceId: 'target' });
    await second.done;
    expect(second.client.call).toHaveBeenCalledWith('orchestrator_tools.plan_queue_cli.move', { runId: 'run-mine', targetInstanceId: 'target' });
    expect(second.output.join('')).toBe('Moved Plan Queue run run-mine to session target.\n');
  });

  it('lists the set-aside jobs in this folder, and in every folder with --all', async () => {
    const status = { runs: [
      { runId: 'run-here', workspace: '/repo', items: [
        { itemId: 'job-1', document: '/repo/docs/a_plan.md', state: 'parked', parkReason: 'round-limit' },
        { itemId: 'job-gone', document: '/repo/docs/b_plan.md', state: 'parked', discardedAt: 1 },
        { itemId: 'job-live', document: '/repo/docs/c_plan.md', state: 'working' },
      ] },
      { runId: 'run-elsewhere', workspace: '/other-repo', items: [{ itemId: 'job-2', document: '/other-repo/docs/d_plan.md', state: 'parked' }] },
    ] };
    const here = run(['jobs'], status);
    await here.done;
    expect(here.client.call).toHaveBeenCalledWith('orchestrator_tools.plan_queue_status', {});
    expect(here.output.join('')).toBe('job-1 | round-limit | /repo/docs/a_plan.md\n');

    const all = run(['jobs', '--all', '--json'], status);
    await all.done;
    expect(JSON.parse(all.output.join('')).jobs.map((job: { itemId: string }) => job.itemId)).toEqual(['job-1', 'job-2']);

    const none = run(['jobs'], { runs: [] });
    await none.done;
    expect(none.output.join('')).toContain('No set-aside jobs here');
  });

  it('discards each job named, once, in one call', async () => {
    const { client, output, done } = run(['discard', 'job-1', 'job-2', 'job-1'], { discarded: ['job-1', 'job-2'], leftInPlace: [], failed: [] });
    await done;
    expect(client.call.mock.calls).toEqual([['orchestrator_tools.plan_queue_cli.discard', { itemIds: ['job-1', 'job-2'] }]]);
    expect(output.join('')).toBe('Discarded job job-1.\nDiscarded job job-2.\n');
  });

  it('sends a long list in batches', async () => {
    const ids = Array.from({ length: 25 }, (_, index) => `job-${index}`);
    const output: string[] = [];
    const client = { call: vi.fn(async (_method: string, payload: unknown) => ({ discarded: (payload as { itemIds: string[] }).itemIds, leftInPlace: [], failed: [] })) };
    await runPlanQueueCli(['discard', ...ids, '--json'], { client, env, stdout: text => { output.push(text); } });
    expect(client.call.mock.calls.map(([, payload]) => (payload as { itemIds: string[] }).itemIds.length)).toEqual([10, 10, 5]);
    expect(JSON.parse(output.join('')).discarded).toEqual(ids);
  });

  it('reports the jobs that failed and fails overall', async () => {
    const { output, done } = run(['discard', 'stuck', 'fine'], { discarded: ['fine'], leftInPlace: [], failed: [{ itemId: 'stuck', error: 'Only a parked item can be discarded' }] });
    await expect(done).rejects.toThrow('1 of 2 job(s) failed or timed out.');
    expect(output.join('')).toBe('Discarded job fine.\nCould not discard job stuck: Only a parked item can be discarded\n');
  });

  it('says what git would not release, and still counts the job as discarded', async () => {
    const { output, done } = run(['discard', 'job-1'], { discarded: ['job-1'], leftInPlace: [{ itemId: 'job-1', what: ['queue/a'] }], failed: [] });
    await done;
    expect(output.join('')).toBe('Discarded job job-1.\nLeft in place for job job-1: queue/a\n');
  });

  it('carries on to the next batch when a whole call fails', async () => {
    const ids = Array.from({ length: 11 }, (_, index) => `job-${index}`);
    const output: string[] = [];
    const client = { call: vi.fn(async (_method: string, payload: unknown) => {
      const { itemIds } = payload as { itemIds: string[] };
      if (itemIds.length === 10) throw new Error('timed out');
      return { discarded: itemIds, leftInPlace: [], failed: [] };
    }) };
    await expect(runPlanQueueCli(['discard', ...ids, '--json'], { client, env, stdout: text => { output.push(text); } }))
      .rejects.toThrow('10 of 11 job(s) failed or timed out.');
    expect(JSON.parse(output.join('')).discarded).toEqual(['job-10']);
  });

  it.each([
    [['discard'], 'requires at least one <item-id>'],
    [['discard', 'job-1', '--force'], 'Unknown plan-queue discard option'],
    [['jobs', 'extra'], 'The jobs options are --all and --json'],
    [['move'], 'requires <run-id>'],
    [['move', 'run', '--to'], '--to needs a session id'],
    [['move', 'run', 'extra'], 'Unexpected plan-queue move argument'],
    [['move', 'run', '--force'], 'Unknown plan-queue move option'],
    [['list', 'extra'], 'The list options are --all and --json'],
    [['adopt'], 'Unknown plan-queue command'],
  ])('refuses %j before contacting Harness', async (argv, message) => {
    const { client, done } = run(argv);
    await expect(done).rejects.toThrow(message);
    expect(client.call).not.toHaveBeenCalled();
  });
});
