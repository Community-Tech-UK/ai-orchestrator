import { describe, expect, it } from 'vitest';
import {
  PROTECTED_ORIGIN,
  PUBLIC_ORIGIN,
  recoveryHarness,
  settle,
} from './browser-secret-recovery.testutil';

const storedState = { version: 2, origins: [PROTECTED_ORIGIN], tabs: { '42': PROTECTED_ORIGIN } };

describe('extension secret observation protection setting', () => {
  it('does not taint after a fill when the operator setting is off', async () => {
    const h = recoveryHarness({ version: 2, origins: [], tabs: {} });
    await h.applySecretObservationProtectionEnabled(false);
    await h.markSecretTaint(42, PROTECTED_ORIGIN);
    expect(h.secretTaintedTabs.size).toBe(0);
    expect(h.secretTaintedOrigins.size).toBe(0);
    await expect(h.assertSecretObservationAllowed({
      id: 'snap-1',
      command: 'snapshot',
      target: { tabId: 42 },
    })).resolves.toBeUndefined();
    expect(await h.secretTaintOriginForTab({
      id: 42,
      windowId: 7,
      url: PROTECTED_ORIGIN + '/',
      title: 'Protected',
    })).toBeNull();
  });

  it('still taints when the operator setting is on', async () => {
    const h = recoveryHarness({ version: 2, origins: [], tabs: {} });
    await h.applySecretObservationProtectionEnabled(true);
    await h.markSecretTaint(42, PROTECTED_ORIGIN);
    expect(h.secretTaintedOrigins.has(PROTECTED_ORIGIN)).toBe(true);
    expect(h.secretTaintedTabs.get('42')).toBe(PROTECTED_ORIGIN);
    await expect(h.assertSecretObservationAllowed({
      id: 'snap-1',
      command: 'snapshot',
      target: { tabId: 42 },
    })).rejects.toThrow(/browser_secret_observation_blocked_for_tainted_origin/);
  });

  it('clears existing taint flags only when the setting is applied off', async () => {
    const h = recoveryHarness(storedState);
    await h.loadSecretTaints();
    expect(h.secretTaintedOrigins.size).toBe(1);
    await h.applySecretObservationProtectionEnabled(false);
    expect(h.secretTaintedTabs.size).toBe(0);
    expect(h.secretTaintedOrigins.size).toBe(0);
    expect(h.storage['browserGatewaySecretTaints']).toEqual({ version: 2, origins: [], tabs: {} });
    expect(h.storage['browserSecretObservationProtectionEnabled']).toBe(false);
    expect(h.protectionEnabled()).toBe(false);
    expect(h.storage['browserGatewayEnabled']).toBe(false);
  });

  it('reports protection disabled to the popup instead of listing tainted origins', async () => {
    const h = recoveryHarness(storedState);
    await h.applySecretObservationProtectionEnabled(false);
    const status = await h.status();
    expect(status).toEqual({
      ok: true,
      protectionEnabled: false,
      origins: [],
      tabCount: 0,
      reviewToken: null,
    });
  });

  it('applies a false payload on a command before observation and fill taint', async () => {
    const h = recoveryHarness(storedState);
    await h.loadSecretTaints();
    expect(h.secretTaintedOrigins.size).toBe(1);
    await h.applySecretObservationProtectionFromCommand({
      id: 'inv-1',
      command: 'report_inventory',
      payload: { secretObservationProtectionEnabled: false },
    });
    expect(h.secretTaintedOrigins.size).toBe(0);
    await expect(h.assertSecretObservationAllowed({
      id: 'snap-1',
      command: 'download_file',
      target: { tabId: 42 },
    })).resolves.toBeUndefined();
    await h.markSecretTaint(42, PUBLIC_ORIGIN);
    expect(h.secretTaintedOrigins.size).toBe(0);
  });

  it('keeps an applied false when an older storage read resolves afterwards', async () => {
    // Storage still says ON from before the operator switched it off.
    const h = recoveryHarness(storedState);
    h.storage['browserSecretObservationProtectionEnabled'] = true;
    let releaseStaleRead: (() => void) | undefined;
    const realGet = h.chrome.storage.local.get.getMockImplementation()!;
    h.chrome.storage.local.get.mockImplementationOnce(async (key: string) => {
      const stale = await realGet(key);
      await new Promise<void>((resolve) => { releaseStaleRead = resolve; });
      return stale;
    });

    // An inventory/observation path starts the first read...
    const observation = h.loadSecretObservationProtection();
    // ...and a stamped command applies the operator's false while it is pending.
    const apply = h.applySecretObservationProtectionFromCommand({
      id: 'inv-1',
      command: 'report_inventory',
      payload: { secretObservationProtectionEnabled: false },
    });
    await settle();
    releaseStaleRead!();
    await Promise.all([observation, apply]);

    expect(h.protectionEnabled()).toBe(false);
    expect(h.storage['browserSecretObservationProtectionEnabled']).toBe(false);
    // A credential fill after that must not re-arm the taint.
    await h.markSecretTaint(42, PROTECTED_ORIGIN);
    expect(h.secretTaintedOrigins.size).toBe(0);
    await expect(h.assertSecretObservationAllowed({
      id: 'snap-2',
      command: 'snapshot',
      target: { tabId: 42 },
    })).resolves.toBeUndefined();
  });

  it('reads the stored false after a service-worker restart without any command', async () => {
    const h = recoveryHarness({ version: 2, origins: [], tabs: {} });
    h.storage['browserSecretObservationProtectionEnabled'] = false;

    await h.markSecretTaint(42, PROTECTED_ORIGIN);

    expect(h.protectionEnabled()).toBe(false);
    expect(h.secretTaintedOrigins.size).toBe(0);
  });

  it('reports protection state and taint counts, never the origins', async () => {
    const h = recoveryHarness(storedState);
    expect(await h.secretObservationStatus()).toEqual({
      protectionEnabled: true,
      taintedOriginCount: 1,
      taintedTabCount: 1,
    });
    await h.applySecretObservationProtectionEnabled(false);
    const status = await h.secretObservationStatus();
    expect(status).toEqual({ protectionEnabled: false, taintedOriginCount: 0, taintedTabCount: 0 });
    expect(JSON.stringify(status)).not.toContain(PROTECTED_ORIGIN);
  });
});

