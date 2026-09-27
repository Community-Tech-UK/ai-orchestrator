import { signal } from '@angular/core';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayClient } from '../core/gateway-client.service';
import { HostStore } from '../core/host-store';
import { AppShellComponent, companionForPath } from './app-shell.component';

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn().mockResolvedValue({ value: null }),
    set: vi.fn().mockResolvedValue(undefined),
  },
}));

@Component({ standalone: true, template: 'page' })
class BlankPage {}

function installMatchMedia(initialWidth: number): { setWidth(width: number): void } {
  let width = initialWidth;
  const listeners = new Set<() => void>();
  window.matchMedia = ((query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    return {
      get matches() { return min ? width >= Number(min[1]) : query.includes('dark'); },
      media: query,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    };
  }) as unknown as typeof window.matchMedia;
  return { setWidth(next: number) { width = next; listeners.forEach((listener) => listener()); } };
}

describe('companionForPath', () => {
  it('selects the list that belongs beside a detail route', () => {
    expect(companionForPath('/projects/demo/sessions/one')).toBe('sessions');
    expect(companionForPath('/loops/loop-1')).toBe('loops');
    expect(companionForPath('/plan-queue/run-1')).toBe('plan-queue');
    expect(companionForPath('/reviews/review-1')).toBe('reviews');
    expect(companionForPath('/history/chat-1')).toBe('history');
    expect(companionForPath('/projects')).toBeNull();
  });
});

describe('AppShellComponent', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  async function setup(width: number) {
    const media = installMatchMedia(width);
    const snapshot = signal({
      hostName: 'Host', serverTime: 1, projects: [], prompts: [],
      pause: { isPaused: false, reasons: [], pausedAt: null, lastChange: 0 },
      instances: [
        { id: 'one', displayName: 'One', status: 'idle', provider: 'codex', workingDirectory: '/work/demo', projectName: 'demo', createdAt: 1, lastActivity: 1, pendingApprovalCount: 0, hasUnreadCompletion: false },
        { id: 'two', displayName: 'Two', status: 'idle', provider: 'codex', workingDirectory: '/work/demo', projectName: 'demo', createdAt: 1, lastActivity: 1, pendingApprovalCount: 0, hasUnreadCompletion: false },
      ],
    });
    TestBed.configureTestingModule({
      imports: [AppShellComponent],
      providers: [
        provideRouter([
          { path: 'projects', component: BlankPage },
          { path: 'projects/:projectKey/sessions/:instanceId', component: BlankPage },
        ]),
        { provide: GatewayClient, useValue: { snapshot, state: signal('connected'), online: signal(true), historySessions: signal([]) } },
        { provide: HostStore, useValue: { activeHost: signal({ id: 'host', name: 'Host', host: 'h', port: 1, token: 't', addedAt: 0 }) } },
      ],
    });
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate');
    const fixture = TestBed.createComponent(AppShellComponent);
    fixture.detectChanges();
    return { fixture, media, navigate, router };
  }

  it.each([768, 1024, 1366])('splits the frame at %ipx', async (width) => {
    const { fixture } = await setup(width);
    expect(fixture.nativeElement.querySelector('.app-frame--split')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.app-frame__empty').textContent).toContain('Select an item');
  });

  it('keeps a single column below 768px', async () => {
    const { fixture, media } = await setup(390);
    expect(fixture.nativeElement.querySelector('.app-frame--split')).toBeNull();
    media.setWidth(768);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.app-frame--split')).toBeTruthy();
  });

  it('moves between sessions with the arrow keys when the frame is split', async () => {
    const { fixture, navigate, router } = await setup(1024);
    await router.navigateByUrl('/projects/%2Fwork%2Fdemo/sessions/one');
    fixture.detectChanges();
    navigate.mockClear();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(navigate).toHaveBeenCalledWith(['/projects', '/work/demo', 'sessions', 'two']);
  });
});
