import { NO_ERRORS_SCHEMA, signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalPresentationStore } from '../../core/approval-presentation.store';
import { GatewayClient } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';
import { MobileBrowseStateStore } from '../../core/mobile-browse-state.store';
import type { MobileHistorySessionDto, MobileSnapshot } from '../../core/models';
import { ProjectsComponent } from './projects.component';

await resolveComponentResources(() => Promise.resolve(''));

const snapshot: MobileSnapshot = {
  hostName: 'Example host', serverTime: 1, projects: [], prompts: [],
  pause: { isPaused: false, reasons: [], pausedAt: null, lastChange: 0 },
  instances: [{ id: 'session-a', displayName: 'A long session title that should remain readable on a narrow phone', status: 'busy', provider: 'codex', workingDirectory: '/work/example', projectName: 'example', createdAt: 1, lastActivity: 1, pendingApprovalCount: 0, hasUnreadCompletion: false }],
};

function setup(savedScrollTop = 0) {
  const activeHost = signal({ id: 'host-a', name: 'Example host' });
  const gateway = { historyState: signal({ status: 'loaded', error: null }), loadHistory: vi.fn(), dataHostId: () => activeHost().id, snapshot: signal(snapshot), state: signal('connected'), online: signal(true), historySessions: signal<MobileHistorySessionDto[]>([]), pause: signal(snapshot.pause), recentDirs: vi.fn().mockResolvedValue([]), setPause: vi.fn().mockResolvedValue(undefined) };
  const approvals = { requests: signal([{ id: 'request-a' }]), open: vi.fn() };
  const navigate = vi.fn();
  TestBed.configureTestingModule({ imports: [ProjectsComponent], providers: [
    { provide: HostStore, useValue: { activeHost } }, { provide: GatewayClient, useValue: gateway },
    { provide: Router, useValue: { navigate } }, { provide: ApprovalPresentationStore, useValue: approvals },
  ] });
  TestBed.overrideComponent(ProjectsComponent, { set: { imports: [], schemas: [NO_ERRORS_SCHEMA], styleUrls: [], styles: [] } });
  const browse = TestBed.inject(MobileBrowseStateStore);
  browse.save('/projects', { ...browse.read('/projects'), scrollTop: savedScrollTop });
  const fixture = TestBed.createComponent(ProjectsComponent);
  return { fixture, activeHost, gateway, approvals, navigate, browse: TestBed.inject(MobileBrowseStateStore) };
}

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined); });
afterEach(() => vi.restoreAllMocks());

describe('Projects browse behavior', () => {
  it('reopens requests and records a safe browse origin when opening sessions', async () => {
    const { fixture, approvals, navigate } = setup();
    fixture.detectChanges(); await fixture.whenStable();
    fixture.nativeElement.querySelector('.projects-needs-you').click();
    expect(approvals.open).toHaveBeenCalledOnce();
    fixture.nativeElement.querySelector('app-mobile-session-row').dispatchEvent(new Event('activate'));
    expect(navigate).toHaveBeenCalledWith(['/projects', '/work/example', 'sessions', 'session-a'], { state: { mobileBrowseOrigin: { hostId: 'host-a', route: '/projects' } } });
  });

  it('binds the project folder preset to its originating host', async () => {
    const { fixture, navigate } = setup();
    fixture.detectChanges(); await fixture.whenStable();
    fixture.nativeElement.querySelector('.project-compose').click();
    expect(navigate).toHaveBeenCalledWith(['/new-session'], {
      queryParams: { dir: '/work/example' },
      state: { mobileBrowseOrigin: { hostId: 'host-a', route: '/projects' }, mobileNewSessionPreset: { hostId: 'host-a', directory: '/work/example' } },
    });
  });

  it('restores query and disclosure after returning and keeps the next host clean', async () => {
    const { fixture, activeHost, browse } = setup();
    fixture.detectChanges(); await fixture.whenStable();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('input[type=search]');
    input.value = 'long session'; input.dispatchEvent(new Event('input'));
    fixture.nativeElement.querySelector('.project-disclosure').click();
    fixture.detectChanges();
    activeHost.set({ id: 'host-b', name: 'Other host' });
    fixture.detectChanges(); await fixture.whenStable();
    expect(input.value).toBe('');
    expect(browse.read('/projects', 'host-a')).toMatchObject({ query: 'long session', expandedKeys: [] });
    activeHost.set({ id: 'host-a', name: 'Example host' });
    fixture.detectChanges(); await fixture.whenStable();
    expect(input.value).toBe('long session');
    expect(fixture.nativeElement.querySelector('.project-disclosure').getAttribute('aria-expanded')).toBe('false');
  });

  it('restores saved results and scroll after the browse component is recreated', async () => {
    const geometry = scrollGeometry(1000);
    const { fixture, browse } = setup();
    fixture.detectChanges(); await fixture.whenStable();
    const search: HTMLInputElement = fixture.nativeElement.querySelector('input[type=search]');
    search.value = 'long session'; search.dispatchEvent(new Event('input'));
    geometry.userScroll(740);
    fixture.destroy();
    expect(browse.read('/projects').scrollTop).toBe(740);
    const returned = TestBed.createComponent(ProjectsComponent);
    returned.detectChanges(); await returned.whenStable();
    expect(returned.nativeElement.querySelector('input[type=search]').value).toBe('long session');
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 740, behavior: 'instant' });
  });

  it('holds row updates through pointer-down and reports rejected Pause with Retry', async () => {
    const { fixture, gateway } = setup();
    fixture.detectChanges(); await fixture.whenStable();
    fixture.nativeElement.querySelector('.project-group').dispatchEvent(new Event('pointerdown'));
    gateway.snapshot.set({ ...snapshot, instances: [{ ...snapshot.instances[0], displayName: 'Changed title' }] });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-mobile-session-row').row.title).not.toBe('Changed title');
    fixture.nativeElement.querySelector('.project-group').dispatchEvent(new Event('pointercancel'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-mobile-session-row').row.title).toBe('Changed title');
    gateway.setPause.mockRejectedValueOnce(new Error('HTTP 503'));
    fixture.nativeElement.querySelector('[aria-label="More options"]').click(); fixture.detectChanges();
    const pause = [...fixture.nativeElement.querySelectorAll('button')].find((button) => (button as HTMLButtonElement).textContent?.includes('Pause agents')) as HTMLButtonElement;
    pause.click(); await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('Could not pause agents');
    expect(fixture.nativeElement.textContent).not.toContain('HTTP 503');
    fixture.nativeElement.querySelector('[role="alert"] button').click(); await fixture.whenStable();
    expect(gateway.setPause).toHaveBeenCalledTimes(2);
  });
});

