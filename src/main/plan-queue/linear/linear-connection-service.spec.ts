import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanQueueLinearConnection } from '@contracts/schemas/plan-queue';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { ConnectorAuthService } from '../../mcp/connector-auth-service';
import { OrchestratorMcpRepository } from '../../mcp/orchestrator-mcp-repository';
import { McpSecretStorage } from '../../mcp/secret-storage';
import type { OrchestratorMcpServer } from '../../../shared/types/mcp-orchestrator.types';

const logLines = vi.hoisted(() => [] as unknown[][]);
vi.mock('../../logging/logger', () => {
  const record = (...args: unknown[]) => {
    logLines.push(args);
  };
  return { getLogger: () => ({ info: record, warn: record, error: record, debug: record }) };
});

import type { LinearCallDependencies } from './linear-call';
import {
  LINEAR_CHECK_MAX_AGE_MS,
  LinearConnectionService,
  type LinearConnectionDependencies,
} from './linear-connection-service';
import {
  acceptingFakeAddress,
  startFakeLinearConnector,
  structured,
  toolError,
  type FakeLinearConnector,
  type FakeToolResult,
} from './linear-fake-connector.test-helpers';

const TOKEN = 'PLACEHOLDER_TOKEN';
const WHO_1 = { user: { id: 'user-1', name: 'Test User', email: 'test@example.test' }, workspace: { id: 'w1', name: 'Test Workspace' } };
const WHO_2 = { user: { id: 'user-2', name: 'Other User', email: 'other@example.test' }, workspace: { id: 'w1', name: 'Test Workspace' } };

const dbs: SqliteDriver[] = [];
const fakes: FakeLinearConnector[] = [];
const services: LinearConnectionService[] = [];
/** Sign-in notices the connector's own service raised: one name per notice. */
let authNotices: string[] = [];

interface Timer {
  run: () => void;
  delayMs: number;
  cancelled: boolean;
}

interface Fixture {
  connector: FakeLinearConnector;
  repo: OrchestratorMcpRepository;
  record: OrchestratorMcpServer;
  auth: ConnectorAuthService;
  store: { connection: PlanQueueLinearConnection; saves: PlanQueueLinearConnection[]; failSave: boolean };
  notices: { title: string; body: string; fingerprint: Record<string, unknown> }[];
  timers: Timer[];
  clock: { now: number };
  /** What the next "who am I" answers; a function sees the call number (1 for the first). */
  answer: { current: (call: number) => FakeToolResult | Promise<FakeToolResult> };
  callDeps: LinearCallDependencies;
  deps: LinearConnectionDependencies;
}

const SAVED = (connectorId: string): PlanQueueLinearConnection => ({
  connectorId,
  userId: 'user-1',
  userName: 'Test User',
  workspaceName: 'Test Workspace',
  confirmedAt: 1,
});

