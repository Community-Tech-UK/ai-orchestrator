import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppLockService } from '../../core/app-lock.service';
import { GatewayClient, type ConnectionState } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';
import type { PairedHost } from '../../core/models';
import { HostsComponent } from './hosts.component';

const hosts: PairedHost[] = [
  { id: 'host-a', name: 'Example A', host: 'a.example.test', port: 4879, token: 'PLACEHOLDER_DEVICE_A', addedAt: 0 },
  { id: 'host-b', name: 'Example B', host: 'b.example.test', port: 4879, token: 'PLACEHOLDER_DEVICE_B', addedAt: 0 },
];
function setup() {
  const activeId = signal('host-a');
  const state = signal<ConnectionState>('connected');
  const dataHostId = signal('host-a');
  const reconnect = vi.fn();
  const removeHost = vi.fn().mockResolvedValue(undefined);
  const navigate = vi.fn();
  const setActive = vi.fn().mockImplementation(async (id: string) => activeId.set(id));
  TestBed.configureTestingModule({ imports: [HostsComponent], providers: [
    { provide: HostStore, useValue: { hosts: signal(hosts), activeId, setActive, removeHost } },
    { provide: GatewayClient, useValue: { state, dataHostId, online: () => state() === 'connected', reconnect } },
    { provide: Router, useValue: { navigate } },
    { provide: AppLockService, useValue: { available: signal(false), enabled: signal(true), locked: signal(false), biometryLabel: () => 'Face ID' } },
  ] });
  TestBed.overrideComponent(HostsComponent, { set: { imports: [], schemas: [NO_ERRORS_SCHEMA] } });
  const fixture = TestBed.createComponent(HostsComponent); fixture.detectChanges();
  const button = (label: string) => [...fixture.nativeElement.querySelectorAll('button')].find((el) => (el as HTMLButtonElement).textContent?.trim() === label) as HTMLButtonElement;
  return { fixture, button, activeId, dataHostId, state, reconnect, removeHost, navigate, setActive };
}

afterEach(() => vi.unstubAllGlobals());

describe('Hosts recovery behavior', () => {
  it('never gives an inactive or newly selected host another host’s health', () => {
    const { fixture, activeId } = setup();
    let rows = fixture.nativeElement.querySelectorAll('.host-row');
    expect(rows[1].textContent).toContain('Not selected');
    activeId.set('host-b'); fixture.detectChanges();
    rows = fixture.nativeElement.querySelectorAll('.host-row');
    expect(rows[0].textContent).toContain('Not selected');
    expect(rows[1].textContent).toContain('Not checked');
    expect(rows[1].querySelector('.host-row__status--online')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('PLACEHOLDER_DEVICE');
  });

  it('offers network recovery for offline and pairing recovery for expired pairing', () => {
    const { fixture, button, state, reconnect, navigate } = setup();
    state.set('disconnected'); fixture.detectChanges();
    button('Reconnect').click(); expect(reconnect).toHaveBeenCalledOnce();
    state.set('unauthorized'); fixture.detectChanges();
    expect(button('Reconnect')).toBeUndefined();
    expect(fixture.nativeElement.querySelector('.host-recovery').textContent).not.toContain('Tailscale');
    button('Pair again').click(); expect(navigate).toHaveBeenCalledWith(['/add-host']);
  });

  it('changes to the chosen host without claiming its connection is online', async () => {
    const { fixture, button, activeId, navigate, setActive } = setup();
    button('Change host').click(); fixture.detectChanges();
    fixture.nativeElement.querySelector('[aria-label="Select Example B"]').click();
    await fixture.whenStable(); fixture.detectChanges();
    expect(setActive).toHaveBeenCalledWith('host-b');
    expect(activeId()).toBe('host-b');
    expect(navigate).toHaveBeenCalledWith(['/projects']);
    expect(fixture.nativeElement.querySelectorAll('.host-row')[1].textContent).toContain('Not checked');
  });

  it('requires secondary options and confirmation before revoking and removing', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false }); vi.stubGlobal('fetch', fetchMock);
    const confirmMock = vi.fn().mockReturnValue(false); vi.stubGlobal('confirm', confirmMock);
    const { fixture, button, removeHost } = setup();
    expect(button('Remove host')).toBeUndefined();
    fixture.nativeElement.querySelector('[aria-label="Options for Example A"]').click(); fixture.detectChanges();
    button('Remove host').click(); await fixture.whenStable();
    expect(fetchMock).not.toHaveBeenCalled(); expect(removeHost).not.toHaveBeenCalled();
    confirmMock.mockReturnValue(true);
    button('Remove host').click(); await fixture.whenStable(); fixture.detectChanges();
    expect(fetchMock.mock.calls[0][0]).toBe('http://a.example.test:4879/api/devices/me');
    expect(removeHost).toHaveBeenCalledWith('host-a');
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(removeHost.mock.invocationCallOrder[0]);
    expect(fixture.nativeElement.querySelector('[role=alert]').textContent).toContain('Revoke it on the Mac');
  });
});
