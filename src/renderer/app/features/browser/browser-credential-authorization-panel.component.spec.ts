import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import type { BrowserProfile } from '@contracts/types/browser';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserCredentialAuthorizationPanelComponent } from './browser-credential-authorization-panel.component';
import { BrowserUnattendedStore } from './browser-unattended.store';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(
  resolve(specDirectory, './browser-credential-authorization-panel.component.html'),
  'utf8',
);
const styles = readFileSync(
  resolve(specDirectory, './browser-credential-authorization-panel.component.scss'),
  'utf8',
);

await resolveComponentResources((url) => {
  if (url.endsWith('browser-credential-authorization-panel.component.html')) {
    return Promise.resolve(template);
  }
  if (url.endsWith('browser-credential-authorization-panel.component.scss')) {
    return Promise.resolve(styles);
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

const profile: BrowserProfile = {
  id: 'profile-1',
  label: 'Local App',
  mode: 'session',
  browser: 'chrome',
  allowedOrigins: [],
  status: 'stopped',
  createdAt: 1,
  updatedAt: 1,
};

function inputEvent(value: string): Event {
  return { target: { value } } as unknown as Event;
}

/**
 * The vitest config omits the Angular compiler plugin, so signal `input()`
 * metadata isn't generated and `setInput()` wiring fails. Override the input
 * getter directly — same workaround used by session-progress-panel.spec.
 */
function overrideProfilesInput(
  component: BrowserCredentialAuthorizationPanelComponent,
  profiles: BrowserProfile[],
): void {
  (component as unknown as { profiles: () => BrowserProfile[] }).profiles = () => profiles;
}

describe('BrowserCredentialAuthorizationPanelComponent', () => {
  let fixture: ComponentFixture<BrowserCredentialAuthorizationPanelComponent>;
  let store: {
    authorizations: ReturnType<typeof vi.fn>;
    busy: ReturnType<typeof vi.fn>;
    errorMessage: ReturnType<typeof vi.fn>;
    refreshAuthorizations: ReturnType<typeof vi.fn>;
    createAuthorization: ReturnType<typeof vi.fn>;
    revokeAuthorization: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    store = {
      authorizations: vi.fn(() => []),
      busy: vi.fn(() => false),
      errorMessage: vi.fn(() => null),
      refreshAuthorizations: vi.fn().mockResolvedValue(undefined),
      createAuthorization: vi.fn().mockResolvedValue(true),
      revokeAuthorization: vi.fn().mockResolvedValue(true),
    };

    await TestBed.configureTestingModule({
      imports: [BrowserCredentialAuthorizationPanelComponent],
      providers: [{ provide: BrowserUnattendedStore, useValue: store }],
    }).compileComponents();

    fixture = TestBed.createComponent(BrowserCredentialAuthorizationPanelComponent);
    overrideProfilesInput(fixture.componentInstance, [profile]);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('refreshes authorizations on init and defaults the profile selection', () => {
    expect(store.refreshAuthorizations).toHaveBeenCalled();
    expect(fixture.componentInstance.selectedProfileId()).toBe('profile-1');
  });

  it('rejects submission with no origins', async () => {
    const component = fixture.componentInstance;
    component.togglePurpose('login');

    await component.submit();

    expect(store.createAuthorization).not.toHaveBeenCalled();
    expect(component.validationError()).toContain('origin');
  });

  it('rejects submission with no purposes', async () => {
    const component = fixture.componentInstance;
    component.onOriginHostInput(0, inputEvent('example.com'));

    await component.submit();

    expect(store.createAuthorization).not.toHaveBeenCalled();
    expect(component.validationError()).toContain('purpose');
  });

  it('creates an authorization with an epoch-ms expiry derived from the preset', async () => {
    const component = fixture.componentInstance;
    const before = Date.now();
    component.onOriginHostInput(0, inputEvent('example.com'));
    component.togglePurpose('login');
    component.togglePurpose('totp');
    component.setExpiryPreset(30);

    await component.submit();

    expect(store.createAuthorization).toHaveBeenCalledTimes(1);
    const payload = store.createAuthorization.mock.calls[0]![0];
    expect(payload.profileId).toBe('profile-1');
    expect(payload.vaultFolder).toBe('AIO-Agent');
    expect(payload.allowedOrigins).toEqual([
      { scheme: 'https', hostPattern: 'example.com', includeSubdomains: false },
    ]);
    expect(payload.purposes.sort()).toEqual(['login', 'totp']);
    expect(payload.expiresAt).toBeGreaterThanOrEqual(before + 30 * 24 * 60 * 60 * 1000 - 1000);
    expect(payload.expiresAt).toBeLessThanOrEqual(before + 30 * 24 * 60 * 60 * 1000 + 5000);
  });

  it('revokes an authorization', async () => {
    await fixture.componentInstance.revoke('auth-1');
    expect(store.revokeAuthorization).toHaveBeenCalledWith('auth-1');
  });
});