async function setup(options: { saved?: boolean; acceptedToken?: string; callTimeoutMs?: number } = {}): Promise<Fixture> {
  const answer: Fixture['answer'] = { current: () => structured(WHO_1) };
  let calls = 0;
  const connector = await startFakeLinearConnector({
    acceptedToken: options.acceptedToken ?? TOKEN,
    tools: {
      whoami: () => {
        calls += 1;
        return answer.current(calls);
      },
    },
  });
  fakes.push(connector);
  const db = defaultDriverFactory(':memory:');
  dbs.push(db);
  const secrets = new McpSecretStorage({
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s.split('').reverse().join('')),
      decryptString: (b) => b.toString().split('').reverse().join(''),
    },
  });
  const repo = new OrchestratorMcpRepository(db, secrets);
  const record = repo.upsert({ name: 'linear-test', transport: 'http', url: connector.url, authType: 'bearer', kind: 'remote' }).record;
  const auth = new ConnectorAuthService({
    db,
    secrets,
    repo,
    openBrowser: async () => {
      throw new Error('must not open a browser');
    },
    onSignInRequired: (name) => authNotices.push(name),
  });
  auth.setBearerToken(record.id, TOKEN);
  const store: Fixture['store'] = {
    connection: options.saved === false ? null : SAVED(record.id),
    saves: [],
    failSave: false,
  };
  const notices: Fixture['notices'] = [];
  const timers: Timer[] = [];
  const clock = { now: 1_000_000 };
  const callDeps: LinearCallDependencies = {
    readConnection: () => store.connection,
    getConnector: (id) => repo.get(id)?.record ?? null,
    auth,
    checkRecord: acceptingFakeAddress(connector),
    timeoutMs: options.callTimeoutMs ?? 3000,
  };
  const deps: LinearConnectionDependencies = {
    readConnection: () => store.connection,
    saveConnection: (connection) => {
      if (store.failSave) throw new Error('The settings file could not be written.');
      store.connection = connection;
      store.saves.push(connection);
    },
    listConnectors: () => repo.list().map((entry) => entry.record),
    getConnector: (id) => repo.get(id)?.record ?? null,
    call: callDeps,
    notify: (notice) => notices.push(notice),
    schedule: (run, delayMs) => {
      const timer: Timer = {
        run: () => {
          // A timer that has fired is finished, like one that was cancelled.
          timer.cancelled = true;
          run();
        },
        delayMs,
        cancelled: false,
      };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    now: () => clock.now,
  };
  return { connector, repo, record, auth, store, notices, timers, clock, answer, callDeps, deps };
}

function serviceFor(fixture: Fixture): LinearConnectionService {
  const service = new LinearConnectionService(fixture.deps);
  services.push(service);
  return service;
}

beforeEach(() => {
  authNotices = [];
  logLines.length = 0;
});
afterEach(async () => {
  services.splice(0).forEach((service) => service.dispose());
  for (const started of fakes.splice(0)) await started.close();
  dbs.splice(0).forEach((db) => db.close());
});

describe('the connection states, each from the right cause', () => {
  it('is not set up when nothing is saved, and makes no request', async () => {
    const fixture = await setup({ saved: false });
    const service = serviceFor(fixture);
    expect(service.snapshot()).toMatchObject({ state: 'not-set-up', usable: false, connectorId: null });
    expect(service.snapshot().reason).toMatch(/no Linear connection has been chosen/);
    expect(await service.check()).toMatchObject({ state: 'not-set-up' });
    expect(service.reasonToHold()).toMatch(/^Linear work is paused/);
    expect(fixture.connector.requests).toHaveLength(0);
  });

  it('is checking, and not usable, until the first check has finished; then ready when the same person answers', async () => {
    const fixture = await setup();
    const service = serviceFor(fixture);
    expect(service.snapshot()).toMatchObject({ state: 'checking', usable: false, checkedAt: null });
    expect(service.snapshot().reason).toMatch(/while Harness checks/);
    const ready = await service.check();
    expect(ready).toMatchObject({ state: 'ready', usable: true, reason: null, checkedAt: fixture.clock.now });
    expect(service.reasonToHold()).toBeNull();
    expect(fixture.connector.calls).toEqual([{ name: 'whoami', args: {} }]);
  });

  it('is signed in as someone else when "who am I" answers with a different user id, never ready', async () => {
    const fixture = await setup();
    fixture.answer.current = () => structured(WHO_2);
    const service = serviceFor(fixture);
    const snapshot = await service.check();
    expect(snapshot).toMatchObject({ state: 'someone-else', usable: false });
    expect(snapshot.reason).toMatch(/someone other than the person you confirmed/);
    expect(service.reasonToHold()).toBe(snapshot.reason);
  });

  it('needs sign-in when the connector is signed out, without a request or a browser', async () => {
    const fixture = await setup();
    fixture.auth.signOut(fixture.record.id);
    const service = serviceFor(fixture);
    const snapshot = await service.check();
    expect(snapshot).toMatchObject({ state: 'needs-sign-in', usable: false });
    expect(snapshot.reason).toContain('Settings → Connectors');
    expect(fixture.connector.requests).toHaveLength(0);
  });

  it.each([
    ['gone', (f: Fixture) => f.repo.delete(f.record.id)],
    ['off', (f: Fixture) => f.repo.upsert({ ...f.record, autoConnect: false })],
    ['not-linear', (f: Fixture) => f.repo.upsert({ ...f.record, url: 'https://example.test/mcp' })],
  ] as const)('reports the connector changed when it is %s', async (problem, change) => {
    const fixture = await setup();
    change(fixture);
    const service = serviceFor(fixture);
    const snapshot = await service.check();
    expect(snapshot).toMatchObject({ state: 'connector-changed', usable: false, connectorProblem: problem });
    expect(snapshot.reason).toMatch(/^Linear work is paused/);
    expect(fixture.connector.requests).toHaveLength(0);
  });

  it('is unreachable when Linear does not answer, and again with its own cause for a limit or a strange answer', async () => {
    const fixture = await setup({ callTimeoutMs: 300 });
    const service = serviceFor(fixture);
    fixture.answer.current = () => 'hang';
    expect(await service.check()).toMatchObject({ state: 'unreachable', usable: false, unreachableCause: 'unreachable' });
    fixture.answer.current = () => toolError('Rate limit exceeded. Retry after 600 seconds.');
    expect(await service.check()).toMatchObject({ state: 'unreachable', unreachableCause: 'rate-limited' });
    fixture.answer.current = () => structured({ nothing: 'useful' });
    expect(await service.check()).toMatchObject({ state: 'unreachable', unreachableCause: 'unexpected' });
  });

  it('never puts anything Linear said in the reason, the snapshot or a notice', async () => {
    const fixture = await setup();
    fixture.answer.current = () => toolError('LINEAR-SAYS-SECRET-WORDS rate limit');
    const service = serviceFor(fixture);
    const snapshot = await service.check();
    service.reasonToHold();
    expect(JSON.stringify(snapshot)).not.toContain('LINEAR-SAYS-SECRET-WORDS');
    expect(JSON.stringify(fixture.notices)).not.toContain('LINEAR-SAYS-SECRET-WORDS');
  });
});

