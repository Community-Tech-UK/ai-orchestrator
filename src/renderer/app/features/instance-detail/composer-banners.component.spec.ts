/**
 * Unit tests for the in-session auth-repair banner.
 *
 * Context: when a provider's credentials expire mid-session the turn dies with
 * "Failed to authenticate: OAuth session expired and could not be refreshed".
 * The banner is the repair surface — sign in, retry, or dismiss — and it must
 * never claim more than it knows (e.g. "resumed" when the user is still
 * signed out).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ComposerBannersComponent } from './composer-banners.component';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import { ProviderIpcService } from '../../core/services/ipc/provider-ipc.service';
import { ProviderAccountIpcService } from '../../core/services/ipc/provider-account-ipc.service';
import { InstanceStore } from '../../core/state/instance.store';
import type { InstanceWaitReason } from '../../../../shared/types/instance.types';

describe('ComposerBannersComponent auth repair', () => {
  const authRepairRetry = vi.fn();
  const authRepairCancel = vi.fn();
  const runProviderLogin = vi.fn();

  const instanceIpc = {
    authRepairRetry,
    authRepairCancel,
    providerLimitResumeNow: vi.fn(),
    providerLimitCancel: vi.fn(),
    instanceFailoverNow: vi.fn(),
    hardenedAllowPath: vi.fn(),
    restartInstance: vi.fn(),
  };
  const providerIpc = { runProviderLogin };
  const providerAccountIpc = { list: vi.fn(), switchSession: vi.fn() };
  const instanceStore = { getInstance: vi.fn(() => undefined), setError: vi.fn() };

  let fixture: ComponentFixture<ComposerBannersComponent>;
  let component: ComposerBannersComponent;

  const authWaitReason: InstanceWaitReason = {
    kind: 'auth-required',
    provider: 'claude',
    since: 1_700_000_000_000,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    authRepairRetry.mockResolvedValue({ success: true, data: { status: 'resumed' } });
    authRepairCancel.mockResolvedValue({ success: true });
    runProviderLogin.mockResolvedValue({
      success: true,
      data: { provider: 'claude', command: 'claude auth login', terminal: 'Terminal' },
    });
    providerAccountIpc.list.mockResolvedValue({ profiles: [], pools: {} });

    await TestBed.configureTestingModule({
      imports: [ComposerBannersComponent],
      providers: [
        { provide: InstanceIpcService, useValue: instanceIpc },
        { provide: ProviderIpcService, useValue: providerIpc },
        { provide: ProviderAccountIpcService, useValue: providerAccountIpc },
        { provide: InstanceStore, useValue: instanceStore },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ComposerBannersComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('instanceId', 'i1');
    fixture.componentRef.setInput('waitReason', authWaitReason);
  });

  it('shows a signed-out banner naming the provider', () => {
    expect(component.authRequired()).toMatchObject({ kind: 'auth-required', provider: 'claude' });
    expect(component.authLabel()).toContain('Signed out of claude');
  });

  it('shows no auth banner for other wait reasons', () => {
    fixture.componentRef.setInput('waitReason', {
      kind: 'quota-park',
      provider: 'claude',
      resumeAt: Date.now() + 60_000,
    } satisfies InstanceWaitReason);

    expect(component.authRequired()).toBeNull();
    expect(component.authLabel()).toBeNull();
  });

  it('opens the sign-in terminal and says the session resumes on its own', async () => {
    await component.onSignIn('claude');

    expect(runProviderLogin).toHaveBeenCalledWith('claude');
    expect(component.authNotice()).toContain('claude auth login');
    expect(component.authNotice()).toContain('resumes on its own');
    expect(component.authBusy()).toBe(false);
  });

  it('surfaces a failed sign-in launch', async () => {
    runProviderLogin.mockResolvedValue({
      success: false,
      error: { message: 'No supported terminal emulator was found.' },
    });

    await component.onSignIn('claude');

    expect(component.authNotice()).toBe('No supported terminal emulator was found.');
  });

  it('stays quiet on a successful retry — the banner disappears with the wait reason', async () => {
    await component.onAuthRetry();

    expect(authRepairRetry).toHaveBeenCalledWith('i1');
    expect(component.authNotice()).toBeNull();
  });

  it('says so when the retry finds the user is still signed out', async () => {
    authRepairRetry.mockResolvedValue({ success: true, data: { status: 'still-signed-out' } });

    await component.onAuthRetry();

    expect(component.authNotice()).toContain('Still signed out');
  });

  it('passes through the handler message when auth status could not be read', async () => {
    authRepairRetry.mockResolvedValue({
      success: true,
      data: { status: 'unknown', message: 'Could not read claude auth status. Finish signing in, then try again.' },
    });

    await component.onAuthRetry();

    expect(component.authNotice()).toContain('Could not read claude auth status');
  });

  it('clears the busy flag even when the retry IPC fails', async () => {
    authRepairRetry.mockResolvedValue({ success: false, error: { message: 'IPC exploded' } });

    await component.onAuthRetry();

    expect(component.authNotice()).toBe('IPC exploded');
    expect(component.authBusy()).toBe(false);
  });

  it('dismisses via the cancel channel', () => {
    component.onAuthDismiss();

    expect(authRepairCancel).toHaveBeenCalledWith('i1');
    expect(component.authNotice()).toBeNull();
  });
});

describe('ComposerBannersComponent same-provider account switch', () => {
  const instanceIpc = {
    authRepairRetry: vi.fn(),
    authRepairCancel: vi.fn(),
    providerLimitResumeNow: vi.fn(),
    providerLimitCancel: vi.fn(),
    instanceFailoverNow: vi.fn(),
    hardenedAllowPath: vi.fn(),
    restartInstance: vi.fn(),
  };
  const providerIpc = { runProviderLogin: vi.fn() };
  const list = vi.fn();
  const switchSession = vi.fn();
  const providerAccountIpc = { list, switchSession };
  const getInstance = vi.fn();
  const instanceStore = { getInstance, setError: vi.fn() };

  const quotaParkWaitReason: InstanceWaitReason = {
    kind: 'quota-park',
    provider: 'codex',
    resumeAt: Date.now() + 60_000,
  };

  let fixture: ComponentFixture<ComposerBannersComponent>;
  let component: ComposerBannersComponent;

  beforeEach(async () => {
    vi.clearAllMocks();
    getInstance.mockReturnValue({ id: 'i1', provider: 'codex', accountProfileId: 'acct-a' });
    list.mockResolvedValue({
      profiles: [
        { id: 'acct-a', label: 'Max A', enabled: true, isLegacy: false },
        { id: 'acct-b', label: 'Max B', enabled: true, isLegacy: false },
        { id: 'acct-c', label: 'Disabled', enabled: false, isLegacy: false },
      ],
      pools: {},
    });
    switchSession.mockResolvedValue({ success: true });

    await TestBed.configureTestingModule({
      imports: [ComposerBannersComponent],
      providers: [
        { provide: InstanceIpcService, useValue: instanceIpc },
        { provide: ProviderIpcService, useValue: providerIpc },
        { provide: ProviderAccountIpcService, useValue: providerAccountIpc },
        { provide: InstanceStore, useValue: instanceStore },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ComposerBannersComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('instanceId', 'i1');
    fixture.componentRef.setInput('waitReason', quotaParkWaitReason);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('offers the other enabled sibling account, excluding the current and disabled ones', () => {
    expect(component.accountSwitchOptions().map((a) => a.id)).toEqual(['acct-b']);
  });

  it('switches the session to the chosen account', async () => {
    await component.onSwitchAccount({ target: { value: 'acct-b' } } as unknown as Event);

    expect(switchSession).toHaveBeenCalledWith('i1', 'acct-b');
  });

  it('surfaces a failed switch on the instance store', async () => {
    switchSession.mockResolvedValue({ success: false, error: { message: 'Account switch failed' } });

    await component.onSwitchAccount({ target: { value: 'acct-b' } } as unknown as Event);

    expect(instanceStore.setError).toHaveBeenCalledWith('Account switch failed');
  });

  it('offers nothing once no other accounts are left', () => {
    fixture.componentRef.setInput('waitReason', undefined);
    fixture.detectChanges();

    expect(component.accountSwitchOptions()).toEqual([]);
  });
});

describe('ComposerBannersComponent hardened credential failure', () => {
  const getInstance = vi.fn();
  const runProviderLogin = vi.fn();
  const launchLogin = vi.fn();
  const instanceIpc = {
    authRepairRetry: vi.fn(), authRepairCancel: vi.fn(),
    providerLimitResumeNow: vi.fn(), providerLimitCancel: vi.fn(),
    instanceFailoverNow: vi.fn(), hardenedAllowPath: vi.fn(), restartInstance: vi.fn(),
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    getInstance.mockReturnValue({
      id: 'hardened-instance', provider: 'claude', hardened: true,
      outputBuffer: [{
        id: 'auth-error', timestamp: 1, type: 'error',
        content: 'Failed to authenticate: OAuth session expired and could not be refreshed',
      }],
    });
    await TestBed.configureTestingModule({
      imports: [ComposerBannersComponent],
      providers: [
        { provide: InstanceIpcService, useValue: instanceIpc },
        { provide: ProviderIpcService, useValue: { runProviderLogin } },
        { provide: ProviderAccountIpcService, useValue: { list: vi.fn(), switchSession: vi.fn(), launchLogin } },
        { provide: InstanceStore, useValue: { getInstance, setError: vi.fn() } },
      ],
    }).compileComponents();
  });

  it('shows credential repair without offering to grant a Keychain path', () => {
    const fixture = TestBed.createComponent(ComposerBannersComponent);
    fixture.componentRef.setInput('instanceId', 'hardened-instance');
    fixture.componentRef.setInput('instanceStatus', 'error');
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toMatch(/credential|sign in/i);
    expect(fixture.nativeElement.querySelector('.hardened-path-input')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('Allow path & retry');
  });

  it('opens provider sign-in outside the hardened session and asks for an explicit retry', async () => {
    runProviderLogin.mockResolvedValue({ success: true });
    const fixture = TestBed.createComponent(ComposerBannersComponent);
    fixture.componentRef.setInput('instanceId', 'hardened-instance');
    fixture.componentRef.setInput('instanceStatus', 'error');
    fixture.detectChanges();

    const signIn = [...fixture.nativeElement.querySelectorAll('.hardened-credential-bar button')]
      .find((button: HTMLButtonElement) => button.textContent?.trim() === 'Sign in') as HTMLButtonElement | undefined;
    expect(signIn).toBeDefined();
    signIn!.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(runProviderLogin).toHaveBeenCalledWith('claude');
    expect(fixture.nativeElement.textContent).toContain('then retry this session');
  });

  it('keeps a sign-in launch failure visible and clears the busy state', async () => {
    runProviderLogin.mockRejectedValue(new Error('Terminal launch failed'));
    const fixture = TestBed.createComponent(ComposerBannersComponent);
    fixture.componentRef.setInput('instanceId', 'hardened-instance');
    fixture.componentRef.setInput('instanceStatus', 'error');
    fixture.detectChanges();

    await fixture.componentInstance.onHardenedCredentialSignIn();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Terminal launch failed');
    expect(fixture.componentInstance.hardenedCredentialBusy()).toBe(false);
  });

  it('signs in the account profile actually used by a routed Claude session', async () => {
    getInstance.mockReturnValue({
      id: 'hardened-instance', provider: 'claude', accountProfileId: 'max-b', hardened: true,
      outputBuffer: [{
        id: 'auth-error', timestamp: 1, type: 'error', content: 'Failed to authenticate',
      }],
    });
    launchLogin.mockResolvedValue({ success: true, data: { openedTerminal: true } });
    const fixture = TestBed.createComponent(ComposerBannersComponent);
    fixture.componentRef.setInput('instanceId', 'hardened-instance');
    fixture.componentRef.setInput('instanceStatus', 'error');
    fixture.detectChanges();

    await fixture.componentInstance.onHardenedCredentialSignIn();

    expect(launchLogin).toHaveBeenCalledWith('claude', 'max-b', { openTerminal: true });
    expect(runProviderLogin).not.toHaveBeenCalled();
  });

  it('does not display a previous instance’s delayed sign-in result after selection changes', async () => {
    let finishLogin: ((response: { success: boolean }) => void) | undefined;
    const loginResponse = new Promise((resolve) => { finishLogin = resolve; });
    launchLogin.mockReturnValue(loginResponse);
    runProviderLogin.mockReturnValue(loginResponse);
    getInstance.mockImplementation((id: string) => ({
      id, provider: 'claude', accountProfileId: id === 'hardened-instance' ? 'max-b' : 'max-c', hardened: true,
      outputBuffer: [{ id: 'auth-error', timestamp: 1, type: 'error', content: 'Failed to authenticate' }],
    }));
    const fixture = TestBed.createComponent(ComposerBannersComponent);
    fixture.componentRef.setInput('instanceId', 'hardened-instance');
    fixture.componentRef.setInput('instanceStatus', 'error');
    fixture.detectChanges();

    const pending = fixture.componentInstance.onHardenedCredentialSignIn();
    fixture.componentRef.setInput('instanceId', 'another-instance');
    fixture.detectChanges();
    expect(finishLogin).toBeDefined();
    finishLogin!({ success: true });
    await pending;
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).not.toContain('Complete sign-in');
    expect(fixture.componentInstance.hardenedCredentialBusy()).toBe(false);
  });

  it('does not offer a path grant for an unrelated hardened process error', () => {
    getInstance.mockReturnValue({
      id: 'hardened-instance', provider: 'claude', hardened: true,
      outputBuffer: [{ id: 'process-error', timestamp: 1, type: 'error', content: 'Process exited with code 1' }],
    });
    const fixture = TestBed.createComponent(ComposerBannersComponent);
    fixture.componentRef.setInput('instanceId', 'hardened-instance');
    fixture.componentRef.setInput('instanceStatus', 'error');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.hardened-path-input')).toBeNull();
  });

  it('still offers a path grant after a genuine file denial', () => {
    getInstance.mockReturnValue({
      id: 'hardened-instance', provider: 'claude', hardened: true,
      outputBuffer: [{
        id: 'file-error', timestamp: 1, type: 'error',
        content: 'Operation not permitted: /Users/test/Desktop/probe',
      }],
    });
    const fixture = TestBed.createComponent(ComposerBannersComponent);
    fixture.componentRef.setInput('instanceId', 'hardened-instance');
    fixture.componentRef.setInput('instanceStatus', 'error');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.hardened-path-input')).not.toBeNull();
  });
});
