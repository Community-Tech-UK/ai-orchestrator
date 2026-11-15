import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { PlanQueueLinearConnection } from '@contracts/schemas/plan-queue';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { ConnectorAuthService } from '../../mcp/connector-auth-service';
import { OrchestratorMcpRepository } from '../../mcp/orchestrator-mcp-repository';
import { McpSecretStorage } from '../../mcp/secret-storage';

const logLines = vi.hoisted(() => [] as unknown[][]);
vi.mock('../../logging/logger', () => {
  const record = (...args: unknown[]) => {
    logLines.push(args);
  };
  return { getLogger: () => ({ info: record, warn: record, error: record, debug: record }) };
});

import { callLinearTool, callLinearToolOnConnector, type LinearCallDependencies } from './linear-call';
import { checkLinearConnectorRecord } from './linear-connector-address';
import { LinearCallError } from './linear-errors';
import {
  acceptingFakeAddress,
  jsonText,
  plainText,
  startFakeLinearConnector,
  structured,
  toolError,
  type FakeLinearConnector,
  type FakeLinearConnectorOptions,
} from './linear-fake-connector.test-helpers';
import { LinearStatusListSchema, LinearWhoAmISchema } from './linear-result-schemas';

const TOKEN = 'PLACEHOLDER_TOKEN';
const WHO = { user: { id: 'user-1', name: 'Test User', email: 'test@example.test' }, workspace: { id: 'w1', name: 'Test Workspace' } };

const dbs: SqliteDriver[] = [];
const fakes: FakeLinearConnector[] = [];
let notices: string[] = [];

async function fake(options: FakeLinearConnectorOptions): Promise<FakeLinearConnector> {
  const started = await startFakeLinearConnector(options);
  fakes.push(started);
  return started;
}

function setup(url: string, saved: boolean | PlanQueueLinearConnection = true) {
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
  const record = repo.upsert({ name: 'linear-test', transport: 'http', url, authType: 'bearer', kind: 'remote' }).record;
  const auth = new ConnectorAuthService({
    db,
    secrets,
    repo,
    openBrowser: async () => {
      throw new Error('must not open a browser');
    },
    onSignInRequired: (name) => notices.push(name),
  });
  auth.setBearerToken(record.id, TOKEN);
  const connection: PlanQueueLinearConnection =
    typeof saved === 'object'
      ? saved
      : saved
        ? { connectorId: record.id, userId: 'user-1', userName: 'Test User', workspaceName: 'Test Workspace', confirmedAt: 1 }
        : null;
  return { repo, record, auth, connection };
}

function depsFor(
  fixture: ReturnType<typeof setup>,
  fakeConnector: Pick<FakeLinearConnector, 'url'>,
  overrides: Partial<LinearCallDependencies> = {},
): LinearCallDependencies {
  return {
    readConnection: () => fixture.connection,
    getConnector: (id) => fixture.repo.get(id)?.record ?? null,
    auth: fixture.auth,
    checkRecord: acceptingFakeAddress(fakeConnector),
    timeoutMs: 3000,
    ...overrides,
  };
}

beforeEach(() => {
  notices = [];
  logLines.length = 0;
});
afterEach(async () => {
  for (const started of fakes.splice(0)) await started.close();
  dbs.splice(0).forEach((db) => db.close());
});

