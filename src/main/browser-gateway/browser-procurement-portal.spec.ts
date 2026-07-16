// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { BrowserElementContext, BrowserGatewayResult } from '@contracts/types/browser';
import {
  MOCK_PROCUREMENT_PORTAL_HTML,
  MOCK_PROCUREMENT_PORTAL_ORIGIN as ORIGIN,
} from './mock-procurement-portal.fixture';
import { classifyBrowserAction, classifyBrowserFillForm } from './browser-action-classifier';
import { actionClassNeverGrantable } from './browser-grant-policy';
import { fillSecretOperation } from './browser-secret-fill-operation';
import type { FillOperationDeps } from './browser-form-fill-operations';
import type { BrowserGatewayFillSecretRequest } from './browser-gateway-service-types';
import {
  CredentialAuthorizationService,
  InMemoryCredentialAuthorizationStore,
} from './browser-credential-authorization-store';
import {
  CredentialVault,
  type BwCommandResult,
  type BwRunner,
  type SecretFieldKind,
  type VaultOriginBinding,
  type VaultOriginBindingStore,
} from './browser-credential-vault';

/**
 * DOM-level end-to-end: the REAL classifier, secret broker, vault (folder +
 * origin jailed) and authorization service driven against the REAL parsed DOM of
 * the mock procurement portal. Proves the whole secure flow deterministically
 * without an external browser. (A live chromium/gateway run against a shared
 * logged-in tab still requires the packaged app — see the design doc §7.)
 */

// The bank secrets the vault holds (custom fields on one origin-bound item).
const BANK_SECRETS: Record<string, string> = {
  'Account Number': '12345678',
  'Sort Code': '01-02-03',
  IBAN: 'GB33BUKB20201555555555',
  BIC: 'BUKBGB22XXX',
};

function loadPortal(): void {
  document.body.innerHTML = MOCK_PROCUREMENT_PORTAL_HTML;
}

function el(selector: string): HTMLInputElement | HTMLButtonElement {
  const node = document.querySelector(selector);
  if (!node) {
    throw new Error(`missing element ${selector}`);
  }
  return node as HTMLInputElement | HTMLButtonElement;
}

/** Build a classifier context from a real DOM element (label + nearby section). */
function contextFor(selector: string): BrowserElementContext {
  const node = el(selector);
  const label = node.id
    ? document.querySelector(`label[for="${node.id}"]`)?.textContent?.replace(/\s+/g, ' ').trim()
    : undefined;
  const section = node.closest('section');
  const isButton = node.tagName === 'BUTTON';
  return {
    ...(isButton ? { role: 'button' } : {}),
    ...(isButton
      ? { accessibleName: node.textContent?.trim() ?? '' }
      : label
        ? { label, accessibleName: label }
        : {}),
    ...(node.getAttribute('type') ? { inputType: node.getAttribute('type') as string } : {}),
    ...(node.getAttribute('name') ? { inputName: node.getAttribute('name') as string } : {}),
    ...(section ? { nearbyText: section.textContent?.replace(/\s+/g, ' ').trim() ?? '' } : {}),
  };
}

class MemoryBindings implements VaultOriginBindingStore {
  private readonly map = new Map<string, VaultOriginBinding>();
  put(binding: VaultOriginBinding): void {
    this.map.set(binding.vaultItemRef, binding);
  }
  get(ref: string): VaultOriginBinding | undefined {
    return this.map.get(ref);
  }
}

function makeVault(): CredentialVault {
  const ok = (stdout: string): BwCommandResult => ({ stdout, stderr: '', code: 0 });
  const runner: BwRunner = {
    run: async (args) => {
      if (args[0] === 'list' && args[1] === 'folders') {
        return ok(JSON.stringify([{ id: 'f-agent', name: 'AIO-Agent' }]));
      }
      if (args[0] === 'get' && args[1] === 'item') {
        return ok(
          JSON.stringify({
            id: args[2],
            folderId: 'f-agent',
            login: {},
            fields: Object.entries(BANK_SECRETS).map(([name, value]) => ({ name, value, type: 0 })),
          }),
        );
      }
      return { stdout: '', stderr: 'unhandled', code: 1 };
    },
  };
  const bindings = new MemoryBindings();
  bindings.put({ vaultItemRef: 'supplier-1', origin: ORIGIN, username: 'supplier', createdAt: 1 });
  return new CredentialVault({ runner, bindings, getSession: () => 'session' });
}

