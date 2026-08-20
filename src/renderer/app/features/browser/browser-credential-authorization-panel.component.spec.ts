import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
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

function overrideSharedTabScopesInput(
  component: BrowserCredentialAuthorizationPanelComponent,
  scopes: { id: string; label: string }[],
): void {
  (
    component as unknown as { sharedTabScopes: () => { id: string; label: string }[] }
  ).sharedTabScopes = () => scopes;
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
    enrolCredential: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    store = {
      authorizations: vi.fn(() => []),
      busy: vi.fn(() => false),
      errorMessage: vi.fn(() => null),
      refreshAuthorizations: vi.fn().mockResolvedValue(undefined),
      createAuthorization: vi.fn().mockResolvedValue(true),
      revokeAuthorization: vi.fn().mockResolvedValue(true),
      enrolCredential: vi.fn().mockResolvedValue({
        vaultItemRef: 'item-1',
        username: 'james@communitytech.co.uk',
        movedIntoFolder: false,
      }),
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

  // Every other test in this file calls the component's methods directly, so
  // the template itself — the part that routes a real keystroke to a real
  // handler — was unverified. A 2026-08-19 completion gate swapped the two
  // `(input)` handlers between these fields (a same-signature swap that
  // compiles cleanly and passes Angular's strict template type-check) and all
  // 10 tests still passed. These two drive the real DOM instead.
  it('routes typing in the vault-item field to the item signal, not the origin signal', () => {
    const el: HTMLInputElement = fixture.nativeElement.querySelector(
      '[data-testid="enrol-item-input"]',
    );
    expect(el).toBeTruthy();

    el.value = 'Report MI - RM6094';
    el.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(fixture.componentInstance.enrolItem()).toBe('Report MI - RM6094');
    expect(fixture.componentInstance.enrolOrigin()).toBe('');
  });

  it('routes typing in the origin field to the origin signal, not the item signal', () => {
    const el: HTMLInputElement = fixture.nativeElement.querySelector(
      '[data-testid="enrol-origin-input"]',
    );
    expect(el).toBeTruthy();

    el.value = 'https://auth.reportmi.gca.gov.uk';
    el.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(fixture.componentInstance.enrolOrigin()).toBe('https://auth.reportmi.gca.gov.uk');
    expect(fixture.componentInstance.enrolItem()).toBe('');
  });

  // Pass 4 of the 2026-08-19 completion gate found three more template bindings
  // on this form with no DOM-level coverage: the submit handler itself, the
  // OTP sender-domains field, and the move-into-folder opt-in. Each was
  // mutated and all 12 tests still passed. These three drive the real DOM.
  it('submits the enrol form through the template, not just the method', async () => {
    const form: HTMLFormElement = fixture.nativeElement.querySelector('form.enrol-form');
    expect(form).toBeTruthy();

    const item: HTMLInputElement = fixture.nativeElement.querySelector(
      '[data-testid="enrol-item-input"]',
    );
    const origin: HTMLInputElement = fixture.nativeElement.querySelector(
      '[data-testid="enrol-origin-input"]',
    );
    item.value = 'Report MI login';
    item.dispatchEvent(new Event('input'));
    origin.value = 'https://auth.reportmi.gca.gov.uk';
    origin.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    form.dispatchEvent(new Event('submit'));
    await fixture.whenStable();

    // This is the literal click a human performs at livetest item 1.
    expect(store.enrolCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        item: 'Report MI login',
        origin: 'https://auth.reportmi.gca.gov.uk',
      }),
    );
  });

  it('routes typing in the sender-domains field to the senderDomains signal', () => {
    const el: HTMLInputElement = fixture.nativeElement.querySelector(
      '[data-testid="sender-domains-input"]',
    );
    expect(el).toBeTruthy();

    el.value = 'notifications.service.gov.uk';
    el.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(fixture.componentInstance.senderDomains()).toBe('notifications.service.gov.uk');
  });

  // Security-relevant: this checkbox is the explicit human opt-in to move a
  // vault item out of its current folder into the jailed agent folder. A broken
  // binding fails safe (the move never happens) but silently breaks enrolment
  // for any item that lives elsewhere.
  it('routes the move-into-folder checkbox through the template', () => {
    const el: HTMLInputElement = fixture.nativeElement.querySelector(
      '[data-testid="enrol-move-toggle"]',
    );
    expect(el).toBeTruthy();
    expect(fixture.componentInstance.enrolMoveIntoFolder()).toBe(false);

    el.checked = true;
    el.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(fixture.componentInstance.enrolMoveIntoFolder()).toBe(true);
  });

  // Change C's own fallback: with no managed profile, a shared-tab scope is a
  // valid authorization target on its own, so the form must auto-select one.
  // A 2026-08-19 completion gate deleted this `else if` branch and 69/69 tests
  // still passed — nothing supplied `sharedTabScopes` as an input anywhere.
  //
  // The user-visible failure is a dead end: with `selectedProfileId` empty the
  // <select> still *renders* its first option as selected, so the form looks
  // ready, and submit() then refuses with "Select a profile".
  const scopeList = [
    { id: 'local', label: 'Shared tabs on this machine (local)' },
    { id: 'node-1', label: 'Shared tabs on windows-pc' },
  ];

  describe('default selection with no managed profiles', () => {
    const scopes = scopeList;

    function createWith(
      profiles: BrowserProfile[],
      sharedTabScopes: { id: string; label: string }[],
    ): ComponentFixture<BrowserCredentialAuthorizationPanelComponent> {
      const created = TestBed.createComponent(BrowserCredentialAuthorizationPanelComponent);
      overrideProfilesInput(created.componentInstance, profiles);
      overrideSharedTabScopesInput(created.componentInstance, sharedTabScopes);
      created.detectChanges();
      return created;
    }

    it('falls back to the first shared-tab scope when there are no profiles', () => {
      const created = createWith([], scopes);
      expect(created.componentInstance.selectedProfileId()).toBe('local');
    });

    it('still prefers a managed profile when one exists', () => {
      const created = createWith([profile], scopes);
      expect(created.componentInstance.selectedProfileId()).toBe('profile-1');
    });

    // The effect's early-return guard (`if (this.selectedProfileId()) return;`)
    // is what stops it stomping a choice the user already made. A 2026-08-19
    // completion gate removed that guard and 18/18 tests still passed, because
    // nothing re-fired the effect after a manual selection.
    //
    // The real trigger is the parent panel's Refresh button, which reassigns
    // both `profiles` and `sharedTabScopes` to new array references — exactly
    // what this effect reacts to. Without the guard a user who picked a
    // non-default node scope and then clicked Refresh would silently have the
    // authorization retargeted at the first profile/scope.
    it('does not stomp a manual selection when the inputs are reassigned', () => {
      // The overrides must be real signals: a plain closure is not a reactive
      // dependency, so the effect would only ever run once and this test could
      // not fail. (It did not, on the first attempt — caught by mutation.)
      const profilesSignal = signal<BrowserProfile[]>([]);
      const scopesSignal = signal([...scopeList]);
      const created = TestBed.createComponent(BrowserCredentialAuthorizationPanelComponent);
      (
        created.componentInstance as unknown as { profiles: () => BrowserProfile[] }
      ).profiles = profilesSignal;
      (
        created.componentInstance as unknown as {
          sharedTabScopes: () => { id: string; label: string }[];
        }
      ).sharedTabScopes = scopesSignal;
      created.detectChanges();

      // Auto-defaulted to the first scope, then the user picks the second.
      expect(created.componentInstance.selectedProfileId()).toBe('local');
      created.componentInstance.onProfileChange({
        target: { value: 'node-1' },
      } as unknown as Event);
      expect(created.componentInstance.selectedProfileId()).toBe('node-1');

      // A refresh hands both inputs brand-new array references, which is what
      // re-fires the effect.
      profilesSignal.set([profile]);
      scopesSignal.set([...scopeList]);
      created.detectChanges();

      expect(created.componentInstance.selectedProfileId()).toBe('node-1');
    });

    it('leaves the selection empty when there is neither a profile nor a scope', () => {
      const created = createWith([], []);
      expect(created.componentInstance.selectedProfileId()).toBe('');
    });
  });

  // Every prior pass tested the DOM -> model direction (a keystroke reaching the
  // right signal). Pass 7 found the reverse untested: the `[value]`/`[checked]`
  // bindings that push a signal back into the DOM. Deleting all four left 19/19
  // green. They matter because enrol() clears the form on success — if the
  // reset never reaches the DOM, the "move into folder" box keeps *looking*
  // ticked while the signal is false, and the next enrolment silently submits
  // moveIntoFolder: false and fails with item_outside_agent_folder for no
  // visible reason.
  it('clears the enrol form in the DOM after a successful enrolment', async () => {
    const item: HTMLInputElement = fixture.nativeElement.querySelector(
      '[data-testid="enrol-item-input"]',
    );
    const origin: HTMLInputElement = fixture.nativeElement.querySelector(
      '[data-testid="enrol-origin-input"]',
    );
    const move: HTMLInputElement = fixture.nativeElement.querySelector(
      '[data-testid="enrol-move-toggle"]',
    );

    item.value = 'Report MI login';
    item.dispatchEvent(new Event('input'));
    origin.value = 'https://auth.reportmi.gca.gov.uk';
    origin.dispatchEvent(new Event('input'));
    move.checked = true;
    move.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(item.value).toBe('Report MI login');
    expect(move.checked).toBe(true);

    await fixture.componentInstance.enrol();
    fixture.detectChanges();

    // The reset must reach the DOM, not just the signals.
    expect(item.value).toBe('');
    expect(origin.value).toBe('');
    expect(move.checked).toBe(false);
  });

  it('reflects the sender-domains signal back into its input', () => {
    const el: HTMLInputElement = fixture.nativeElement.querySelector(
      '[data-testid="sender-domains-input"]',
    );

    el.value = 'notifications.service.gov.uk';
    el.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(el.value).toBe('notifications.service.gov.uk');

    fixture.componentInstance.senderDomains.set('');
    fixture.detectChanges();
    expect(el.value).toBe('');
  });

  // The confirmation line livetest item 1 step 7 asks a human to read. Every
  // enrol test asserted on `enrolResult()` directly; nothing queried the
  // rendered element. A 2026-08-19 completion gate swapped the two
  // interpolations (showing "Bound <ref> (<username>)") and 21/21 still passed.
  // Non-secret metadata, so nothing leaks — but it is the one step none of this
  // cycle's automated coverage can substitute for, so the text is asserted here.
  it('renders the enrol confirmation line in the order a human is asked to check', async () => {
    store.enrolCredential.mockResolvedValue({
      vaultItemRef: 'item-existing',
      username: 'someone@example.invalid',
      movedIntoFolder: true,
    });
    fixture.componentInstance.enrolItem.set('Report MI login');
    fixture.componentInstance.enrolOrigin.set('https://auth.reportmi.gca.gov.uk');

    await fixture.componentInstance.enrol();
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement.querySelector('[data-testid="enrol-result"]');
    expect(el).toBeTruthy();
    const text = el.textContent!.replace(/\s+/g, ' ').trim();
    expect(text).toBe(
      'Bound someone@example.invalid (item-existing) · moved into the vault folder',
    );
  });

  it('omits the moved-into-folder suffix when the item was not moved', async () => {
    store.enrolCredential.mockResolvedValue({
      vaultItemRef: 'item-existing',
      username: 'someone@example.invalid',
      movedIntoFolder: false,
    });
    fixture.componentInstance.enrolItem.set('Report MI login');
    fixture.componentInstance.enrolOrigin.set('https://auth.reportmi.gca.gov.uk');

    await fixture.componentInstance.enrol();
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement.querySelector('[data-testid="enrol-result"]');
    const text = el.textContent!.replace(/\s+/g, ' ').trim();
    expect(text).toBe('Bound someone@example.invalid (item-existing)');
  });

  it('renders an enrol failure message into the form error banner', async () => {
    store.enrolCredential.mockResolvedValue(null);
    store.errorMessage.mockReturnValue('item_outside_agent_folder');
    fixture.componentInstance.enrolItem.set('Report MI login');
    fixture.componentInstance.enrolOrigin.set('https://auth.reportmi.gca.gov.uk');

    await fixture.componentInstance.enrol();
    fixture.detectChanges();

    const banners = Array.from(
      fixture.nativeElement.querySelectorAll('.error-banner') as NodeListOf<HTMLElement>,
    ).map((b) => b.textContent!.trim());
    expect(banners.join(' | ')).toContain('item_outside_agent_folder');
    expect(fixture.nativeElement.querySelector('[data-testid="enrol-result"]')).toBeNull();
  });

  it('refreshes authorizations on init and defaults the profile selection', () => {
    expect(store.refreshAuthorizations).toHaveBeenCalled();
    expect(fixture.componentInstance.selectedProfileId()).toBe('profile-1');
  });

  it('enrols an existing login and reports the bound reference', async () => {
    const component = fixture.componentInstance;
    component.onEnrolItemInput(inputEvent('Report MI - RM6094 Spark DPS (GCA)'));
    component.onEnrolOriginInput(inputEvent('https://auth.reportmi.gca.gov.uk'));
    component.onEnrolMoveIntoFolderChange({ target: { checked: true } } as unknown as Event);

    await component.enrol();

    expect(store.enrolCredential).toHaveBeenCalledWith({
      item: 'Report MI - RM6094 Spark DPS (GCA)',
      origin: 'https://auth.reportmi.gca.gov.uk',
      moveIntoFolder: true,
    });
    expect(component.enrolResult()?.username).toBe('james@communitytech.co.uk');
    expect(component.enrolError()).toBeNull();
    // Form clears so the same item cannot be enrolled twice by accident.
    expect(component.enrolItem()).toBe('');
  });

  it('refuses to enrol without an item or an origin', async () => {
    const component = fixture.componentInstance;

    await component.enrol();
    expect(store.enrolCredential).not.toHaveBeenCalled();
    expect(component.enrolError()).toContain('vault item');

    component.onEnrolItemInput(inputEvent('some-item'));
    await component.enrol();
    expect(store.enrolCredential).not.toHaveBeenCalled();
    expect(component.enrolError()).toContain('origin');
  });

  it('surfaces an enrolment failure instead of reporting success', async () => {
    const component = fixture.componentInstance;
    store.enrolCredential.mockResolvedValue(null);
    store.errorMessage = vi.fn(() => 'Vault item is not inside the AIO-Agent folder');
    component.onEnrolItemInput(inputEvent('item-x'));
    component.onEnrolOriginInput(inputEvent('https://a.example'));

    await component.enrol();

    expect(component.enrolResult()).toBeNull();
    expect(component.enrolError()).toContain('AIO-Agent');
  });

  it('sends declared one-time-code senders with the authorization', async () => {
    const component = fixture.componentInstance;
    component.onOriginHostInput(0, inputEvent('gca.gov.uk'));
    component.togglePurpose('email_code');
    component.onSenderDomainsInput(inputEvent('notifications.service.gov.uk, Mailer.GCA.gov.uk'));

    await component.submit();

    const payload = store.createAuthorization.mock.calls[0]![0];
    expect(payload.allowedSenderDomains).toEqual([
      'notifications.service.gov.uk',
      'mailer.gca.gov.uk',
    ]);
  });

  it('omits the sender list entirely when none are declared', async () => {
    const component = fixture.componentInstance;
    component.onOriginHostInput(0, inputEvent('example.com'));
    component.togglePurpose('login');

    await component.submit();

    expect(store.createAuthorization.mock.calls[0]![0]).not.toHaveProperty('allowedSenderDomains');
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