describe('when checks run', () => {
  it('checks again only once the last result is older than five minutes', async () => {
    const fixture = await setup();
    const service = serviceFor(fixture);
    await service.check();
    fixture.clock.now += LINEAR_CHECK_MAX_AGE_MS;
    expect(service.reasonToHold()).toBeNull();
    await vi.waitFor(() => expect(fixture.connector.calls).toHaveLength(1));
    fixture.clock.now += 1;
    service.reasonToHold();
    await vi.waitFor(() => expect(fixture.connector.calls).toHaveLength(2));
  });

  it('starts the first check after a restart when a start check or the page asks', async () => {
    const fixture = await setup();
    const service = serviceFor(fixture);
    expect(service.reasonToHold()).toMatch(/while Harness checks/);
    await vi.waitFor(() => expect(service.snapshot().state).toBe('ready'));
    const page = serviceFor(await setup());
    page.list();
    await vi.waitFor(() => expect(page.snapshot().state).toBe('ready'));
  });

  it('checks straight after a call fails, and shares a check already running', async () => {
    const fixture = await setup();
    const service = serviceFor(fixture);
    await service.check();
    service.noteCallFailure();
    service.noteCallFailure();
    await vi.waitFor(() => expect(fixture.connector.calls).toHaveLength(2));
    expect(service.snapshot().state).toBe('ready');
  });

  it('retries "cannot be reached" after 1, 2 and then every 5 minutes, and stops once it is reachable', async () => {
    const fixture = await setup({ callTimeoutMs: 150 });
    fixture.answer.current = () => 'hang';
    const service = serviceFor(fixture);
    const delays: number[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      await service.check();
      const timer = fixture.timers.filter((t) => !t.cancelled).at(-1)!;
      delays.push(timer.delayMs);
      expect(service.snapshot().retryAt).toBe(fixture.clock.now + timer.delayMs);
    }
    expect(delays).toEqual([60_000, 120_000, 300_000, 300_000]);
    fixture.answer.current = () => structured(WHO_1);
    fixture.timers.filter((t) => !t.cancelled).at(-1)!.run();
    await vi.waitFor(() => expect(service.snapshot().state).toBe('ready'));
    expect(fixture.timers.filter((t) => !t.cancelled)).toHaveLength(0);
    expect(service.snapshot().retryAt).toBeNull();
  });

  it('waits as long as Linear asked when that is longer than the schedule', async () => {
    const fixture = await setup();
    fixture.answer.current = () => toolError('Rate limit exceeded. Retry after 600 seconds.');
    const service = serviceFor(fixture);
    await service.check();
    expect(fixture.timers.at(-1)!.delayMs).toBe(600_000);
  });

  it('does not retry any other state by itself', async () => {
    const fixture = await setup();
    fixture.answer.current = () => structured(WHO_2);
    const service = serviceFor(fixture);
    await service.check();
    expect(fixture.timers).toHaveLength(0);
  });
});

