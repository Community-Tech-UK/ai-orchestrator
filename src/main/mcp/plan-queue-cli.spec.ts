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
  { runId: 'run-discarded', parentInstanceId: 'other-session', kind: 'plans', status: 'cancelled', workspace: '/repo', items: [{ state: 'parked', detail: 'Set aside. Discarded by James.' }] },
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

  it.each([
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