function scrollGeometry(initialMaxScroll: number) {
  let maxScroll = initialMaxScroll;
  let position = 0;
  vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockImplementation(() => window.innerHeight + maxScroll);
  vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => position);
  vi.mocked(window.scrollTo).mockImplementation((options?: ScrollToOptions | number, y?: number) => {
    const requested = typeof options === 'number' ? y ?? 0 : options?.top ?? position;
    position = Math.max(0, Math.min(maxScroll, requested));
    window.dispatchEvent(new Event('scroll'));
  });
  return {
    grow: (height: number) => { maxScroll = height; },
    userScroll: (top: number) => { position = top; window.dispatchEvent(new Event('scroll')); },
  };
}

const delayedArchive: MobileHistorySessionDto = { id: 'past-a', name: 'Delayed history', provider: 'codex', model: null, workingDirectory: '/work/archive', projectName: 'archive', createdAt: 1, lastActiveAt: 1, archived: true, live: false };

describe('Projects delayed scroll restoration', () => {
  it('waits for delayed rows to make the saved position reachable instead of consuming a clamped scroll', async () => {
    const geometry = scrollGeometry(100);
    const { fixture, gateway } = setup(3000);
    gateway.historyState.set({ status: 'loading', error: null });
    fixture.detectChanges(); await fixture.whenStable();
    expect(window.scrollY).toBe(0);
    expect(window.scrollTo).not.toHaveBeenCalled();
    geometry.grow(4000);
    gateway.historySessions.set([delayedArchive]);
    gateway.historyState.set({ status: 'loaded', error: null });
    fixture.detectChanges(); await fixture.whenStable();
    expect(window.scrollY).toBe(3000);
  });

  it('also waits for a delayed recent-directory response when history has already settled', async () => {
    const geometry = scrollGeometry(100);
    const { fixture, gateway } = setup(3000);
    let resolveDirectories!: (value: []) => void;
    gateway.recentDirs.mockReturnValueOnce(new Promise((resolve) => { resolveDirectories = resolve; }));
    fixture.detectChanges(); await fixture.whenStable();
    expect(window.scrollTo).not.toHaveBeenCalled();
    geometry.grow(4000);
    resolveDirectories([]);
    await fixture.whenStable(); fixture.detectChanges();
    expect(window.scrollY).toBe(3000);
  });

  it('uses the reachable position once remaining loads settle with shorter content', async () => {
    scrollGeometry(100);
    const { fixture, gateway, browse } = setup(3000);
    gateway.historyState.set({ status: 'loading', error: null });
    fixture.detectChanges(); await fixture.whenStable();
    expect(window.scrollTo).not.toHaveBeenCalled();
    gateway.historyState.set({ status: 'loaded', error: null });
    fixture.detectChanges(); await fixture.whenStable();
    expect(window.scrollY).toBe(100);
    fixture.destroy();
    expect(browse.read('/projects').scrollTop).toBe(100);
  });

  it.each(['wheel', 'touchmove', 'pointerdown'])('keeps a deliberate %s scroll when delayed history arrives', async (gesture) => {
    const geometry = scrollGeometry(100);
    const { fixture, gateway, browse } = setup(3000);
    gateway.historyState.set({ status: 'loading', error: null });
    fixture.detectChanges(); await fixture.whenStable();
    expect(window.scrollTo).not.toHaveBeenCalled();
    window.dispatchEvent(new Event(gesture));
    geometry.userScroll(60);
    geometry.grow(4000);
    gateway.historySessions.set([delayedArchive]);
    gateway.historyState.set({ status: 'loaded', error: null });
    fixture.detectChanges(); await fixture.whenStable();
    expect(window.scrollY).toBe(60);
    fixture.destroy();
    expect(browse.read('/projects').scrollTop).toBe(60);
  });

  it('keeps a deliberate keyboard scroll when delayed history arrives', async () => {
    const geometry = scrollGeometry(100);
    const { fixture, gateway } = setup(3000);
    gateway.historyState.set({ status: 'loading', error: null });
    fixture.detectChanges(); await fixture.whenStable();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }));
    geometry.userScroll(60);
    geometry.grow(4000);
    gateway.historySessions.set([delayedArchive]);
    gateway.historyState.set({ status: 'loaded', error: null });
    fixture.detectChanges(); await fixture.whenStable();
    expect(window.scrollY).toBe(60);
    expect(window.scrollTo).not.toHaveBeenCalled();
  });
});
