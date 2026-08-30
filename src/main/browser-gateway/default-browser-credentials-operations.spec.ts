/**
 * The CLI parses origins in its own process for a fast, clear error, but the
 * CLI binary is not the only thing that can reach the RPC socket, so the
 * authoritative expiry cap, scope resolution and origin normalisation all live
 * here. Deleting any one of them would otherwise leave the whole suite green.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const enrolExistingCredential = vi.fn();
const create = vi.fn();
const list = vi.fn();
const revoke = vi.fn();
const listProfiles = vi.fn();
const find = vi.fn();
const listNodes = vi.fn();

vi.mock('./browser-unattended-services', () => ({
  getBrowserCredentialVault: () => ({ enrolExistingCredential }),
  getBrowserCredentialAuthorizationService: () => ({ create, list, revoke, find }),
}));
vi.mock('./browser-profile-store', () => ({
  getBrowserProfileStore: () => ({ listProfiles }),
}));
vi.mock('../remote-node/remote-node-roster-service', () => ({
  getRemoteNodeRosterService: () => ({ list: listNodes }),
}));

const {
  resolveCredentialScope,
  resolveCredentialScopeForFilter,
  createDefaultBrowserCredentialsOperations,
} = await import(
  './default-browser-credentials-operations'
);

const NODE_ID = 'bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be';

const ORIGIN = {
  scheme: 'https' as const,
  hostPattern: 'procontract.due-north.com',
  includeSubdomains: false,
};

function authorizeInput(overrides: Record<string, unknown> = {}) {
  return {
    profileId: NODE_ID,
    allowedOrigins: [ORIGIN],
    purposes: ['login' as const],
    vaultFolder: 'AIO-Agent',
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // A REAL roster row. The id is a UUID and the friendly name is separate:
  // an earlier fixture used `{ id: 'windows-pc' }`, which does not exist in
  // production, so the suite went green on a node-id shape that could never
  // occur and hid the fact that the documented command was refused.
  listNodes.mockReturnValue([{ id: NODE_ID, name: 'windows-pc' }]);
  listProfiles.mockReturnValue([{ id: 'aio-procurement' }]);
  create.mockImplementation((input: unknown, id: string) => ({ ...(input as object), id }));
  enrolExistingCredential.mockResolvedValue({
    vaultItemRef: 'item-1',
    username: 'u',
    movedIntoFolder: false,
  });
  list.mockReturnValue([]);
});

describe('resolveCredentialScope', () => {
  it('accepts local, a node id, and a managed profile id', () => {
    expect(resolveCredentialScope('local')).toBe('local');
    expect(resolveCredentialScope(NODE_ID)).toBe(NODE_ID);
    expect(resolveCredentialScope('aio-procurement')).toBe('aio-procurement');
  });

  it('resolves a friendly node NAME to the node id used at fill time', () => {
    // Every other surface (browser_list_targets, run_on_node) takes the name, so
    // an agent will type the name by habit. The stored scope must still be the
    // id, because that is what `credentialAuthorizationProfileScope` computes
    // from a real `existing-tab:n.<id>:...` profileId.
    expect(resolveCredentialScope('windows-pc')).toBe(NODE_ID);
  });

  it('refuses an ambiguous node name rather than guessing a machine', () => {
    // Names are not unique. Binding to whichever sorted first would be silent
    // and would last as long as the grant does.
    listNodes.mockReturnValue([
      { id: NODE_ID, name: 'windows-pc' },
      { id: '11111111-2222-3333-4444-555555555555', name: 'windows-pc' },
    ]);
    expect(() => resolveCredentialScope('windows-pc')).toThrow(/ambiguous/);
    expect(() => resolveCredentialScope('windows-pc')).toThrow(new RegExp(NODE_ID));
    // The id remains unambiguous and still resolves.
    expect(resolveCredentialScope(NODE_ID)).toBe(NODE_ID);
  });

  it('refuses an unknown scope, naming both the name and the id', () => {
    // The silent failure this prevents: a grant on a plausible-looking scope is
    // created, reports success, and can never match at fill time.
    expect(() => resolveCredentialScope('default'))
      .toThrow(/Unknown credential scope 'default'.*can never match/s);
    expect(() => resolveCredentialScope('default'))
      .toThrow(new RegExp(`windows-pc.*${NODE_ID}`, 's'));
  });
});

describe('createDefaultBrowserCredentialsOperations.authorize', () => {
  it('creates a grant for a valid input', async () => {
    const ops = createDefaultBrowserCredentialsOperations();
    await ops.authorize(authorizeInput());
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toMatchObject({ profileId: NODE_ID });
  });

  it('enforces the one-year cap on this door, not only in the CLI', async () => {
    const ops = createDefaultBrowserCredentialsOperations();
    const year = 365 * 24 * 60 * 60 * 1000;
    await expect(ops.authorize(authorizeInput({ expiresAt: Date.now() + year + 60_000 })))
      .rejects.toThrow(/more than 1 year/);
    await expect(ops.authorize(authorizeInput({ expiresAt: Date.now() - 1 })))
      .rejects.toThrow(/must be in the future/);
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses an unknown scope before creating anything', async () => {
    const ops = createDefaultBrowserCredentialsOperations();
    await expect(ops.authorize(authorizeInput({ profileId: 'nope' })))
      .rejects.toThrow(/Unknown credential scope/);
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a registry-wide wildcard arriving straight over RPC', async () => {
    // This payload never passes through the CLI parser, so if the guard were
    // client-side only it would land.
    const ops = createDefaultBrowserCredentialsOperations();
    await expect(ops.authorize(authorizeInput({
      allowedOrigins: [{ scheme: 'https', hostPattern: 'com', includeSubdomains: true }],
    }))).rejects.toThrow(/public suffix/);
    expect(create).not.toHaveBeenCalled();
  });

  it('stores a node NAME as the node id', async () => {
    const ops = createDefaultBrowserCredentialsOperations();
    await ops.authorize(authorizeInput({ profileId: 'windows-pc' }));
    expect(create.mock.calls[0]![0]).toMatchObject({ profileId: NODE_ID });
  });

  it('normalises a recoverable host rather than refusing it', async () => {
    const ops = createDefaultBrowserCredentialsOperations();
    await ops.authorize(authorizeInput({
      allowedOrigins: [{ scheme: 'https', hostPattern: 'ProContract.Due-North.com', includeSubdomains: false }],
    }));
    expect(create.mock.calls[0]![0]).toMatchObject({
      allowedOrigins: [{
        scheme: 'https',
        hostPattern: 'procontract.due-north.com',
        includeSubdomains: false,
      }],
    });
  });

  it('hoists a wildcard typed into the host field instead of narrowing the grant', async () => {
    const ops = createDefaultBrowserCredentialsOperations();
    await ops.authorize(authorizeInput({
      allowedOrigins: [{ scheme: 'https', hostPattern: '*.due-north.com', includeSubdomains: false }],
    }));
    expect(create.mock.calls[0]![0]).toMatchObject({
      allowedOrigins: [{ hostPattern: 'due-north.com', includeSubdomains: true }],
    });
  });
});

describe('createDefaultBrowserCredentialsOperations.enrol', () => {
  it('normalises the origin before binding', async () => {
    const ops = createDefaultBrowserCredentialsOperations();
    await ops.enrol({ item: 'ProContract', origin: 'https://ProContract.Due-North.com/' });
    expect(enrolExistingCredential).toHaveBeenCalledWith({
      item: 'ProContract',
      origin: 'https://procontract.due-north.com',
    });
    // The result carries the origin as STORED, so the CLI cannot echo back a
    // string that differs from the binding.
    await expect(ops.enrol({ item: 'ProContract', origin: 'https://ProContract.Due-North.com/' }))
      .resolves.toMatchObject({ origin: 'https://procontract.due-north.com' });
  });

  it('refuses an origin that would bind something unmatchable', async () => {
    const ops = createDefaultBrowserCredentialsOperations();
    await expect(ops.enrol({ item: 'x', origin: 'https://portal.gov.uk..' }))
      .rejects.toThrow(/empty label/);
    expect(enrolExistingCredential).not.toHaveBeenCalled();
  });

  it('accepts a pasted address-bar URL and stores the origin', async () => {
    const ops = createDefaultBrowserCredentialsOperations();
    await ops.enrol({ item: 'x', origin: 'https://portal.example.gov.uk/login' });
    expect(enrolExistingCredential.mock.calls[0]![0]).toMatchObject({
      origin: 'https://portal.example.gov.uk',
    });
  });

  it('keeps a non-default port, which does authorize', async () => {
    // Corrected: an earlier version of this suite asserted ports were refused,
    // on a premise that turned out to be false. `originMatches` compares against
    // `new URL(pageUrl).host`, which includes a non-default port, and the vault
    // binding keeps it too, so both sides agree.
    const ops = createDefaultBrowserCredentialsOperations();
    await ops.enrol({ item: 'x', origin: 'https://portal.example.gov.uk:8443' });
    expect(enrolExistingCredential.mock.calls[0]![0]).toMatchObject({
      origin: 'https://portal.example.gov.uk:8443',
    });
  });

  it('passes moveIntoFolder through only when given', async () => {
    const ops = createDefaultBrowserCredentialsOperations();
    await ops.enrol({ item: 'x', origin: 'https://a.example.com', moveIntoFolder: true });
    expect(enrolExistingCredential.mock.calls[0]![0]).toMatchObject({ moveIntoFolder: true });
  });
});

describe('resolveCredentialScopeForFilter', () => {
  // The read-path counterpart. `authorize --node windows-pc` stores the UUID, so
  // filtering by the same friendly name found nothing at all until this existed.
  it('resolves a name the same way the write path does', () => {
    expect(resolveCredentialScopeForFilter('windows-pc')).toBe(NODE_ID);
    expect(resolveCredentialScopeForFilter(NODE_ID)).toBe(NODE_ID);
    expect(resolveCredentialScopeForFilter('local')).toBe('local');
  });

  it('passes an unknown filter through instead of throwing', () => {
    // An unmatched filter is a legal empty result, not an error.
    expect(resolveCredentialScopeForFilter('never-existed')).toBe('never-existed');
  });
});

describe('createDefaultBrowserCredentialsOperations list and revoke', () => {
  it('filters a list by the resolved scope', async () => {
    const ops = createDefaultBrowserCredentialsOperations();
    list.mockReturnValue([]);
    await ops.list('windows-pc');
    expect(list).toHaveBeenCalledWith(NODE_ID);
  });

  it('lists every scope when no filter is given', async () => {
    const ops = createDefaultBrowserCredentialsOperations();
    list.mockReturnValue([]);
    await ops.list();
    expect(list).toHaveBeenCalledWith(undefined);
  });

  it('revokes a live id and reports it', async () => {
    const ops = createDefaultBrowserCredentialsOperations();
    find.mockReturnValue({ id: 'auth-1' });
    await expect(ops.revoke('auth-1')).resolves.toEqual({ revoked: true });
    expect(revoke).toHaveBeenCalledWith('auth-1');
  });

  it('reports false for an id that never existed, rather than a false success', async () => {
    // markRevoked is an UPDATE ... WHERE id = ?, a silent no-op on a typo, so
    // the old unconditional `{revoked: true}` told an unattended operator a live
    // grant was gone.
    const ops = createDefaultBrowserCredentialsOperations();
    find.mockReturnValue(undefined);
    await expect(ops.revoke('typo')).resolves.toEqual({ revoked: false });
    expect(revoke).not.toHaveBeenCalled();
  });

  it('stays idempotent when the id is already revoked', async () => {
    // A cleanup script re-running must not fail: the desired state holds.
    const ops = createDefaultBrowserCredentialsOperations();
    find.mockReturnValue({ id: 'auth-1', revokedAt: 123 });
    await expect(ops.revoke('auth-1')).resolves.toEqual({ revoked: true });
    expect(revoke).not.toHaveBeenCalled();
  });
});
