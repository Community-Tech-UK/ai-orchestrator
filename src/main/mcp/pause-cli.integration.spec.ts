import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createTables, createMigrationsTable, runMigrations } from '../persistence/rlm/rlm-schema';
import { GlobalPauseStore } from '../global-pause/global-pause-store';
import { GlobalPauseService } from '../global-pause/global-pause-service';
import { WorkAdmission } from '../work-admission/work-admission';
import { OrchestratorToolsRpcServer } from './orchestrator-tools-rpc-server';
import { runPauseCli } from './pause-cli';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));

describe('pause CLI through the parent dispatcher', () => {
  let db: SqliteDriver;
  let service: GlobalPauseService;
  let server: OrchestratorToolsRpcServer;
  let admission: WorkAdmission;
  beforeEach(() => {
    GlobalPauseService._resetForTesting();
    db = defaultDriverFactory(':memory:'); createTables(db); createMigrationsTable(db); runMigrations(db);
    admission = new WorkAdmission();
    service = GlobalPauseService.getInstance({ store: new GlobalPauseStore(db), setAdmissionPhase: phase => admission.setGlobalPhase(phase), runtime: {
      sessions: () => [{ id: 'chat', displayName: 'Private task label', busy: true, lastRequest: 'Task-specific context', lastReply: '', helperReplies: [] }],
      engines: async () => [], pauseEngines: async () => undefined, stopHelpers: async () => undefined,
      interruptSession: async () => true, collectNote: async () => null, resumeSession: async () => 'chat', resumeEngine: async () => undefined, level: () => 3,
    } });
    server = new OrchestratorToolsRpcServer({ userDataPath: '/tmp', operatorDbPath: '/tmp/unused-pause-tests.db',
      isKnownLocalInstance: id => id === 'caller', registerCleanup: () => undefined, toolFactory: () => [] });
  });
  afterEach(() => { GlobalPauseService._resetForTesting(); admission.dispose(); db.close(); });
  const request = (method: string, instanceId = 'caller') => server.handleRequest({ jsonrpc: '2.0', id: 1, method,
    params: { instanceId, payload: {} } });
  it('holds and releases new queue work through the real parent dispatch', async () => {
    const client = { call: (method: string) => request(method) };
    await runPauseCli(['hold'], { client, stdout: () => undefined });
    expect(admission.check('queue-job').allowed).toBe(false);
    await runPauseCli(['release'], { client, stdout: () => undefined });
    expect(admission.check('queue-job').allowed).toBe(true);
  });
  it('cannot release or resume restart pause, and status omits saved notes', async () => {
    await service.pauseForRestart({ withNotes: false });
    expect(service.getState().entries[0].noteText).toContain('Task-specific context');
    const status = await request('orchestrator_tools.pause.release');
    expect(status).toMatchObject({ phase: 'ready' });
    expect(JSON.stringify(status)).not.toContain('Task-specific context');
    expect(JSON.stringify(status)).not.toContain('Private task label');
    await expect(request('orchestrator_tools.pause.resume')).rejects.toThrow('Unknown');
    expect(admission.check('queue-job').allowed).toBe(false);
  });
  it('checks the caller before any pause mutation', async () => {
    await expect(request('orchestrator_tools.pause.hold', 'unknown')).rejects.toThrow('unknown orchestrator-tools instance');
    expect(service.getState().phase).toBe('none');
  });
});
