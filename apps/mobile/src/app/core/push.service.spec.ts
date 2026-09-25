import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { GatewayClient } from './gateway-client.service';
import { HapticsService } from './haptics.service';
import { HostStore } from './host-store';
import type { MobileInstanceDto, PairedHost } from './models';
import { PushService } from './push.service';

const HOST_A: PairedHost = { id: 'host-a', name: 'Mac', host: 'a.invalid', port: 1, token: 'A', addedAt: 0 };
const HOST_B: PairedHost = { id: 'host-b', name: 'Mac', host: 'b.invalid', port: 1, token: 'B', addedAt: 0 };
const INSTANCE: MobileInstanceDto = {
  id: 'session', displayName: 'Session', status: 'idle', attentionLevel: 'idle', provider: 'codex',
  workingDirectory: '/work/project', projectName: 'project', createdAt: 1, lastActivity: 1,
  pendingApprovalCount: 0, hasUnreadCompletion: false,
};

function setup(instances: MobileInstanceDto[], snapshotInstances: MobileInstanceDto[] = []) {
  const active = signal<PairedHost | null>(HOST_A);
  const setActive = vi.fn(async (id: string) => active.set(id === HOST_B.id ? HOST_B : HOST_A));
  const navigate = vi.fn(async () => true);
  const liveInstances = vi.fn(async () => instances);
  TestBed.configureTestingModule({ providers: [
    { provide: HostStore, useValue: { activeHost: active, hosts: signal([HOST_A, HOST_B]), setActive } },
    { provide: GatewayClient, useValue: {
      snapshot: signal(snapshotInstances.length > 0 ? { instances: snapshotInstances } : null),
      liveInstances,
    } },
    { provide: HapticsService, useValue: { success: vi.fn(), error: vi.fn() } },
    { provide: Router, useValue: { navigate } },
  ] });
  return { service: TestBed.inject(PushService), navigate, setActive, liveInstances };
}

describe('PushService session routing', () => {
  it('selects the host by stable device id before opening a live session', async () => {
    const { service, navigate, setActive } = setup([INSTANCE]);

    await service.handleNotificationTap({ instanceId: 'session', hostDeviceId: 'host-b' });

    expect(setActive).toHaveBeenCalledWith('host-b');
    expect(navigate).toHaveBeenCalledWith(['/projects', '/work/project', 'sessions', 'session']);
    expect(service.endedSession()).toBe(false);
  });

  it('shows ended-session choices instead of opening an empty conversation', async () => {
    const { service, navigate } = setup([]);

    await service.handleNotificationTap({ instanceId: 'gone', hostDeviceId: 'host-a' });

    expect(navigate).not.toHaveBeenCalled();
    expect(service.endedSession()).toBe(true);
    service.openEndedSessionHistory();
    expect(navigate).toHaveBeenCalledWith(['/history']);
  });

  it('revalidates a cached session before routing a notification tap', async () => {
    const { service, navigate, liveInstances } = setup([], [INSTANCE]);

    await service.handleNotificationTap({ instanceId: 'session', hostDeviceId: 'host-a' });

    expect(liveInstances).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    expect(service.endedSession()).toBe(true);
  });

  it('does not query or navigate on the active host when a supplied host id is unknown', async () => {
    const { service, navigate, setActive, liveInstances } = setup([INSTANCE]);

    await service.handleNotificationTap({ instanceId: 'session', hostDeviceId: 'unknown-host' });

    expect(setActive).not.toHaveBeenCalled();
    expect(liveInstances).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(service.endedSession()).toBe(false);
    expect(service.unknownHost()).toBe(true);
  });

  it('does not query or navigate on the active host when host identity is missing', async () => {
    const { service, navigate, setActive, liveInstances } = setup([INSTANCE]);

    await service.handleNotificationTap({ instanceId: 'session' });

    expect(setActive).not.toHaveBeenCalled();
    expect(liveInstances).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(service.endedSession()).toBe(false);
    expect(service.unknownHost()).toBe(true);
  });

  it('does not choose the first host for an ambiguous legacy hostname', async () => {
    const { service, navigate, setActive, liveInstances } = setup([INSTANCE]);

    await service.handleNotificationTap({ instanceId: 'session', host: 'Mac' });

    expect(setActive).not.toHaveBeenCalled();
    expect(liveInstances).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(service.unknownHost()).toBe(true);
  });

  it('shows a retryable unavailable-host state when live validation fails', async () => {
    const { service, navigate, liveInstances } = setup([INSTANCE]);
    liveInstances.mockRejectedValueOnce(new Error('offline'));

    await service.handleNotificationTap({ instanceId: 'session', hostDeviceId: 'host-a' });

    expect(service.endedSession()).toBe(false);
    expect(service.hostUnavailable()).toBe(true);
    expect(navigate).not.toHaveBeenCalled();

    await service.retryNotificationRouting();
    expect(service.hostUnavailable()).toBe(false);
    expect(navigate).toHaveBeenCalledWith(['/projects', '/work/project', 'sessions', 'session']);
  });

  it('shows the unavailable-host state when switching to the paired host fails', async () => {
    const { service, navigate, setActive, liveInstances } = setup([INSTANCE]);
    setActive.mockRejectedValueOnce(new Error('switch failed'));

    await service.handleNotificationTap({ instanceId: 'session', hostDeviceId: 'host-b' });

    expect(service.hostUnavailable()).toBe(true);
    expect(liveInstances).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
