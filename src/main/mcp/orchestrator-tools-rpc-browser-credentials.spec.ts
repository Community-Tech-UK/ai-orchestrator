/**
 * Main-process dispatch for the `browser-credentials` CLI. This is the second
 * door onto credential enrolment and authorization (the renderer IPC handler is
 * the first), added 2026-08-29 on the operator's instruction. The tests below
 * exist so that door cannot accept something the panel would refuse.
 */
import { describe, expect, it, vi } from 'vitest';

// The RPC server calls the two-argument form, so the lazy default-operations
// import is the path production actually takes. Every other case here injects,
// which left that path untested.
const defaultOperations = {
  enrol: vi.fn().mockResolvedValue({ vaultItemRef: 'd', username: 'd', movedIntoFolder: false, origin: 'https://d.example.com' }),
  authorize: vi.fn(),
  list: vi.fn().mockResolvedValue([]),
  revoke: vi.fn(),
};
vi.mock('../browser-gateway/default-browser-credentials-operations', () => ({
  createDefaultBrowserCredentialsOperations: () => defaultOperations,
}));
import {
  BROWSER_CREDENTIALS_CLI_METHODS,
} from './browser-credentials-cli-contracts';
import {
  dispatchBrowserCredentialsCliRpc,
  isBrowserCredentialsCliRpcMethod,
  type BrowserCredentialsCliOperations,
} from './orchestrator-tools-rpc-browser-credentials';

const AUTHORIZATION = {
  id: 'auth-1',
  profileId: 'default',
  allowedOrigins: [
    { scheme: 'https' as const, hostPattern: 'procontract.due-north.com', includeSubdomains: false },
  ],
  purposes: ['login' as const],
  vaultFolder: 'AIO-Agent',
  createdAt: 1,
  expiresAt: 2,
};

function operations(): BrowserCredentialsCliOperations & {
  enrol: ReturnType<typeof vi.fn>;
  authorize: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  revoke: ReturnType<typeof vi.fn>;
} {
  return {
    enrol: vi.fn().mockResolvedValue({ vaultItemRef: 'i', username: 'u', movedIntoFolder: false, origin: 'https://a.example.com' }),
    authorize: vi.fn().mockResolvedValue(AUTHORIZATION),
    list: vi.fn().mockResolvedValue([AUTHORIZATION]),
    revoke: vi.fn().mockResolvedValue({ revoked: true }),
  } as never;
}

describe('isBrowserCredentialsCliRpcMethod', () => {
  it('recognises its own methods and nothing else', () => {
    for (const method of Object.values(BROWSER_CREDENTIALS_CLI_METHODS)) {
      expect(isBrowserCredentialsCliRpcMethod(method)).toBe(true);
    }
    expect(isBrowserCredentialsCliRpcMethod('orchestrator_tools.local_ai.enrol')).toBe(false);
    expect(isBrowserCredentialsCliRpcMethod('orchestrator_tools.browser_credentials')).toBe(false);
  });
});

