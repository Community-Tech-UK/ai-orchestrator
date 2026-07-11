import { describe, expect, it, vi } from 'vitest';
import type { BrowserGatewayResult } from '@contracts/types/browser';
import { fillSecretOperation } from './browser-secret-fill-operation';
import type { FillOperationDeps } from './browser-form-fill-operations';
import type { BrowserGatewayFillSecretRequest } from './browser-gateway-service-types';
import {
  CredentialAuthorizationService,
  InMemoryCredentialAuthorizationStore,
  type CredentialAuthorization,
} from './browser-credential-authorization-store';
import type { SecretFieldKind } from './browser-credential-vault';

const ORIGIN = 'https://portal.example.gov.uk';
const SECRET = 'GB33BUKB20201555555555';

interface HarnessOpts {
  authorization?: Partial<CredentialAuthorization> | null;
  existingTab?: boolean;
  sharedTabAllowed?: boolean;
  originSequence?: string[]; // successive refreshTargetOrigin results
  readbackOverride?: string | undefined; // force a wrong/absent read-back
  vaultValue?: string;
}

function makeHarness(opts: HarnessOpts = {}) {
  const store = new InMemoryCredentialAuthorizationStore();
  const authorizations = new CredentialAuthorizationService(store, () => 1_000);
  if (opts.authorization !== null) {
    authorizations.create(
      {
        profileId: 'p1',
        allowedOrigins: [{ scheme: 'https', hostPattern: 'portal.example.gov.uk', includeSubdomains: false }],
        purposes: ['secret_fill'],
        allowedSecretTypes: ['iban', 'bank_account_number'] as SecretFieldKind[],
        vaultFolder: 'AIO-Agent',
        expiresAt: 9_999_999_999_999,
        ...opts.authorization,
      },
      'auth-1',
    );
  }

  // Fake DOM: driverType records the typed value per selector; readControl reads
  // it straight back — a faithful round-trip so verification is exercised for real.
  const dom = new Map<string, string>();
  const typed: Array<{ selector: string; value: string }> = [];
  const driverType = vi.fn(async (_p: string, _t: string, selector: string, value: string) => {
    dom.set(selector, value);
    typed.push({ selector, value });
  });
  const readControl = vi.fn(async (_p: string, _t: string, selector: string) => ({
    value: opts.readbackOverride !== undefined ? opts.readbackOverride : dom.get(selector),
  }));

  const origins = opts.originSequence ?? [ORIGIN, ORIGIN];
  let originCall = 0;
  const refreshTargetOrigin = vi.fn(async () => origins[Math.min(originCall++, origins.length - 1)] ?? '');

  const result = vi.fn(<T>(input: unknown) => input as BrowserGatewayResult<T>);

  const deps: FillOperationDeps = {
    result: result as FillOperationDeps['result'],
    hasExistingTab: () => Boolean(opts.existingTab),
    sharedTabCredentialFillAllowed: () => Boolean(opts.sharedTabAllowed),
    resolveCredentialProfileScope: (profileId) => profileId,
    type: vi.fn(),
    select: vi.fn(),
    click: vi.fn(),
    readControl,
    driverType,
    refreshTargetOrigin,
    credentialVault: {
      getGenericSecretForFill: vi.fn(async () => opts.vaultValue ?? SECRET),
      getSecretForFill: vi.fn(),
      createAgentCredential: vi.fn(),
    } as unknown as FillOperationDeps['credentialVault'],
    credentialAuthorizations: authorizations,
  };

  return { deps, driverType, typed, result };
}

const REQUEST: BrowserGatewayFillSecretRequest = {
  instanceId: 'i1',
  provider: 'orchestrator',
  profileId: 'p1',
  targetId: 't1',
  vaultItemRef: 'supplier-1',
  fields: [{ selector: '#iban', secretType: 'iban' }],
};

describe('fillSecretOperation', () => {
  it('fills + verifies an authorized bank secret and returns counts only (no value leaks)', async () => {
    const { deps, driverType } = makeHarness();
    const result = await fillSecretOperation(deps, REQUEST);

    expect(result.decision).toBe('allowed');
    expect(result.outcome).toBe('succeeded');
    expect(result.actionClass).toBe('financial_identity');
    expect(result.data).toEqual({ filled: 1, verified: 1 });

    // The secret WAS typed into the page...
    expect(driverType).toHaveBeenCalledWith('p1', 't1', '#iban', SECRET);
    // ...but appears NOWHERE in the model-visible result (data, summary, reason).
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.summary).not.toContain(SECRET);
  });

  it('denies when there is no secret_fill authorization', async () => {
    const { deps, driverType } = makeHarness({ authorization: null });
    const result = await fillSecretOperation(deps, REQUEST);

    expect(result.decision).toBe('denied');
    expect(result.reason).toContain('secret_not_authorized');
    expect(driverType).not.toHaveBeenCalled();
  });

  it('denies when the semantic secret type is not on the authorization', async () => {
    const { deps, driverType } = makeHarness({
      authorization: { allowedSecretTypes: ['bank_account_number'] as SecretFieldKind[] },
    });
    const result = await fillSecretOperation(deps, REQUEST);

    expect(result.decision).toBe('denied');
    expect(result.reason).toContain('secret_type_not_authorized');
    expect(driverType).not.toHaveBeenCalled();
  });

  it('enforces a selector allowlist on the authorization', async () => {
    const { deps } = makeHarness({ authorization: { allowedSelectors: ['#other'] } });
    const result = await fillSecretOperation(deps, REQUEST);

    expect(result.decision).toBe('denied');
    expect(result.reason).toContain('selector_not_authorized');
  });

  it('reports verification failure (still no value) when the read-back does not match', async () => {
    const { deps } = makeHarness({ readbackOverride: 'WRONG-VALUE' });
    const result = await fillSecretOperation(deps, REQUEST);

    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('secret_verification_failed');
    expect(result.data).toEqual({ filled: 1, verified: 0 });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('requires the shared-tab opt-in for an existing tab', async () => {
    const { deps, driverType } = makeHarness({ existingTab: true, sharedTabAllowed: false });
    const result = await fillSecretOperation(deps, REQUEST);

    expect(result.decision).toBe('denied');
    expect(result.reason).toBe('fill_secret_managed_profile_only');
    expect(driverType).not.toHaveBeenCalled();
  });

  it('aborts (TOCTOU) if a shared tab navigates away between authorization and fill', async () => {
    const { deps, driverType } = makeHarness({
      existingTab: true,
      sharedTabAllowed: true,
      // 1st call authorizes ORIGIN; 2nd (pre-type re-check) sees a different origin.
      originSequence: [ORIGIN, 'https://evil.example'],
    });
    const result = await fillSecretOperation(deps, REQUEST);

    expect(result.decision).toBe('denied');
    expect(result.reason).toBe('origin_changed_during_fill');
    expect(driverType).not.toHaveBeenCalled();
  });

  it('denies when the live origin cannot be resolved', async () => {
    const { deps } = makeHarness({ originSequence: [''] });
    const result = await fillSecretOperation(deps, REQUEST);

    expect(result.decision).toBe('denied');
    expect(result.reason).toBe('origin_unknown');
  });
});
