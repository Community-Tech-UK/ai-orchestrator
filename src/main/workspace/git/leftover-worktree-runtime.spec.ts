import { describe, expect, it, vi } from 'vitest';
import { collectLeftoverOwners, listRuntimeLeftoverWorktrees } from './leftover-worktree-runtime';
const database = vi.hoisted(() => ({ loopConfigs: [] as string[], queueRoots: [] as string[] }));
vi.mock('../../orchestration/loop-store-service', () => ({ getLoopStoreService: () => ({
  getDb: () => ({ prepare: (sql: string) => ({ all: () => sql.includes('config_json')
    ? database.loopConfigs.map((config_json) => ({ config_json }))
    : database.queueRoots.map((workspace_cwd) => ({ workspace_cwd })) }) }),
}) }));

describe('leftover owner discovery', () => {
  it('finds an ended owner despite 250 newer runs using only uncapped readers', () => {
    const listRuns = vi.fn(() => Array.from({ length: 250 }, (_, i) => ({ id: `new-${i}` })));
    const store = { listRuns,
      getPendingWorktreeLifecycles: () => [{ id: 'old', status: 'completed-needs-review',
        workspaceCwd: '/repo', worktreePath: '/repo/.worktrees/old', branchName: 'old',
        autoIntegrateWorktree: true, lifecycle: { phase: 'blocked' } }],
      listResumableRuns: () => [{ runRow: { id: 'parked', status: 'provider-limit',
        worktree_path: '/repo/.worktrees/parked' }, config: { workspaceCwd: '/repo' } }],
    };
    const owners = collectLeftoverOwners(store, [], new Map());
    expect(owners).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'old', phase: 'blocked', inUse: false }),
      expect.objectContaining({ id: 'parked', inUse: true }),
    ]));
    expect(listRuns).not.toHaveBeenCalled();
  });
  it('treats a non-terminal queue item as live even when its run has ended', () => {
    const owners = collectLeftoverOwners({ getPendingWorktreeLifecycles: () => [], listResumableRuns: () => [] }, [
      { id: 'working', runId: 'ended', state: 'working', worktreePath: '/repo/.worktrees/working' },
      { id: 'parked', runId: 'ended', state: 'parked', worktreePath: '/repo/.worktrees/parked' },
    ], new Map([['ended', '/repo']]));
    expect(owners.map((o) => [o.id, o.inUse])).toEqual([['working', true], ['parked', false]]);
  });
  it('reports distinct recorded loop and queue workspaces plus the open workspace', async () => {
    database.loopConfigs = [JSON.stringify({ workspaceCwd: '/old-loop-workspace' })];
    database.queueRoots = ['/queue-workspace', '/old-loop-workspace', '/old-loop-workspace/.worktrees/old'];
    let statusReads = 0;
    const report = await listRuntimeLeftoverWorktrees({ owners: () => [], liveSessions: () => [],
      now: () => Date.parse('2026-10-13T12:00:00Z'), size: async () => 0,
      git: async (args, cwd) => {
        const root = cwd.split('/.worktrees/')[0];
        if (args[1] === 'worktree') return `worktree ${root}\0HEAD fixture-main\0branch refs/heads/main\0\0worktree ${root}/.worktrees/old\0HEAD fixture-tip\0branch refs/heads/old\0\0`;
        if (args[1] === 'status') { statusReads++; return ''; }
        if (args[1] === 'rev-list') return '0\t1';
        if (args[1] === 'cherry') return '+ fixture-tip';
        if (args[1] === 'diff') return '1 file changed, 1 insertion(+)';
        if (args[1] === 'show') return String(Date.parse('2026-09-01T12:00:00Z') / 1000);
        if (args[1] === 'merge-base') throw Object.assign(new Error('not merged'), { code: 1 });
        return '';
      },
    }, '/open-workspace');
    expect(report.errors).toEqual([]);
    expect(report.rows.map((row) => row.repoRoot).sort()).toEqual(['/old-loop-workspace', '/open-workspace', '/queue-workspace']);
    expect(statusReads).toBe(3);
  });
});