describe('dispatchBrowserCredentialsCliRpc', () => {
  it('refuses when operations are unavailable', async () => {
    await expect(dispatchBrowserCredentialsCliRpc(
      BROWSER_CREDENTIALS_CLI_METHODS.list,
      {},
      null,
    )).rejects.toThrow(/unavailable/);
  });

  it('passes a valid enrol payload through', async () => {
    const ops = operations();
    const result = await dispatchBrowserCredentialsCliRpc(
      BROWSER_CREDENTIALS_CLI_METHODS.enrol,
      { item: 'ProContract', origin: 'https://procontract.due-north.com' },
      ops,
    );
    expect(ops.enrol).toHaveBeenCalledWith({
      item: 'ProContract',
      origin: 'https://procontract.due-north.com',
    });
    expect(result).toEqual({ vaultItemRef: 'i', username: 'u', movedIntoFolder: false, origin: 'https://a.example.com' });
  });

  it('rejects an enrol payload the panel would refuse', async () => {
    const ops = operations();
    // Not a URL.
    await expect(dispatchBrowserCredentialsCliRpc(
      BROWSER_CREDENTIALS_CLI_METHODS.enrol,
      { item: 'x', origin: 'procontract.due-north.com' },
      ops,
    )).rejects.toThrow();
    // Unknown field: the shared schema is strict.
    await expect(dispatchBrowserCredentialsCliRpc(
      BROWSER_CREDENTIALS_CLI_METHODS.enrol,
      { item: 'x', origin: 'https://a.example.com', password: 'hunter2' },
      ops,
    )).rejects.toThrow();
    expect(ops.enrol).not.toHaveBeenCalled();
  });

  it('rejects an authorize payload with no origin or no purpose', async () => {
    const ops = operations();
    const base = {
      profileId: 'default',
      vaultFolder: 'AIO-Agent',
      expiresAt: Date.now() + 1000,
    };
    await expect(dispatchBrowserCredentialsCliRpc(
      BROWSER_CREDENTIALS_CLI_METHODS.authorize,
      { ...base, allowedOrigins: [], purposes: ['login'] },
      ops,
    )).rejects.toThrow();
    await expect(dispatchBrowserCredentialsCliRpc(
      BROWSER_CREDENTIALS_CLI_METHODS.authorize,
      { ...base, allowedOrigins: AUTHORIZATION.allowedOrigins, purposes: [] },
      ops,
    )).rejects.toThrow();
    expect(ops.authorize).not.toHaveBeenCalled();
  });

  it('refuses secret_fill as a creatable purpose but reads a stored one back', async () => {
    const ops = operations();
    await expect(dispatchBrowserCredentialsCliRpc(
      BROWSER_CREDENTIALS_CLI_METHODS.authorize,
      {
        profileId: 'default',
        allowedOrigins: AUTHORIZATION.allowedOrigins,
        purposes: ['secret_fill'],
        vaultFolder: 'AIO-Agent',
        expiresAt: Date.now() + 1000,
      },
      ops,
    )).rejects.toThrow();

    // A record minted through another surface may carry it; a read must not throw.
    const reader = operations();
    reader.list = vi.fn().mockResolvedValue([{ ...AUTHORIZATION, purposes: ['secret_fill'] }]);
    await expect(dispatchBrowserCredentialsCliRpc(
      BROWSER_CREDENTIALS_CLI_METHODS.list,
      {},
      reader,
    )).resolves.toEqual([{ ...AUTHORIZATION, purposes: ['secret_fill'] }]);
  });

  it('treats an absent list payload as all profiles', async () => {
    const ops = operations();
    await dispatchBrowserCredentialsCliRpc(BROWSER_CREDENTIALS_CLI_METHODS.list, {}, ops);
    expect(ops.list).toHaveBeenCalledWith(undefined);
  });

  it('revokes by id', async () => {
    const ops = operations();
    await dispatchBrowserCredentialsCliRpc(
      BROWSER_CREDENTIALS_CLI_METHODS.revoke,
      { authorizationId: 'auth-1' },
      ops,
    );
    expect(ops.revoke).toHaveBeenCalledWith('auth-1');
  });
});

describe('default operations wiring', () => {
  it('constructs the live operations when none are injected', async () => {
    const result = await dispatchBrowserCredentialsCliRpc(
      BROWSER_CREDENTIALS_CLI_METHODS.list,
      {},
    );

    expect(defaultOperations.list).toHaveBeenCalledWith(undefined);
    expect(result).toEqual([]);
  });

  it('still honours an explicit null as "unavailable"', async () => {
    await expect(dispatchBrowserCredentialsCliRpc(
      BROWSER_CREDENTIALS_CLI_METHODS.list,
      {},
      null,
    )).rejects.toThrow(/unavailable/);
  });
});
