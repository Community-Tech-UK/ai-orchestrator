import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserVaultControlComponent, vaultUnlockReasonLabel } from './browser-vault-control.component';
import { BrowserUnattendedStore } from './browser-unattended.store';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './browser-vault-control.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './browser-vault-control.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('browser-vault-control.component.html')) {
    return Promise.resolve(template);
  }
  if (url.endsWith('browser-vault-control.component.scss')) {
    return Promise.resolve(styles);
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('vaultUnlockReasonLabel', () => {
  it('maps known reasons to human text', () => {
    expect(vaultUnlockReasonLabel('empty_password')).toContain('No vault master password');
    expect(vaultUnlockReasonLabel('bw_unlock_failed')).toContain('Bitwarden CLI unlock failed');
    expect(vaultUnlockReasonLabel('empty_session')).toContain('did not return a session token');
    expect(vaultUnlockReasonLabel(null)).toBe(null);
  });
});

describe('BrowserVaultControlComponent', () => {
  let fixture: ComponentFixture<BrowserVaultControlComponent>;
  let store: {
    vaultStatus: ReturnType<typeof vi.fn>;
    vaultBusy: ReturnType<typeof vi.fn>;
    vaultUnlockReason: ReturnType<typeof vi.fn>;
    refreshVaultStatus: ReturnType<typeof vi.fn>;
    unlockVault: ReturnType<typeof vi.fn>;
    lockVault: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    store = {
      vaultStatus: vi.fn(() => ({ locked: true, passwordSourceConfigured: false })),
      vaultBusy: vi.fn(() => false),
      vaultUnlockReason: vi.fn(() => null),
      refreshVaultStatus: vi.fn().mockResolvedValue(undefined),
      unlockVault: vi.fn().mockResolvedValue(true),
      lockVault: vi.fn().mockResolvedValue(undefined),
    };

    await TestBed.configureTestingModule({
      imports: [BrowserVaultControlComponent],
      providers: [{ provide: BrowserUnattendedStore, useValue: store }],
    }).compileComponents();

    fixture = TestBed.createComponent(BrowserVaultControlComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('refreshes vault status on init', () => {
    expect(store.refreshVaultStatus).toHaveBeenCalled();
  });

  it('shows locked status and the password-source hint', () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Locked');
    expect(text).toContain('Password source not configured');
  });

  it('calls unlockVault when the unlock button is clicked', async () => {
    const button = fixture.nativeElement.querySelector(
      '[data-testid="vault-unlock-button"]',
    ) as HTMLButtonElement;
    button.click();
    await fixture.whenStable();

    expect(store.unlockVault).toHaveBeenCalled();
  });

  it('calls lockVault when the lock button is clicked', async () => {
    store.vaultStatus = vi.fn(() => ({ locked: false, passwordSourceConfigured: true }));
    fixture = TestBed.createComponent(BrowserVaultControlComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector(
      '[data-testid="vault-lock-button"]',
    ) as HTMLButtonElement;
    button.click();
    await fixture.whenStable();

    expect(store.lockVault).toHaveBeenCalled();
  });
});