function makeDomDeps(vault: CredentialVault): FillOperationDeps {
  const authorizations = new CredentialAuthorizationService(new InMemoryCredentialAuthorizationStore());
  authorizations.create(
    {
      profileId: 'p1',
      allowedOrigins: [{ scheme: 'https', hostPattern: 'portal.example.gov.uk', includeSubdomains: false }],
      purposes: ['secret_fill'],
      allowedSecretTypes: ['bank_account_number', 'bank_sort_code', 'iban', 'bic_swift'] as SecretFieldKind[],
      vaultFolder: 'AIO-Agent',
      expiresAt: 9_999_999_999_999,
    },
    'auth-1',
  );

  return {
    result: (<T>(input: unknown) => input as BrowserGatewayResult<T>) as FillOperationDeps['result'],
    hasExistingTab: () => false,
    resolveCredentialProfileScope: (profileId) => profileId,
    type: vi.fn(),
    select: vi.fn(),
    click: vi.fn(),
    // Real DOM round-trip: type sets the control value, readControl reads it back.
    driverType: async (_p, _t, selector, value) => {
      (el(selector) as HTMLInputElement).value = value;
    },
    readControl: async (_p, _t, selector) => ({ value: (el(selector) as HTMLInputElement).value }),
    refreshTargetOrigin: async () => ORIGIN,
    credentialVault: vault,
    credentialAuthorizations: authorizations,
  };
}

describe('procurement portal — action classification (the Constellia fix)', () => {
  it('does NOT classify the insurance expiry date or its Save button as payment', () => {
    loadPortal();

    const expiry = classifyBrowserAction({ toolName: 'browser.type', elementContext: contextFor('#insurance-expiry') });
    expect(expiry.actionClass).not.toBe('payment');
    expect(expiry.hardStop).toBe(false);

    // The Save button sits inside a section whose text contains "expiry date" —
    // this is exactly what used to be mis-read as payment. Now an ordinary submit.
    const save = classifyBrowserAction({ toolName: 'browser.click', elementContext: contextFor('#save-insurance') });
    expect(save).toMatchObject({ actionClass: 'submit', hardStop: false });
  });

  it('classifies supplier bank fields as financial_identity (broker-only, not payment)', () => {
    loadPortal();
    for (const selector of ['#account-number', '#sort-code', '#iban', '#bic']) {
      expect(
        classifyBrowserAction({ toolName: 'browser.type', elementContext: contextFor(selector) }),
      ).toMatchObject({ actionClass: 'financial_identity', hardStop: true });
    }
  });

  it('keeps the genuine card-payment section hard-blocked AND never grantable', () => {
    loadPortal();
    const card = classifyBrowserAction({ toolName: 'browser.type', elementContext: contextFor('#card-number') });
    expect(card).toMatchObject({ actionClass: 'payment', hardStop: true });
    expect(actionClassNeverGrantable('payment')).toBe(true);

    // A fill_form that includes the card field hard-stops as payment.
    const form = classifyBrowserFillForm([
      { selector: '#card-number', elementContext: contextFor('#card-number') },
      { selector: '#card-expiry', elementContext: contextFor('#card-expiry') },
    ]);
    expect(form).toMatchObject({ actionClass: 'payment', hardStop: true });
  });
});

describe('procurement portal — secure bank fill via the broker (real DOM)', () => {
  it('fills + verifies the bank details from an opaque vault ref, leaking no value', async () => {
    loadPortal();
    const deps = makeDomDeps(makeVault());
    const request: BrowserGatewayFillSecretRequest = {
      instanceId: 'i1',
      provider: 'orchestrator',
      profileId: 'p1',
      targetId: 't1',
      vaultItemRef: 'supplier-1',
      fields: [
        { selector: '#account-number', secretType: 'bank_account_number' },
        { selector: '#sort-code', secretType: 'bank_sort_code' },
        { selector: '#iban', secretType: 'iban' },
        { selector: '#bic', secretType: 'bic_swift' },
      ],
    };

    const result = await fillSecretOperation(deps, request);

    // All four filled + verified against the live DOM read-back.
    expect(result.decision).toBe('allowed');
    expect(result.outcome).toBe('succeeded');
    expect(result.data).toEqual({ filled: 4, verified: 4 });

    // The values actually landed in the page (test reads the DOM directly)...
    expect((el('#account-number') as HTMLInputElement).value).toBe(BANK_SECRETS['Account Number']);
    expect((el('#iban') as HTMLInputElement).value).toBe(BANK_SECRETS['IBAN']);

    // ...but NO secret value appears anywhere in the model-visible result / audit
    // fields (data, summary, reason).
    const serialized = JSON.stringify(result);
    for (const value of Object.values(BANK_SECRETS)) {
      expect(serialized).not.toContain(value);
    }
  });

  it('refuses to fill a bank field the authorization does not cover (tax id)', async () => {
    loadPortal();
    const deps = makeDomDeps(makeVault());
    const result = await fillSecretOperation(deps, {
      instanceId: 'i1',
      provider: 'orchestrator',
      profileId: 'p1',
      targetId: 't1',
      vaultItemRef: 'supplier-1',
      fields: [{ selector: '#account-number', secretType: 'tax_identifier' }],
    });
    expect(result.decision).toBe('denied');
    expect(result.reason).toContain('secret_type_not_authorized');
    // Nothing was typed into the page.
    expect((el('#account-number') as HTMLInputElement).value).toBe('');
  });
});