describe('callLinearTool: results', () => {
  it('returns a structured result checked by the schema', async () => {
    const connector = await fake({ acceptedToken: TOKEN, tools: { whoami: () => structured(WHO) } });
    const deps = depsFor(setup(connector.url), connector);
    expect((await callLinearTool('whoami', {}, LinearWhoAmISchema, deps)).user.id).toBe('user-1');
    expect(connector.calls).toEqual([{ name: 'whoami', args: {} }]);
    expect(connector.requests.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('reads a result sent as JSON text, including a bare list', async () => {
    const connector = await fake({
      acceptedToken: TOKEN,
      tools: { list_issue_statuses: () => jsonText([{ id: 's1', name: 'Todo', type: 'unstarted' }]) },
    });
    const deps = depsFor(setup(connector.url), connector);
    const statuses = await callLinearTool('list_issue_statuses', { team: 'T' }, LinearStatusListSchema, deps);
    expect(statuses).toEqual([{ id: 's1', name: 'Todo', type: 'unstarted' }]);
    expect(connector.calls[0].args).toEqual({ team: 'T' });
  });

  it('treats a tool error as a failure, never as an answer', async () => {
    const connector = await fake({ acceptedToken: TOKEN, tools: { whoami: () => toolError('Something broke inside Linear') } });
    const deps = depsFor(setup(connector.url), connector);
    const failure = await callLinearTool('whoami', {}, z.unknown(), deps).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LinearCallError);
    expect(failure).toMatchObject({ code: 'unexpected-result' });
    expect((failure as LinearCallError).detail).toContain('Something broke');
    expect((failure as LinearCallError).message).not.toContain('Something broke');
  });

  it('refuses a result of the wrong shape and names the fields', async () => {
    const connector = await fake({ acceptedToken: TOKEN, tools: { whoami: () => structured({ user: { name: 'No id' }, workspace: { id: 'w', name: 'W' } }) } });
    const deps = depsFor(setup(connector.url), connector);
    const failure = await callLinearTool('whoami', {}, LinearWhoAmISchema, deps).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'unexpected-result' });
    expect((failure as LinearCallError).detail).toContain('user.id');
    expect((failure as LinearCallError).detail).toContain('user.email');
    expect((failure as LinearCallError).detail).not.toContain('No id');
  });

  it('refuses text that is not JSON', async () => {
    const connector = await fake({ acceptedToken: TOKEN, tools: { whoami: () => plainText('hello, not json') } });
    const deps = depsFor(setup(connector.url), connector);
    await expect(callLinearTool('whoami', {}, z.unknown(), deps)).rejects.toMatchObject({ code: 'unexpected-result' });
  });

  it('gives up on a call that never answers, within the limit', async () => {
    const connector = await fake({ acceptedToken: TOKEN, tools: { whoami: () => 'hang' } });
    const deps = depsFor(setup(connector.url), connector, { timeoutMs: 200 });
    const started = Date.now();
    await expect(callLinearTool('whoami', {}, z.unknown(), deps)).rejects.toMatchObject({ code: 'unreachable' });
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('refuses a tool that is not on the closed list', async () => {
    const connector = await fake({ acceptedToken: TOKEN, tools: { save_issue: () => structured({}) } });
    const deps = depsFor(setup(connector.url), connector);
    await expect(callLinearTool('save_issue' as never, {}, z.unknown(), deps)).rejects.toThrow('does not call');
    expect(connector.requests).toHaveLength(0);
  });

  it('can call a chosen connector before anything is saved', async () => {
    const connector = await fake({ acceptedToken: TOKEN, tools: { whoami: () => structured(WHO) } });
    const fixture = setup(connector.url, false);
    const deps = depsFor(fixture, connector);
    await expect(callLinearTool('whoami', {}, LinearWhoAmISchema, deps)).rejects.toMatchObject({ code: 'not-set-up' });
    expect(connector.requests).toHaveLength(0);
    expect((await callLinearToolOnConnector(fixture.record.id, 'whoami', {}, LinearWhoAmISchema, deps)).workspace.name).toBe('Test Workspace');
  });
});

describe('callLinearTool: which connector it will talk to', () => {
  it('is not set up when no connection is saved', async () => {
    const connector = await fake({ tools: { whoami: () => structured(WHO) } });
    const deps = depsFor(setup(connector.url, false), connector);
    await expect(callLinearTool('whoami', {}, z.unknown(), deps)).rejects.toMatchObject({ code: 'not-set-up' });
    expect(connector.requests).toHaveLength(0);
  });

  it('refuses a connector whose address was changed after it was chosen, before any request', async () => {
    const connector = await fake({ acceptedToken: TOKEN, tools: { whoami: () => structured(WHO) } });
    const fixture = setup(connector.url);
    const deps = depsFor(fixture, connector);
    await callLinearTool('whoami', {}, LinearWhoAmISchema, deps);
    const requestsBefore = connector.requests.length;
    fixture.repo.upsert({ ...fixture.record, url: 'https://example.test/mcp' });
    await expect(callLinearTool('whoami', {}, z.unknown(), deps)).rejects.toMatchObject({
      code: 'connector-unavailable',
      connectorProblem: 'not-linear',
    });
    expect(connector.requests).toHaveLength(requestsBefore);
  });

  it('reports a connector that is gone, and one that is turned off', async () => {
    const connector = await fake({ acceptedToken: TOKEN, tools: { whoami: () => structured(WHO) } });
    const fixture = setup(connector.url);
    const deps = depsFor(fixture, connector);
    fixture.repo.upsert({ ...fixture.record, autoConnect: false });
    await expect(callLinearTool('whoami', {}, z.unknown(), deps)).rejects.toMatchObject({ code: 'connector-unavailable', connectorProblem: 'off' });
    const gone = depsFor(fixture, connector, { getConnector: () => null });
    await expect(callLinearTool('whoami', {}, z.unknown(), gone)).rejects.toMatchObject({ code: 'connector-unavailable', connectorProblem: 'gone' });
    expect(connector.requests).toHaveLength(0);
  });

  it('refuses Linear\'s read-only address with its own reason, using the real rule', async () => {
    const connector = await fake({ tools: { whoami: () => structured(WHO) } });
    const fixture = setup('https://mcp.linear.app/mcp/readonly');
    const deps = depsFor(fixture, connector, { checkRecord: checkLinearConnectorRecord });
    await expect(callLinearTool('whoami', {}, z.unknown(), deps)).rejects.toMatchObject({ code: 'connector-unavailable', connectorProblem: 'read-only' });
  });

  it('sends the token only to the connector\'s address: a redirect is never followed', async () => {
    const elsewhere = await fake({ tools: { whoami: () => structured(WHO) } });
    const connector = await fake({ redirectTo: elsewhere.url, tools: { whoami: () => structured(WHO) } });
    const deps = depsFor(setup(connector.url), connector);
    await expect(callLinearTool('whoami', {}, z.unknown(), deps)).rejects.toBeInstanceOf(LinearCallError);
    expect(connector.requests.length).toBeGreaterThan(0);
    expect(elsewhere.requests).toHaveLength(0);
  });
});

describe('callLinearTool: sign-in and reaching Linear', () => {
  it('fixes a 401 with a refresh and then succeeds', async () => {
    const connector = await fake({ acceptedToken: 'PLACEHOLDER_CURRENT', tools: { whoami: () => structured(WHO) } });
    const fixture = setup(connector.url);
    const refreshes: boolean[] = [];
    const auth = {
      getAccessToken: async (_id: string, force = false) => {
        refreshes.push(force);
        return force ? 'PLACEHOLDER_CURRENT' : 'PLACEHOLDER_EXPIRED';
      },
      status: () => ({ state: 'signed-in' as const }),
    };
    const deps = depsFor(fixture, connector, { auth });
    expect((await callLinearTool('whoami', {}, LinearWhoAmISchema, deps)).user.id).toBe('user-1');
    expect(refreshes).toContain(true);
    expect(connector.requests[0].authorization).toBe('Bearer PLACEHOLDER_EXPIRED');
    expect(notices).toEqual([]);
  });

  it('needs sign-in, with exactly one notice, when a refresh does not fix a 401', async () => {
    const connector = await fake({ acceptedToken: 'PLACEHOLDER_OTHER', tools: { whoami: () => structured(WHO) } });
    const deps = depsFor(setup(connector.url), connector);
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(callLinearTool('whoami', {}, z.unknown(), deps)).rejects.toMatchObject({ code: 'needs-sign-in' });
    }
    expect(notices).toEqual(['linear-test']);
  });

  it('needs sign-in when the connector is signed out, without any request or browser', async () => {
    const connector = await fake({ acceptedToken: TOKEN, tools: { whoami: () => structured(WHO) } });
    const fixture = setup(connector.url);
    fixture.auth.signOut(fixture.record.id);
    const deps = depsFor(fixture, connector);
    await expect(callLinearTool('whoami', {}, z.unknown(), deps)).rejects.toMatchObject({ code: 'needs-sign-in' });
    expect(connector.requests).toHaveLength(0);
    expect(notices).toEqual(['linear-test']);
  });

  it('reports a rate limit with the wait Linear asked for, when it says', async () => {
    const connector = await fake({ failWith: { status: 429, body: 'Rate limit exceeded. Retry after 7 seconds.' }, tools: {} });
    const deps = depsFor(setup(connector.url), connector);
    const failure = await callLinearTool('whoami', {}, z.unknown(), deps).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'unreachable', rateLimited: true, retryAfterMs: 7000 });
  });

  it('reports a rate limit that arrives as a tool error, and one with no wait given', async () => {
    const connector = await fake({ acceptedToken: TOKEN, tools: { whoami: () => toolError('RATELIMITED: too many requests') } });
    const deps = depsFor(setup(connector.url), connector);
    const failure = await callLinearTool('whoami', {}, z.unknown(), deps).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'unreachable', rateLimited: true });
    expect((failure as LinearCallError).retryAfterMs).toBeUndefined();
  });

  it('reports a server error and a connector that is not listening as unreachable, not rate limited', async () => {
    const broken = await fake({ failWith: { status: 503, body: 'down' }, tools: {} });
    const brokenDeps = depsFor(setup(broken.url), broken);
    await expect(callLinearTool('whoami', {}, z.unknown(), brokenDeps)).rejects.toMatchObject({ code: 'unreachable', rateLimited: false });
    const closed = await startFakeLinearConnector({ tools: {} });
    await closed.close();
    const closedDeps = depsFor(setup(closed.url), closed);
    await expect(callLinearTool('whoami', {}, z.unknown(), closedDeps)).rejects.toMatchObject({ code: 'unreachable' });
  });
});

