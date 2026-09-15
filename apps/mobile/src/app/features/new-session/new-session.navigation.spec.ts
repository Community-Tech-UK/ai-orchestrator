import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { GatewayClient } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';
import { SessionsComponent } from '../sessions/sessions.component';
import { newSessionPresetState, trustedNewSessionDirectory } from './new-session.navigation';

describe('New Session folder provenance', () => {
  it('accepts only the exact directory supplied by the active host', () => {
    const state = newSessionPresetState('host-a', '/work/a');
    expect(trustedNewSessionDirectory(state, 'host-a', '/work/a')).toBe('/work/a');
    expect(trustedNewSessionDirectory(state, 'host-b', '/work/a')).toBe('');
    expect(trustedNewSessionDirectory(state, 'host-a', '/work/edited-url')).toBe('');
    expect(trustedNewSessionDirectory(undefined, 'host-a', '/work/a')).toBe('');
  });

  it.each([false, true])('Sessions only supplies a folder established by current-host data (known=%s)', (known) => {
    const navigate = vi.fn();
    TestBed.configureTestingModule({ providers: [
      { provide: Router, useValue: { navigate } },
      { provide: HostStore, useValue: { activeHost: signal({ id: 'host-b' }) } },
      { provide: GatewayClient, useValue: {
        online: signal(true), state: signal('connected'), dataHostId: signal('host-b'),
        snapshot: signal({ projects: known ? [{ path: '/work/a' }] : [{ path: '/host-b/project' }] }),
        historySessions: signal([]),
      } },
    ] });
    const component = TestBed.runInInjectionContext(() => new SessionsComponent());
    Object.defineProperty(component, 'projectKey', { value: signal('/work/a') });
    (component as unknown as { newSession(): void }).newSession();
    expect(navigate).toHaveBeenCalledWith(['/new-session'], {
      queryParams: known ? { dir: '/work/a' } : undefined,
      state: {
        mobileBrowseOrigin: { hostId: 'host-b', route: '/projects' },
        mobileNewSessionPreset: { hostId: 'host-b', directory: known ? '/work/a' : '' },
      },
    });
  });
});
