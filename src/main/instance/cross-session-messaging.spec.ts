import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createSessionMessagesTables } from './session-messages-schema';
import {
  CrossSessionMessagingService,
  resolveTargetInstance,
  type CrossSessionMessagingDeps,
} from './cross-session-messaging';
import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/types/settings.types';
import type { Instance } from '../../shared/types/instance.types';

let db: SqliteDriver;

vi.mock('../operator/operator-database', () => ({
  getOperatorDatabase: () => ({ get db() { return db; } }),
}));

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'instance-1',
    displayName: 'Session One',
    provider: 'claude',
    status: 'idle',
    workingDirectory: '/repo',
    allowIncomingSessionMessages: false,
    ...overrides,
  } as unknown as Instance;
}

function makeSettings(overrides: Partial<AppSettings['interSessionMessaging']> = {}): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    interSessionMessaging: {
      ...DEFAULT_SETTINGS.interSessionMessaging,
      enabled: true,
      allowCrossProject: false,
      maxHops: 1,
      rateLimitPerMinute: 5,
      ...overrides,
    },
  };
}

function makeDeps(
  instances: Instance[],
  settings: AppSettings,
  sendInput = vi.fn().mockResolvedValue(undefined),
): CrossSessionMessagingDeps {
  return {
    getAllInstances: () => instances,
    getInstance: (id: string) => instances.find((i) => i.id === id),
    sendInput,
    getSettings: () => settings,
  };
}

function auditRows(): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM session_messages ORDER BY created_at ASC').all() as Array<
    Record<string, unknown>
  >;
}

describe('resolveTargetInstance', () => {
  const a = makeInstance({ id: 'a', displayName: 'Alpha' });
  const b = makeInstance({ id: 'b', displayName: 'Beta' });
  const dup1 = makeInstance({ id: 'c', displayName: 'Dup' });
  const dup2 = makeInstance({ id: 'd', displayName: 'Dup' });
  const instances = [a, b, dup1, dup2];

  it('resolves an exact id match', () => {
    expect(resolveTargetInstance(instances, 'a')).toEqual({ kind: 'found', instance: a });
  });

  it('resolves a unique case-insensitive display name', () => {
    expect(resolveTargetInstance(instances, 'ALPHA')).toEqual({ kind: 'found', instance: a });
  });

  it('reports ambiguous when multiple instances share a display name', () => {
    const result = resolveTargetInstance(instances, 'dup');
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates).toEqual([dup1, dup2]);
    }
  });

  it('reports not-found when nothing matches', () => {
    expect(resolveTargetInstance(instances, 'nope')).toEqual({ kind: 'not-found' });
  });
});

