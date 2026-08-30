import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronIpcService } from './electron-ipc.service';
import { CopilotAccountIpcService } from './copilot-account-ipc.service';

/**
 * Service-level cover for the read path.
 *
 * The component spec mocks THIS service, so it can only prove the component
 * handles a rejection — it cannot prove the service produces one. That gap is
 * how a failed read went on being reported as an empty list: every test in play
 * was satisfied either way.
 */
const api = {
  listCopilotAccounts: vi.fn(),
  listCopilotAccountRules: vi.fn(),
};

function service(): CopilotAccountIpcService {
  TestBed.configureTestingModule({
    providers: [
      CopilotAccountIpcService,
      { provide: ElectronIpcService, useValue: { getApi: () => api } },
    ],
  });
  return TestBed.inject(CopilotAccountIpcService);
}

beforeEach(() => {
  TestBed.resetTestingModule();
  api.listCopilotAccounts.mockReset();
  api.listCopilotAccountRules.mockReset();
});

describe('CopilotAccountIpcService read path', () => {
  it('rejects when the accounts response failed, rather than reporting none', async () => {
    api.listCopilotAccounts.mockResolvedValue({
      success: false,
      error: { message: 'Internal error: the response contained data that must not cross IPC.' },
    });
    await expect(service().list()).rejects.toThrow(/must not cross IPC/);
  });

  it('rejects when the rules response failed', async () => {
    api.listCopilotAccountRules.mockResolvedValue({
      success: false,
      error: { message: 'nope' },
    });
    await expect(service().listRules()).rejects.toThrow(/nope/);
  });

  it('returns an empty list when the read genuinely succeeded with none', async () => {
    // The distinction that matters: empty is a real answer, failure is not.
    api.listCopilotAccounts.mockResolvedValue({ success: true, data: { profiles: [] } });
    await expect(service().list()).resolves.toEqual([]);
  });
});