describe('callLinearTool: what is logged', () => {
  it('logs the tool, the time and the outcome, and nothing secret or from the request or result', async () => {
    const connector = await fake({
      acceptedToken: TOKEN,
      tools: {
        whoami: () => structured({ ...WHO, note: 'RESULT_MARKER_TEXT' }),
        list_teams: () => toolError('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789 RESULT_MARKER_TEXT'),
      },
    });
    const deps = depsFor(setup(connector.url), connector);
    await callLinearTool('whoami', { query: 'ARGUMENT_MARKER_TEXT' }, LinearWhoAmISchema, deps);
    const failure = await callLinearTool('list_teams', { query: 'ARGUMENT_MARKER_TEXT' }, z.unknown(), deps).catch((error: unknown) => error as LinearCallError);
    const logged = JSON.stringify(logLines);
    expect(logLines).toHaveLength(2);
    expect(logged).toContain('whoami');
    expect(logged).toContain('durationMs');
    expect(logged).toContain('"outcome":"ok"');
    expect(logged).toContain('unexpected-result');
    for (const secret of [TOKEN, 'Bearer', 'ARGUMENT_MARKER_TEXT', 'RESULT_MARKER_TEXT', 'abcdefghijklmnopqrstuvwxyz']) {
      expect(logged).not.toContain(secret);
    }
    // The error text kept for the page is redacted and cut to 500 characters.
    expect((failure as LinearCallError).detail).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect((failure as LinearCallError).detail!.length).toBeLessThanOrEqual(500);
  });

  it('cuts connector error text to 500 characters', async () => {
    const connector = await fake({ acceptedToken: TOKEN, tools: { whoami: () => toolError('x'.repeat(5000)) } });
    const deps = depsFor(setup(connector.url), connector);
    const failure = await callLinearTool('whoami', {}, z.unknown(), deps).catch((error: unknown) => error as LinearCallError);
    expect((failure as LinearCallError).detail).toHaveLength(500);
  });
});
