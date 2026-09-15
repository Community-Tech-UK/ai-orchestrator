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

const serviceMocks = vi.hoisted(() => ({
  bwRun: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => settingsMock.values }),
}));

vi.mock('./browser-bw-runner', () => ({
  createBwRunner: () => ({
    run: serviceMocks.bwRun,
  }),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: serviceMocks.loggerWarn,
  }),
}));

vi.mock('./browser-unattended-sqlite-stores', () => ({
  SqliteCredentialAuthorizationStore: class {},
  SqliteEscalationRecordStore: class {},
  SqliteBrowserCampaignStore: class {},
  SqliteVaultOriginBindingStore: class {
    put(): void {}
    get(): undefined { return undefined; }
  },
}));

import {
  getBrowserCredentialVault,
  getBrowserVaultStatus,
  maybeAutoUnlockBrowserCredentialVault,
  unlockBrowserCredentialVault,
} from './browser-unattended-services';
import {
  _resetBrowserCredentialSessionForTesting,
  getBrowserCredentialSession,
} from './browser-credential-session';

describe('maybeAutoUnlockBrowserCredentialVault', () => {
  let pwFile: string;
  const originalEnv = process.env['AIO_BW_MASTER_PASSWORD_FILE'];

  beforeEach(async () => {
    serviceMocks.bwRun.mockReset().mockResolvedValue({
      stdout: 'RAW-SESSION\n',
      stderr: '',
      code: 0,
    });
    serviceMocks.loggerWarn.mockReset();
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

    // sharedTabCredentialFillEnabled added 2026-08-29: the Browser screen shows a
    // standing warning while autonomous sign-in on the operator's own tabs is on.
    expect(getBrowserVaultStatus()).toEqual({
      locked: true,
      passwordSourceConfigured: true,
      sharedTabCredentialFillEnabled: false,
    });

    await maybeAutoUnlockBrowserCredentialVault();

    expect(getBrowserCredentialSession().locked).toBe(false);
  });

  it('shares one in-flight bw unlock across concurrent callers', async () => {
    settingsMock.values = { browserVaultAutoUnlock: true, browserVaultMasterPasswordFile: pwFile };

    const results = await Promise.all([
      unlockBrowserCredentialVault(),
      unlockBrowserCredentialVault(),
    ]);

    expect(results).toEqual([{ unlocked: true }, { unlocked: true }]);
    expect(serviceMocks.bwRun).toHaveBeenCalledOnce();
  });

  it('reports shared-tab credential fill in the vault status', () => {
    settingsMock.values = { browserAllowSharedTabCredentialFill: true };
    expect(getBrowserVaultStatus().sharedTabCredentialFillEnabled).toBe(true);

    settingsMock.values = { browserAllowSharedTabCredentialFill: false };
    expect(getBrowserVaultStatus().sharedTabCredentialFillEnabled).toBe(false);
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

describe('forced re-unlock', () => {
  // Holding a session token is not the same as holding a working one. Bitwarden
  // keeps ONE active CLI session, so a long sleep or another process running
  // `bw unlock` rotates the key out from under us. Before `force`, asking again
  // did nothing at all, because the early return treats "token held" as unlocked.
  let pwFile: string;

  beforeEach(async () => {
    serviceMocks.bwRun.mockReset().mockResolvedValue({
      stdout: 'RAW-SESSION\n',
      stderr: '',
      code: 0,
    });
    serviceMocks.loggerWarn.mockReset();
    _resetBrowserCredentialSessionForTesting();
    pwFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'vault-force-')), 'pw.txt');
    await fs.writeFile(pwFile, 'master-password', 'utf8');
    settingsMock.values = {
      browserVaultAutoUnlock: true,
      browserVaultMasterPasswordFile: pwFile,
    };
  });

  it('does nothing when a token is held and force is not set', async () => {
    getBrowserCredentialSession().unlock('STALE-TOKEN');

    await maybeAutoUnlockBrowserCredentialVault();

    expect(getBrowserCredentialSession().getToken()).toBe('STALE-TOKEN');
  });

  it('replaces a held token when forced', async () => {
    getBrowserCredentialSession().unlock('STALE-TOKEN');

    await maybeAutoUnlockBrowserCredentialVault({ force: true });

    expect(getBrowserVaultStatus().locked).toBe(false);
    expect(getBrowserCredentialSession().getToken()).toBe('RAW-SESSION');
  });
});

describe('stale-session reauthentication failure', () => {
  it('logs only the unlock reason and returns the distinct reason through the shared vault', async () => {
    const pwFile = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'vault-reauth-')),
      'pw.txt',
    );
    await fs.writeFile(pwFile, 'master-password', 'utf8');
    settingsMock.values = {
      browserVaultAutoUnlock: true,
      browserVaultMasterPasswordFile: pwFile,
    };
    serviceMocks.bwRun
      .mockResolvedValueOnce({ stdout: '', stderr: 'Vault is locked.', code: 1 })
      .mockResolvedValueOnce({
        stdout: '',
        stderr: 'unlock failed with TEST-ONLY-SECRET-BODY',
        code: 1,
      });
    getBrowserCredentialSession().unlock('STALE-TEST-TOKEN');

    const error = await getBrowserCredentialVault()
      .enrolExistingCredential({ item: 'item-1', origin: 'https://portal.example.gov.uk' })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'vault_relock_failed:bw_unlock_failed' });
    expect(serviceMocks.loggerWarn).toHaveBeenCalledWith(
      'Credential vault re-unlock after a stale session failed',
      { reason: 'bw_unlock_failed' },
    );
    expect(JSON.stringify(serviceMocks.loggerWarn.mock.calls)).not.toContain(
      'TEST-ONLY-SECRET-BODY',
    );
    expect(JSON.stringify(serviceMocks.loggerWarn.mock.calls)).not.toContain(
      'STALE-TEST-TOKEN',
    );
    expect((error as Error).message).not.toContain('TEST-ONLY-SECRET-BODY');
    await fs.rm(path.dirname(pwFile), { recursive: true, force: true });
  });
});