describe('the connectors offered on the page', () => {
  function record(overrides: Partial<OrchestratorMcpServer>): OrchestratorMcpServer {
    return {
      id: 'c',
      name: 'n',
      scope: 'orchestrator',
      kind: 'remote',
      authType: 'oauth',
      transport: 'http',
      url: 'https://mcp.linear.app/mcp',
      autoConnect: true,
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    };
  }

  it('lists the ones at Linear\'s address, with the reason when one cannot be used yet, and no others', async () => {
    const fixture = await setup({ saved: false });
    fixture.deps.listConnectors = () => [
      record({ id: 'good', name: 'Good' }),
      record({ id: 'readonly', name: 'Read only', url: 'https://mcp.linear.app/mcp/readonly' }),
      record({ id: 'off', name: 'Off', autoConnect: false }),
      record({ id: 'offother', name: 'Off elsewhere', autoConnect: false, url: 'https://example.test/mcp' }),
      record({ id: 'lookalike', name: 'linear', url: 'https://mcp.linear.app.example.test/mcp' }),
      record({ id: 'm365', name: 'Mail', kind: 'microsoft365' }),
      record({ id: 'local', name: 'Local', kind: 'local', transport: 'stdio', url: undefined }),
    ];
    const listed = serviceFor(fixture).list();
    expect(listed.connectors.map((c) => [c.connectorId, c.problem])).toEqual([
      ['good', null],
      ['readonly', 'read-only'],
      ['off', 'off'],
    ]);
    expect(listed.connectors[1].problemReason).toMatch(/read-only/);
    expect(listed.connection.state).toBe('not-set-up');
  });
});

describe('Identify and Confirm', () => {
  it('Identify shows who the connector signs in as and saves nothing', async () => {
    const fixture = await setup({ saved: false });
    const identity = await serviceFor(fixture).identify(fixture.record.id);
    expect(identity).toEqual({
      connectorId: fixture.record.id,
      userId: 'user-1',
      userName: 'Test User',
      userEmail: 'test@example.test',
      workspaceName: 'Test Workspace',
    });
    expect(fixture.store.saves).toEqual([]);
    expect(fixture.store.connection).toBeNull();
  });

  it('Identify refuses a connector that is not at Linear\'s address, before any request', async () => {
    const fixture = await setup({ saved: false });
    fixture.repo.upsert({ ...fixture.record, url: 'https://example.test/mcp' });
    await expect(serviceFor(fixture).identify(fixture.record.id)).rejects.toMatchObject({ code: 'connector-unavailable' });
    expect(fixture.connector.requests).toHaveLength(0);
  });

  it('Confirm asks again and saves only what the second answer said, and is ready straight away', async () => {
    const fixture = await setup({ saved: false });
    const service = serviceFor(fixture);
    const shown = await service.identify(fixture.record.id);
    fixture.answer.current = () =>
      structured({ user: { id: 'user-1', name: 'Name From Second Read', email: 'x@example.test' }, workspace: { id: 'w1', name: 'Second Workspace' } });
    const snapshot = await service.confirm(shown.connectorId, shown.userId);
    expect(fixture.connector.calls).toHaveLength(2);
    expect(fixture.store.saves).toEqual([
      {
        connectorId: fixture.record.id,
        userId: 'user-1',
        userName: 'Name From Second Read',
        workspaceName: 'Second Workspace',
        confirmedAt: fixture.clock.now,
      },
    ]);
    expect(snapshot).toMatchObject({ state: 'ready', usable: true, userName: 'Name From Second Read' });
    expect(fixture.connector.calls).toHaveLength(2);
  });

  it('Confirm saves nothing when the sign-in changed between Identify and Confirm', async () => {
    const fixture = await setup({ saved: false });
    const service = serviceFor(fixture);
    const shown = await service.identify(fixture.record.id);
    fixture.answer.current = () => structured(WHO_2);
    await expect(service.confirm(shown.connectorId, shown.userId)).rejects.toThrow(/sign-in changed/);
    expect(fixture.store.saves).toEqual([]);
    expect(fixture.store.connection).toBeNull();
    expect(service.snapshot().state).toBe('not-set-up');
  });

  it('Confirm saves nothing when the id the page sent is not the one the connector now reports', async () => {
    const fixture = await setup({ saved: false });
    await expect(serviceFor(fixture).confirm(fixture.record.id, 'someone-the-page-invented')).rejects.toThrow(/sign-in changed/);
    expect(fixture.store.saves).toEqual([]);
  });

  it('Forget clears the saved connection and stops the retry timer', async () => {
    const fixture = await setup({ callTimeoutMs: 150 });
    fixture.answer.current = () => 'hang';
    const service = serviceFor(fixture);
    await service.check();
    expect(fixture.timers.filter((t) => !t.cancelled)).toHaveLength(1);
    const snapshot = service.forget();
    expect(snapshot).toMatchObject({ state: 'not-set-up', connectorId: null });
    expect(fixture.store.connection).toBeNull();
    expect(fixture.timers.filter((t) => !t.cancelled)).toHaveLength(0);
  });
});

