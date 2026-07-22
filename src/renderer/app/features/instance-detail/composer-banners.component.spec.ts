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

    await TestBed.configureTestingModule({
      imports: [ComposerBannersComponent],
      providers: [
        { provide: InstanceIpcService, useValue: instanceIpc },
        { provide: ProviderIpcService, useValue: providerIpc },
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