describe('CrossSessionMessagingService', () => {
  beforeEach(() => {
    db = defaultDriverFactory(':memory:');
    createSessionMessagesTables(db);
  });

  afterEach(() => {
    db.close();
  });

  it('rejects when the feature is disabled and still writes an audit row', async () => {
    const source = makeInstance({ id: 'src' });
    const target = makeInstance({ id: 'tgt', allowIncomingSessionMessages: true });
    const settings = makeSettings({ enabled: false });
    const service = new CrossSessionMessagingService(makeDeps([source, target], settings));

    const result = await service.sendMessage({ sourceInstanceId: 'src', targetNameOrId: 'tgt', message: 'hi' });

    expect(result).toEqual({ outcome: 'rejected', reason: 'feature-disabled' });
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]['outcome']).toBe('rejected');
    expect(auditRows()[0]['reason']).toBe('feature-disabled');
  });

  it('rejects self-send', async () => {
    const source = makeInstance({ id: 'src', allowIncomingSessionMessages: true });
    const settings = makeSettings();
    const service = new CrossSessionMessagingService(makeDeps([source], settings));

    const result = await service.sendMessage({ sourceInstanceId: 'src', targetNameOrId: 'src', message: 'hi' });
    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'self-send',
      targetInstanceId: 'src',
      targetDisplayName: source.displayName,
    });
  });

  it('rejects a terminated target', async () => {
    const source = makeInstance({ id: 'src' });
    const target = makeInstance({ id: 'tgt', status: 'terminated', allowIncomingSessionMessages: true });
    const settings = makeSettings();
    const service = new CrossSessionMessagingService(makeDeps([source, target], settings));

    const result = await service.sendMessage({ sourceInstanceId: 'src', targetNameOrId: 'tgt', message: 'hi' });
    expect(result).toMatchObject({ outcome: 'rejected', reason: 'target-terminated' });
  });

  it('rejects when the target has not consented', async () => {
    const source = makeInstance({ id: 'src' });
    const target = makeInstance({ id: 'tgt', allowIncomingSessionMessages: false });
    const settings = makeSettings();
    const service = new CrossSessionMessagingService(makeDeps([source, target], settings));

    const result = await service.sendMessage({ sourceInstanceId: 'src', targetNameOrId: 'tgt', message: 'hi' });
    expect(result).toMatchObject({ outcome: 'rejected', reason: 'consent-disabled' });
  });

  it('rejects cross-project delivery when not allowed', async () => {
    const source = makeInstance({ id: 'src', workingDirectory: '/repo-a' });
    const target = makeInstance({ id: 'tgt', workingDirectory: '/repo-b', allowIncomingSessionMessages: true });
    const settings = makeSettings({ allowCrossProject: false });
    const service = new CrossSessionMessagingService(makeDeps([source, target], settings));

    const result = await service.sendMessage({ sourceInstanceId: 'src', targetNameOrId: 'tgt', message: 'hi' });
    expect(result).toMatchObject({ outcome: 'rejected', reason: 'cross-project-not-allowed' });
  });

  it('allows cross-project delivery when explicitly enabled', async () => {
    const source = makeInstance({ id: 'src', workingDirectory: '/repo-a' });
    const target = makeInstance({ id: 'tgt', workingDirectory: '/repo-b', allowIncomingSessionMessages: true });
    const settings = makeSettings({ allowCrossProject: true });
    const sendInput = vi.fn().mockResolvedValue(undefined);
    const service = new CrossSessionMessagingService(makeDeps([source, target], settings, sendInput));

    const result = await service.sendMessage({ sourceInstanceId: 'src', targetNameOrId: 'tgt', message: 'hi' });
    expect(result).toMatchObject({ outcome: 'delivered' });
    expect(sendInput).toHaveBeenCalledTimes(1);
  });

  it('allows same-project delivery and delivers via sendInput with provenance metadata', async () => {
    const source = makeInstance({ id: 'src', displayName: 'Source' });
    const target = makeInstance({ id: 'tgt', allowIncomingSessionMessages: true });
    const settings = makeSettings();
    const sendInput = vi.fn().mockResolvedValue(undefined);
    const service = new CrossSessionMessagingService(makeDeps([source, target], settings, sendInput));

    const result = await service.sendMessage({ sourceInstanceId: 'src', targetNameOrId: 'tgt', message: 'hi there' });

    expect(result).toEqual({
      outcome: 'delivered',
      targetInstanceId: 'tgt',
      targetDisplayName: target.displayName,
      hopCount: 0,
    });
    expect(sendInput).toHaveBeenCalledWith(
      'tgt',
      expect.stringContaining('hi there'),
      undefined,
      expect.objectContaining({
        crossSessionSourceId: 'src',
        crossSessionSourceDisplayName: 'Source',
        crossSessionHopCount: 0,
      }),
    );
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]['outcome']).toBe('delivered');
  });

  it('reports ambiguous and not-found outcomes without delivering', async () => {
    const source = makeInstance({ id: 'src' });
    const dup1 = makeInstance({ id: 'd1', displayName: 'Dup', allowIncomingSessionMessages: true });
    const dup2 = makeInstance({ id: 'd2', displayName: 'Dup', allowIncomingSessionMessages: true });
    const settings = makeSettings();
    const sendInput = vi.fn();
    const service = new CrossSessionMessagingService(makeDeps([source, dup1, dup2], settings, sendInput));

    const ambiguous = await service.sendMessage({ sourceInstanceId: 'src', targetNameOrId: 'dup', message: 'hi' });
    expect(ambiguous.outcome).toBe('ambiguous');

    const notFound = await service.sendMessage({ sourceInstanceId: 'src', targetNameOrId: 'ghost', message: 'hi' });
    expect(notFound).toEqual({ outcome: 'not-found', targetNameOrId: 'ghost' });

    expect(sendInput).not.toHaveBeenCalled();
  });

  it('rejects when the rate limit is exceeded', async () => {
    const source = makeInstance({ id: 'src' });
    const target = makeInstance({ id: 'tgt', allowIncomingSessionMessages: true });
    const settings = makeSettings({ rateLimitPerMinute: 1 });
    const sendInput = vi.fn().mockResolvedValue(undefined);
    const service = new CrossSessionMessagingService(makeDeps([source, target], settings, sendInput));

    const first = await service.sendMessage({ sourceInstanceId: 'src', targetNameOrId: 'tgt', message: 'one' });
    expect(first.outcome).toBe('delivered');

    const second = await service.sendMessage({ sourceInstanceId: 'src', targetNameOrId: 'tgt', message: 'two' });
    expect(second).toMatchObject({ outcome: 'rejected', reason: 'rate-limited' });
  });

  it('rejects a relay once the hop cap is exceeded', async () => {
    const a = makeInstance({ id: 'a', allowIncomingSessionMessages: true });
    const b = makeInstance({ id: 'b', allowIncomingSessionMessages: true });
    const c = makeInstance({ id: 'c', allowIncomingSessionMessages: true });
    const settings = makeSettings({ maxHops: 1, rateLimitPerMinute: 10 });
    const sendInput = vi.fn().mockResolvedValue(undefined);
    const service = new CrossSessionMessagingService(makeDeps([a, b, c], settings, sendInput));

    // a -> b: hop 0 (initial send), allowed.
    const first = await service.sendMessage({ sourceInstanceId: 'a', targetNameOrId: 'b', message: 'hi' });
    expect(first).toMatchObject({ outcome: 'delivered', hopCount: 0 });

    // b relays -> c: hop 1, still within maxHops=1.
    const second = await service.sendMessage({ sourceInstanceId: 'b', targetNameOrId: 'c', message: 'relay' });
    expect(second).toMatchObject({ outcome: 'delivered', hopCount: 1 });

    // c relays -> a: hop 2, exceeds maxHops=1.
    const third = await service.sendMessage({ sourceInstanceId: 'c', targetNameOrId: 'a', message: 'relay again' });
    expect(third).toMatchObject({ outcome: 'rejected', reason: 'hop-cap-exceeded' });
  });

  it('throws when the source instance cannot be found (does not write an audit row)', async () => {
    const settings = makeSettings();
    const service = new CrossSessionMessagingService(makeDeps([], settings));

    await expect(
      service.sendMessage({ sourceInstanceId: 'ghost', targetNameOrId: 'tgt', message: 'hi' }),
    ).rejects.toThrow(/not found/);
    expect(auditRows()).toHaveLength(0);
  });

  describe('listMessageableSessions', () => {
    it('reports a reason for every non-terminated instance other than the source', () => {
      const source = makeInstance({ id: 'src', workingDirectory: '/repo-a' });
      const consented = makeInstance({ id: 'consented', allowIncomingSessionMessages: true, workingDirectory: '/repo-a' });
      const notConsented = makeInstance({ id: 'not-consented', allowIncomingSessionMessages: false });
      const crossProject = makeInstance({ id: 'cross-project', allowIncomingSessionMessages: true, workingDirectory: '/repo-b' });
      const terminated = makeInstance({ id: 'gone', status: 'terminated' });
      const settings = makeSettings();
      const service = new CrossSessionMessagingService(
        makeDeps([source, consented, notConsented, crossProject, terminated], settings),
      );

      const sessions = service.listMessageableSessions('src');
      const byId = new Map(sessions.map((s) => [s.instanceId, s]));

      expect(byId.get('gone')).toBeUndefined();
      expect(byId.get('consented')).toMatchObject({ reachable: true, reason: 'reachable' });
      expect(byId.get('not-consented')).toMatchObject({ reachable: false, reason: 'consent-disabled' });
      expect(byId.get('cross-project')).toMatchObject({ reachable: false, reason: 'cross-project-not-allowed' });
    });

    it('reports feature-disabled for every candidate when the feature is off', () => {
      const source = makeInstance({ id: 'src' });
      const target = makeInstance({ id: 'tgt', allowIncomingSessionMessages: true });
      const settings = makeSettings({ enabled: false });
      const service = new CrossSessionMessagingService(makeDeps([source, target], settings));

      const sessions = service.listMessageableSessions('src');
      expect(sessions.find((s) => s.instanceId === 'tgt')).toMatchObject({ reason: 'feature-disabled' });
    });
  });
});