describe('crash windows', () => {
  it('a restart with nothing saved is "not set up"', async () => {
    const fixture = await setup({ saved: false });
    const restarted = serviceFor(fixture);
    expect(restarted.snapshot().state).toBe('not-set-up');
    expect(restarted.reasonToHold()).not.toBeNull();
  });

  it('a restart with a saved connection and a signed-out connector is not usable before the first check and after it', async () => {
    const fixture = await setup();
    fixture.auth.signOut(fixture.record.id);
    const restarted = serviceFor(fixture);
    expect(restarted.snapshot()).toMatchObject({ state: 'checking', usable: false });
    expect(restarted.reasonToHold()).toMatch(/while Harness checks/);
    await vi.waitFor(() => expect(restarted.snapshot().state).toBe('needs-sign-in'));
    expect(restarted.snapshot().usable).toBe(false);
    expect(restarted.reasonToHold()).toMatch(/sign in to "linear-test" again/);
  });

  it('a Confirm interrupted before the save leaves nothing saved', async () => {
    const fixture = await setup({ saved: false, callTimeoutMs: 200 });
    const service = serviceFor(fixture);
    const shown = await service.identify(fixture.record.id);
    fixture.answer.current = () => 'hang';
    await expect(service.confirm(shown.connectorId, shown.userId)).rejects.toMatchObject({ code: 'unreachable' });
    expect(fixture.store.connection).toBeNull();
    expect(fixture.store.saves).toEqual([]);
  });

  it('a save that fails leaves the old connection and the old state', async () => {
    const fixture = await setup();
    const service = serviceFor(fixture);
    await service.check();
    fixture.store.failSave = true;
    await expect(service.confirm(fixture.record.id, 'user-1')).rejects.toThrow(/could not be written/);
    expect(fixture.store.connection).toEqual(SAVED(fixture.record.id));
  });

  it('a Confirm overtaken by a Forget saves nothing', async () => {
    const fixture = await setup({ saved: false });
    const service = serviceFor(fixture);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    fixture.answer.current = async () => {
      await gate;
      return structured(WHO_1);
    };
    const confirming = service.confirm(fixture.record.id, 'user-1');
    await vi.waitFor(() => expect(fixture.connector.calls).toHaveLength(1));
    service.forget();
    release();
    await expect(confirming).rejects.toThrow(/changed while this was being confirmed/);
    // The only write was the Forget's own; the overtaken Confirm wrote nothing.
    expect(fixture.store.saves).toEqual([null]);
    expect(fixture.store.connection).toBeNull();
  });
});

