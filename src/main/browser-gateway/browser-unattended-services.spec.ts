import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const settingsMock = vi.hoisted(() => ({
  values: { browserVaultAutoUnlock: false, browserVaultMasterPasswordFile: '' } as Record<
    string,
    unknown
  >,
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => settingsMock.values }),
}));

vi.mock('./browser-bw-runner', () => ({
  createBwRunner: () => ({
    run: vi.fn(async () => ({ stdout: 'RAW-SESSION\n', stderr: '', code: 0 })),
  }),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import {
  getBrowserVaultStatus,
  maybeAutoUnlockBrowserCredentialVault,
} from './browser-unattended-services';
import {
  _resetBrowserCredentialSessionForTesting,
  getBrowserCredentialSession,
} from './browser-credential-session';

describe('maybeAutoUnlockBrowserCredentialVault', () => {
  let pwFile: string;
  const originalEnv = process.env['AIO_BW_MASTER_PASSWORD_FILE'];

  beforeEach(async () => {
    _resetBrowserCredentialSessionForTesting();
    delete process.env['AIO_BW_MASTER_PASSWORD_FILE'];
    pwFile = path.join(os.tmpdir(), `aio-test-pw-${process.pid}-${Math.random().toString(36).slice(2)}`);
    await fs.writeFile(pwFile, 'the-master-password\n');
    settingsMock.values = { browserVaultAutoUnlock: false, browserVaultMasterPasswordFile: '' };
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env['AIO_BW_MASTER_PASSWORD_FILE'];
    } else {
      process.env['AIO_BW_MASTER_PASSWORD_FILE'] = originalEnv;
    }
    await fs.rm(pwFile, { force: true });
    _resetBrowserCredentialSessionForTesting();
  });

  it('does nothing when auto-unlock is disabled', async () => {
    settingsMock.values = { browserVaultAutoUnlock: false, browserVaultMasterPasswordFile: pwFile };

    await maybeAutoUnlockBrowserCredentialVault();

    expect(getBrowserCredentialSession().locked).toBe(true);
  });

  it('does nothing when enabled but no password source is configured', async () => {
    settingsMock.values = { browserVaultAutoUnlock: true, browserVaultMasterPasswordFile: '' };

    await maybeAutoUnlockBrowserCredentialVault();

    expect(getBrowserCredentialSession().locked).toBe(true);
  });

  it('unlocks at startup when enabled with a readable password file', async () => {
    settingsMock.values = { browserVaultAutoUnlock: true, browserVaultMasterPasswordFile: pwFile };

    expect(getBrowserVaultStatus()).toEqual({ locked: true, passwordSourceConfigured: true });

    await maybeAutoUnlockBrowserCredentialVault();

    expect(getBrowserCredentialSession().locked).toBe(false);
  });

  it('is a no-op when the vault is already unlocked', async () => {
    settingsMock.values = { browserVaultAutoUnlock: true, browserVaultMasterPasswordFile: pwFile };
    getBrowserCredentialSession().unlock('already-open');

    await maybeAutoUnlockBrowserCredentialVault();

    // Still unlocked, token unchanged (no second unlock).
    expect(getBrowserCredentialSession().getToken()).toBe('already-open');
  });

  it('unlocks from the launch env var alone, with the UI flag off', async () => {
    // The operator-owned env var is itself the opt-in — no agent-writable
    // setting involved.
    settingsMock.values = { browserVaultAutoUnlock: false, browserVaultMasterPasswordFile: '' };
    process.env['AIO_BW_MASTER_PASSWORD_FILE'] = pwFile;

    await maybeAutoUnlockBrowserCredentialVault();

    expect(getBrowserCredentialSession().locked).toBe(false);
  });
});
