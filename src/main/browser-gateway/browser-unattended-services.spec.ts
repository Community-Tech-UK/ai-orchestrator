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
  lockBrowserCredentialVault,
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

  it('keeps an explicit lock authoritative over an unlock already in flight', async () => {
    settingsMock.values = { browserVaultAutoUnlock: true, browserVaultMasterPasswordFile: pwFile };
    let finishUnlock!: () => void;
    const unlockGate = new Promise<void>((resolve) => {
      finishUnlock = resolve;
    });
    serviceMocks.bwRun.mockImplementationOnce(async () => {
      await unlockGate;
      return { stdout: 'LATE-SESSION\n', stderr: '', code: 0 };
    });

    const unlocking = unlockBrowserCredentialVault();
    await vi.waitFor(() => expect(serviceMocks.bwRun).toHaveBeenCalledOnce());
    lockBrowserCredentialVault();
    finishUnlock();

    await expect(unlocking).resolves.toEqual({ unlocked: false, reason: 'empty_session' });
    expect(getBrowserCredentialSession().locked).toBe(true);
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
  it('does not recover a stale command after an explicit lock while that command is pending', async () => {
    const pwFile = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'vault-pending-command-lock-')),
      'pw.txt',
    );
    await fs.writeFile(pwFile, 'master-password', 'utf8');
    settingsMock.values = {
      browserVaultAutoUnlock: true,
      browserVaultMasterPasswordFile: pwFile,
    };
    _resetBrowserCredentialSessionForTesting();
    getBrowserCredentialSession().unlock('PRE-LOCK-SESSION');

    let releaseStaleCommand!: () => void;
    const staleCommandGate = new Promise<void>((resolve) => {
      releaseStaleCommand = resolve;
    });
    let staleCommandStarted = false;
    let unlockCalls = 0;
    serviceMocks.bwRun.mockImplementation(async (
      args: string[],
      options?: { session?: string },
    ) => {
      if (args[0] === 'list' && options?.session === 'PRE-LOCK-SESSION') {
        staleCommandStarted = true;
        await staleCommandGate;
        return { stdout: '', stderr: 'Vault is locked.', code: 1 };
      }
      if (args[0] === 'unlock') {
        unlockCalls += 1;
        return { stdout: 'POST-LOCK-SESSION\n', stderr: '', code: 0 };
      }
      if (args[0] === 'list' && options?.session === 'POST-LOCK-SESSION') {
        return { stdout: '', stderr: 'Vault is locked.', code: 1 };
      }
      throw new Error(`Unexpected test command: ${args[0] ?? ''}`);
    });

    const operation = getBrowserCredentialVault()
      .enrolExistingCredential({ item: 'item-after-lock', origin: 'https://portal.example.gov.uk' })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(staleCommandStarted).toBe(true));
    lockBrowserCredentialVault();
    releaseStaleCommand();

    const error = await operation;
    expect(error).toMatchObject({ code: 'vault_relock_failed:empty_session' });
    expect(unlockCalls).toBe(0);
    expect(getBrowserCredentialSession().locked).toBe(true);
    await fs.rm(path.dirname(pwFile), { recursive: true, force: true });
  });

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

  it('redacts a thrown unlock failure before logging or returning it', async () => {
    const pwFile = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'vault-thrown-reauth-')),
      'pw.txt',
    );
    await fs.writeFile(pwFile, 'master-password', 'utf8');
    settingsMock.values = {
      browserVaultAutoUnlock: true,
      browserVaultMasterPasswordFile: pwFile,
    };
    serviceMocks.loggerWarn.mockReset();
    serviceMocks.bwRun
      .mockResolvedValueOnce({ stdout: '', stderr: 'Vault is locked.', code: 1 })
      .mockRejectedValueOnce(new Error('UNREDACTED-THROWN-UNLOCK-DETAIL'));
    _resetBrowserCredentialSessionForTesting();
    getBrowserCredentialSession().unlock('THROWN-RECOVERY-SESSION');

    const error = await getBrowserCredentialVault()
      .enrolExistingCredential({ item: 'item-1', origin: 'https://portal.example.gov.uk' })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'vault_relock_failed:bw_unlock_failed' });
    expect(serviceMocks.loggerWarn).toHaveBeenCalledWith(
      'Credential vault re-unlock after a stale session failed',
      { reason: 'bw_unlock_failed' },
    );
    expect(JSON.stringify(serviceMocks.loggerWarn.mock.calls)).not.toContain(
      'UNREDACTED-THROWN-UNLOCK-DETAIL',
    );
    expect((error as Error).message).not.toContain('UNREDACTED-THROWN-UNLOCK-DETAIL');
    await fs.rm(path.dirname(pwFile), { recursive: true, force: true });
  });

  it('shares a completed failed recovery with a delayed stale caller', async () => {
    const pwFile = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'vault-concurrent-failure-')),
      'pw.txt',
    );
    await fs.writeFile(pwFile, 'master-password', 'utf8');
    settingsMock.values = {
      browserVaultAutoUnlock: true,
      browserVaultMasterPasswordFile: pwFile,
    };
    _resetBrowserCredentialSessionForTesting();
    getBrowserCredentialSession().unlock('FAILED-RECOVERY-SESSION');

    let releaseSecondStale!: () => void;
    const secondStaleGate = new Promise<void>((resolve) => {
      releaseSecondStale = resolve;
    });
    let oldListCalls = 0;
    let unlockCalls = 0;
    serviceMocks.bwRun.mockImplementation(async (
      args: string[],
      options?: { session?: string },
    ) => {
      if (args[0] === 'unlock') {
        unlockCalls += 1;
        return { stdout: '', stderr: 'TEST-ONLY-UNLOCK-FAILURE', code: 1 };
      }
      if (args[0] === 'list' && options?.session === 'FAILED-RECOVERY-SESSION') {
        oldListCalls += 1;
        if (oldListCalls === 2) {
          await secondStaleGate;
        }
        return { stdout: '', stderr: 'Vault is locked.', code: 1 };
      }
      throw new Error(`Unexpected test command: ${args[0] ?? ''}`);
    });

    const first = getBrowserCredentialVault().enrolExistingCredential({
      item: 'item-1',
      origin: 'https://portal.example.gov.uk',
    }).catch((error: unknown) => error);
    const second = getBrowserCredentialVault().enrolExistingCredential({
      item: 'item-2',
      origin: 'https://portal.example.gov.uk',
    }).catch((error: unknown) => error);

    await vi.waitFor(() => expect(oldListCalls).toBe(2));
    const firstError = await first;
    expect(firstError).toMatchObject({ code: 'vault_relock_failed:bw_unlock_failed' });
    expect(unlockCalls).toBe(1);

    releaseSecondStale();
    const secondError = await second;
    expect(secondError).toMatchObject({ code: 'vault_relock_failed:bw_unlock_failed' });
    expect(unlockCalls).toBe(1);
    await fs.rm(path.dirname(pwFile), { recursive: true, force: true });
  });

  it('reuses one recovered session when a second stale response arrives late', async () => {
    const pwFile = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'vault-concurrent-')),
      'pw.txt',
    );
    await fs.writeFile(pwFile, 'master-password', 'utf8');
    settingsMock.values = {
      browserVaultAutoUnlock: true,
      browserVaultMasterPasswordFile: pwFile,
    };
    _resetBrowserCredentialSessionForTesting();
    getBrowserCredentialSession().unlock('OLD-SESSION');

    let releaseSecondStale!: () => void;
    const secondStaleGate = new Promise<void>((resolve) => {
      releaseSecondStale = resolve;
    });
    let releaseFirstSessionRetries!: () => void;
    const firstSessionRetryGate = new Promise<void>((resolve) => {
      releaseFirstSessionRetries = resolve;
    });
    let oldListCalls = 0;
    let firstSessionListCalls = 0;
    let unlockCalls = 0;
    const stale = { stdout: '', stderr: 'Vault is locked.', code: 1 };
    const folders = {
      stdout: JSON.stringify([{ id: 'folder-1', name: 'AIO-Agent' }]),
      stderr: '',
      code: 0,
    };

    serviceMocks.bwRun.mockImplementation(async (
      args: string[],
      options?: { session?: string },
    ) => {
      if (args[0] === 'unlock') {
        unlockCalls += 1;
        return { stdout: `SESSION-${unlockCalls}\n`, stderr: '', code: 0 };
      }
      if (args[0] === 'list' && options?.session === 'OLD-SESSION') {
        oldListCalls += 1;
        if (oldListCalls === 2) {
          await secondStaleGate;
        }
        return stale;
      }
      if (args[0] === 'list' && options?.session === 'SESSION-1') {
        firstSessionListCalls += 1;
        await firstSessionRetryGate;
        return getBrowserCredentialSession().getToken() === 'SESSION-1' ? folders : stale;
      }
      if (args[0] === 'list' && options?.session === 'SESSION-2') {
        return folders;
      }
      if (args[0] === 'get') {
        return {
          stdout: JSON.stringify({
            id: args[2],
            folderId: 'folder-1',
            login: { username: 'u', password: 'TEST-ONLY-PASSWORD' },
          }),
          stderr: '',
          code: 0,
        };
      }
      throw new Error(`Unexpected test command: ${args[0] ?? ''}`);
    });

    const first = getBrowserCredentialVault().enrolExistingCredential({
      item: 'item-1',
      origin: 'https://portal.example.gov.uk',
    });
    const second = getBrowserCredentialVault().enrolExistingCredential({
      item: 'item-2',
      origin: 'https://portal.example.gov.uk',
    });

    await vi.waitFor(() => {
      expect(oldListCalls).toBe(2);
      expect(unlockCalls).toBe(1);
      expect(firstSessionListCalls).toBe(1);
    });
    releaseSecondStale();
    await vi.waitFor(() => {
      expect(unlockCalls === 2 || firstSessionListCalls === 2).toBe(true);
    });
    releaseFirstSessionRetries();

    const results = await Promise.allSettled([first, second]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(unlockCalls).toBe(1);
    expect(getBrowserCredentialSession().getToken()).toBe('SESSION-1');
    await fs.rm(path.dirname(pwFile), { recursive: true, force: true });
  });
});