describe('two at once', () => {
  it('two checks started together make one "who am I" call and share the result', async () => {
    const fixture = await setup();
    const service = serviceFor(fixture);
    const [first, second] = await Promise.all([service.check(), service.check()]);
    expect(fixture.connector.calls).toHaveLength(1);
    expect(first).toEqual(second);
    expect(first.state).toBe('ready');
  });

  it('a check that started before a Forget does not write its answer afterwards', async () => {
    const fixture = await setup();
    const service = serviceFor(fixture);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    fixture.answer.current = async () => {
      await gate;
      return structured(WHO_1);
    };
    const checking = service.check();
    await vi.waitFor(() => expect(fixture.connector.calls).toHaveLength(1));
    service.forget();
    // The very same connection comes back, so only the version check can tell the old answer is stale.
    fixture.store.connection = SAVED(fixture.record.id);
    release();
    await checking;
    expect(service.snapshot()).toMatchObject({ state: 'checking', checkedAt: null });
  });

  it('a check that started before a Confirm does not overwrite the newer state', async () => {
    const fixture = await setup();
    const service = serviceFor(fixture);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    fixture.answer.current = async (call) => {
      if (call === 1) {
        await gate;
        return structured(WHO_2);
      }
      return structured(WHO_1);
    };
    const checking = service.check();
    await vi.waitFor(() => expect(fixture.connector.calls).toHaveLength(1));
    await service.confirm(fixture.record.id, 'user-1');
    expect(service.snapshot().state).toBe('ready');
    release();
    await checking;
    expect(service.snapshot()).toMatchObject({ state: 'ready', usable: true });
  });
});

describe('notices', () => {
  it('one sign-in failure raises the connector\'s one notice across several failed calls, and this service adds none', async () => {
    const fixture = await setup({ acceptedToken: 'PLACEHOLDER_OTHER' });
    const service = serviceFor(fixture);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await service.check()).toMatchObject({ state: 'needs-sign-in' });
      service.reasonToHold();
    }
    service.noteCallFailure();
    await service.check();
    expect(authNotices).toEqual(['linear-test']);
    expect(fixture.notices).toEqual([]);
  });

  it('"signed in as someone else" raises one notice per entry, only when a run is held by it', async () => {
    const fixture = await setup();
    fixture.answer.current = () => structured(WHO_2);
    const service = serviceFor(fixture);
    await service.check();
    service.list();
    expect(fixture.notices).toEqual([]);
    service.reasonToHold();
    service.reasonToHold();
    await service.check();
    service.reasonToHold();
    expect(fixture.notices).toHaveLength(1);
    expect(fixture.notices[0].body).toBe(service.snapshot().reason);
    fixture.answer.current = () => structured(WHO_1);
    await service.check();
    service.reasonToHold();
    fixture.answer.current = () => structured(WHO_2);
    await service.check();
    service.reasonToHold();
    expect(fixture.notices).toHaveLength(2);
  });

  it('"the connector changed" raises one notice when a run is held by it', async () => {
    const fixture = await setup();
    fixture.repo.upsert({ ...fixture.record, autoConnect: false });
    const service = serviceFor(fixture);
    await service.check();
    service.reasonToHold();
    service.reasonToHold();
    expect(fixture.notices).toHaveLength(1);
    expect(fixture.notices[0].title).toBe('Linear work is paused');
  });

  it('"cannot be reached" raises no notice', async () => {
    const fixture = await setup({ callTimeoutMs: 150 });
    fixture.answer.current = () => 'hang';
    const service = serviceFor(fixture);
    await service.check();
    service.reasonToHold();
    expect(fixture.notices).toEqual([]);
    expect(authNotices).toEqual([]);
  });

  it('logs no secret: the token never appears in a log line', async () => {
    const fixture = await setup();
    const service = serviceFor(fixture);
    await service.check();
    expect(JSON.stringify(logLines)).not.toContain(TOKEN);
  });
});
