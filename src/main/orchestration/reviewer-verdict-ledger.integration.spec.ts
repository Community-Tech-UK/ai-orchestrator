import { expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { createInstance, type Instance } from '../../shared/types/instance.types';
vi.mock('../cli/cli-detection', () => ({ detectAvailableClis: async () => [{ name: 'codex', installed: true }] }));
vi.mock('../review/reviewer-model-override', () => ({ resolveReviewerModelOverride: () => undefined }));
import { getReviewerSessionSpawner, ReviewerSessionSpawner, type ReviewerSessionManager } from './reviewer-session-spawner';
import { agenticPingPongReviewer } from './agentic-pingpong-reviewer';
import { recordSessionPolicy } from '../core/system/session-policy-log';

it('joins actual reliable reviewer identities through the existing metadata writer and report CLI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-producer-boundary-'));
  const nativeRequire = createRequire(import.meta.url);
  const moduleLoader = nativeRequire('node:module') as { _load: (request: string, ...args: unknown[]) => unknown };
  const originalLoad = moduleLoader._load;
  const oldElectron = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  const oldType = Object.getOwnPropertyDescriptor(process, 'type');
  Object.defineProperty(process.versions, 'electron', { value: 'inert-fixture', configurable: true });
  Object.defineProperty(process, 'type', { value: 'browser', configurable: true });
  moduleLoader._load = function(request, ...args) {
    return request === 'electron' ? { app: { getPath: () => dir } } : originalLoad.call(this, request, ...args);
  };
  const approved = JSON.stringify({ verdict: 'APPROVED', summary: 'checked', completeness: { filesInspected: 1, commandsRun: 0, scopeCovered: 'widget.ts' }, findings: [], ledger: [] });
  const changes = JSON.stringify({ verdict: 'CHANGES_REQUESTED', summary: 'repair widget', completeness: { filesInspected: 1, commandsRun: 0, scopeCovered: 'widget.ts' }, findings: [{ severity: 'high', novelty: 'new', title: 'Widget fails', evidence: 'Observed failing branch', body: 'Repair the branch' }], ledger: [] });
  const outputs = [approved, 'Malformed initial review', approved, '', approved, changes];
  let live: Instance; let sequence = 0;
  const manager: ReviewerSessionManager = {
    createInstance: vi.fn(async () => {
      sequence++;
      const id = `review-instance-${sequence}`; const thread = `review-thread-${sequence}`;
      live = { ...createInstance({ workingDirectory: dir, provider: 'codex' }), id,
        providerSessionId: sequence === 5 ? '' : thread, status: 'idle',
        readyPromise: Promise.resolve(), outputBuffer: [{ id: `output-${sequence}`, timestamp: Date.now(), type: 'assistant', content: outputs[sequence - 1] }] };
      recordSessionPolicy({ provider: 'codex', threadId: thread, instanceId: id, sessionKind: 'review', level: 'off', arm: 'off', armKey: id, armSource: 'parent', applied: true, outputLimit: null, postTurnCompactPercent: null });
      return live;
    }),
    waitForInstanceSettled: vi.fn(async () => live), getInstance: vi.fn(() => live),
    interruptInstance: vi.fn(() => false), sendInput: vi.fn(async () => undefined),
    terminateInstance: vi.fn(async () => { live.providerSessionId = ''; }), exportSessionMarkdown: () => '',
  };
  try {
    getReviewerSessionSpawner().setInstanceManager(manager);
    const input = { loopRunId: 'inert-loop', workspaceCwd: dir, goal: 'review widget', subject: 'impl' as const, builderProvider: 'claude', reviewerProviderSetting: 'codex', triedReviewerProviders: [], ledger: [], roundNumber: 1, maxRounds: 4, blockingSeverities: ['high'] as const, timeoutMs: 1000 };
    const first = await agenticPingPongReviewer(input);
    const repaired = await agenticPingPongReviewer(input);
    const empty = await agenticPingPongReviewer(input);
    const missing = await agenticPingPongReviewer(input);
    const blocking = await agenticPingPongReviewer(input);
    expect(first.verdict).toBe('APPROVED'); expect(repaired.verdict).toBe('APPROVED');
    expect(repaired.reviewerInstanceId).toBe('review-instance-3'); expect(empty.verdict).toBe('UNRELIABLE'); expect(missing.verdict).toBe('APPROVED');
    expect(blocking.verdict).toBe('CHANGES_REQUESTED');
    expect(first).toMatchObject({ reviewerThreadId: 'review-thread-1' });
    expect(repaired).toMatchObject({ reviewerThreadId: 'review-thread-3' });
    expect(manager.terminateInstance).toHaveBeenCalledTimes(6);
    const policy = join(dir, 'session-policy');
    const records = readdirSync(policy).flatMap(file => readFileSync(join(policy, file), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>));
    expect(records.filter(record => !record['recordType'])).toHaveLength(6);
    const stateDb = join(dir, 'state.sqlite');
    execFileSync('sqlite3', [stateDb, 'CREATE TABLE threads(id TEXT, rollout_path TEXT); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT);']);
    const args = [resolve('scripts/codex-helper-trial-report.mjs'), '--since', new Date(Date.now() - 60000).toISOString(), '--until', new Date(Date.now() + 60000).toISOString(), '--policy-dir', policy, '--state-db', stateDb, '--sessions-dir', dir, '--loop-db', join(dir, 'absent-loop.sqlite'), '--rlm-db', join(dir, 'absent-rlm.sqlite'), '--json'];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, AIO_CODEX_HELPERS_SQLITE_DRIVER: 'cli' } });
    writeFileSync(join(dir, 'report.stdout'), result.stdout ?? ''); writeFileSync(join(dir, 'report.stderr'), result.stderr ?? '');
    writeFileSync(join(dir, 'report.receipt.json'), JSON.stringify({ command: [process.execPath, ...args], status: result.status, signal: result.signal }));
    console.log(`Retained actual producer fixture: ${dir}`);
    expect(result.status, result.stderr).toBe(0); expect(result.signal).toBeNull();
    const report = JSON.parse(result.stdout) as { kindTable: { review: { off: { reviewVerdicts: { returned: number; unknown: number; notReturned: null } } } } };
    expect(records.filter(record => record['recordType'] === 'review-outcome')).toEqual([
      expect.objectContaining({ instanceId: 'review-instance-1', threadId: 'review-thread-1', verdict: 'APPROVED' }),
      expect.objectContaining({ instanceId: 'review-instance-3', threadId: 'review-thread-3', verdict: 'APPROVED' }),
      expect.objectContaining({ instanceId: 'review-instance-6', threadId: 'review-thread-6', verdict: 'CHANGES_REQUESTED' }),
    ]);
    expect(report.kindTable.review.off.reviewVerdicts).toMatchObject({ returned: 3, unknown: 3, notReturned: null });
    const logPath = join(policy, readdirSync(policy)[0]);
    const outcome = { at: new Date().toISOString(), provider: 'codex', recordType: 'review-outcome', instanceId: 'review-instance-1', threadId: 'review-thread-1', verdict: 'APPROVED' };
    function rerun(stem: string) {
      const child = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, AIO_CODEX_HELPERS_SQLITE_DRIVER: 'cli' } });
      writeFileSync(join(dir, `${stem}.stdout`), child.stdout ?? ''); writeFileSync(join(dir, `${stem}.stderr`), child.stderr ?? '');
      writeFileSync(join(dir, `${stem}.receipt.json`), JSON.stringify({ command: [process.execPath, ...args], status: child.status, signal: child.signal }));
      expect(child.status, child.stderr).toBe(0); expect(child.signal).toBeNull();
      return (JSON.parse(child.stdout) as typeof report).kindTable.review.off.reviewVerdicts;
    }
    const append = (row: Record<string, unknown>) => appendFileSync(logPath, `${JSON.stringify(row)}\n`);
    append(outcome);
    append({ ...outcome, provider: 'claude', instanceId: 'review-instance-4', threadId: 'review-thread-4' });
    append({ ...outcome, instanceId: 'foreign-instance', threadId: 'review-thread-4' });
    append({ ...outcome, instanceId: 'review-instance-4', threadId: 'review-thread-4', at: '2000-01-01T00:00:00Z' });
    expect(rerun('duplicate-foreign-old-controls')).toMatchObject({ returned: 3, unknown: 3, notReturned: null });
    append({ ...outcome, verdict: 'CHANGES_REQUESTED' });
    expect(rerun('conflicting-receipts')).toMatchObject({ returned: 2, unknown: 4, notReturned: null });
  } finally {
    moduleLoader._load = originalLoad;
    if (oldElectron) Object.defineProperty(process.versions, 'electron', oldElectron); else Reflect.deleteProperty(process.versions, 'electron');
    if (oldType) Object.defineProperty(process, 'type', oldType); else Reflect.deleteProperty(process, 'type');
    ReviewerSessionSpawner._resetForTesting();
    rmSync(dir, { recursive: true, force: true });
  }
});
