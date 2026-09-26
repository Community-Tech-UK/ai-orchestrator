import { readFileSync } from 'node:fs';
import { NO_ERRORS_SCHEMA, signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayClient } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';
import { MobileBrowseStateStore } from '../../core/mobile-browse-state.store';
import type { MobileHistorySessionDto, MobileMessageDto } from '../../core/models';
import { HistoryComponent, filterHistorySessions } from './history.component';
import { HistoryDetailComponent } from './history-detail.component';
import { TranscriptViewComponent } from '../conversation/transcript-view.component';

await resolveComponentResources(url => Promise.resolve(readFileSync(new URL('../conversation/' + url, import.meta.url), 'utf8')));

const session: MobileHistorySessionDto = { id: 'archive-a', name: 'Known older task', provider: 'codex', model: 'example-model', workingDirectory: '/work/example', projectName: 'example', createdAt: 1, lastActiveAt: 2, archived: true, live: false };
const message: MobileMessageDto = { id: 'message-a', timestamp: 1, type: 'assistant', content: 'Recorded answer' };
function setup() {
  const activeHost = signal({ id: 'host-a', name: 'Example host' });
  const historyMessages = vi.fn().mockResolvedValue([message]);
  const gateway = { dataHostId: () => activeHost().id, online: signal(true), historySessions: signal([session]), history: vi.fn().mockResolvedValue([session]), historyMessages, historyMessagePage: historyMessages };
  const router = { navigate: vi.fn(), getCurrentNavigation: () => ({ extras: { state: { mobileBrowseOrigin: { hostId: 'host-a', route: '/projects' } } } }) };
  TestBed.configureTestingModule({ providers: [{ provide: HostStore, useValue: { activeHost } }, { provide: GatewayClient, useValue: gateway }, { provide: Router, useValue: router }] });
  return { activeHost, gateway, router };
}
beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined); });
afterEach(() => vi.restoreAllMocks());

describe('History browsing', () => {
  it('searches project, title and model and returns live rows to their proper session', async () => {
    const { router, gateway } = setup();
    gateway.history.mockResolvedValue([{ ...session, live: true, instanceId: 'live-a' }]);
    TestBed.overrideComponent(HistoryComponent, { set: { imports: [], schemas: [NO_ERRORS_SCHEMA] } });
    const fixture = TestBed.createComponent(HistoryComponent);
    fixture.detectChanges(); await fixture.whenStable();
    expect(filterHistorySessions([session], 'EXAMPLE-MODEL')).toHaveLength(1);
    const search: HTMLInputElement = fixture.nativeElement.querySelector('input');
    search.value = 'Known older'; search.dispatchEvent(new Event('input')); fixture.detectChanges();
    fixture.nativeElement.querySelector('app-mobile-session-row').dispatchEvent(new Event('activate'));
    expect(router.navigate).toHaveBeenCalledWith(['/projects', '/work/example', 'sessions', 'live-a'], { state: { mobileBrowseOrigin: { hostId: 'host-a', route: '/history' } } });
    fixture.nativeElement.querySelector('.history-new').click();
    expect(router.navigate).toHaveBeenCalledWith(['/new-session'], { queryParams: { dir: '/work/example' }, state: { mobileBrowseOrigin: { hostId: 'host-a', route: '/history' }, mobileNewSessionPreset: { hostId: 'host-a', directory: '/work/example' } } });
  });

  it('keeps cached results visible when loading fails and retries without raw HTTP errors', async () => {
    const { gateway } = setup();
    gateway.history.mockRejectedValueOnce(new Error('HTTP 503'));
    TestBed.overrideComponent(HistoryComponent, { set: { imports: [], schemas: [NO_ERRORS_SCHEMA] } });
    const fixture = TestBed.createComponent(HistoryComponent);
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-mobile-session-row').row.id).toBe('archive-a');
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('could not be refreshed');
    expect(fixture.nativeElement.textContent).not.toContain('HTTP 503');
    fixture.nativeElement.querySelector('[role="alert"] button').click(); await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
    expect(gateway.history).toHaveBeenCalledTimes(2);
  });

  it('does not apply an old host response after a host switch', async () => {
    const { gateway, activeHost } = setup();
    let resolveOld!: (sessions: MobileHistorySessionDto[]) => void;
    gateway.history.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValue([]);
    TestBed.overrideComponent(HistoryComponent, { set: { imports: [], schemas: [NO_ERRORS_SCHEMA] } });
    const fixture = TestBed.createComponent(HistoryComponent);
    fixture.detectChanges();
    activeHost.set({ id: 'host-b', name: 'Other host' }); fixture.detectChanges(); await fixture.whenStable();
    resolveOld([session]); await Promise.resolve(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-mobile-session-row')).toBeNull();
  });
});

describe('History transcript', () => {
  it('retains explicit system and error labels in the shared archived transcript', async () => {
    const { gateway } = setup();
    gateway.historyMessagePage.mockResolvedValueOnce([
      { ...message, id: 'system', type: 'system', content: 'Session information' },
      { ...message, id: 'error', type: 'error', content: 'Provider failure' },
    ]);
    TestBed.overrideComponent(HistoryDetailComponent, { set: { imports: [TranscriptViewComponent], schemas: [NO_ERRORS_SCHEMA] } });
    const fixture = TestBed.createComponent(HistoryDetailComponent);
    fixture.componentRef.setInput('chatId', 'archive-a');
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.message.system .role')?.textContent).toBe('system');
    expect(fixture.nativeElement.querySelector('.message.error .role')?.textContent).toBe('error');
  });
  it('windows a long archived transcript and pages older messages through its history route', async () => {
    const { gateway } = setup();
    const makePage = (start: number, end: number) => ({
      messages: Array.from({ length: end - start }, (_, i) => ({ ...message, id: `m${start + i}`, seq: start + i, content: `Archived ${start + i}` })),
      meta: { fromSeq: -1, returned: end - start, maxSeq: end - 1, nextBeforeSeq: start, hasMore: start > 0 },
    });
    gateway.historyMessagePage.mockResolvedValueOnce(makePage(700, 1000).messages);
    TestBed.overrideComponent(HistoryDetailComponent, { set: { imports: [TranscriptViewComponent], schemas: [NO_ERRORS_SCHEMA] } });
    const fixture = TestBed.createComponent(HistoryDetailComponent);
    fixture.componentRef.setInput('chatId', 'archive-a');
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('.message')).toHaveLength(150);
    fixture.nativeElement.querySelector('[aria-label="Show earlier messages"]').click();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('.message')).toHaveLength(300);
    gateway.historyMessagePage.mockResolvedValueOnce(makePage(600, 700)).mockResolvedValueOnce(makePage(500, 600));
    fixture.nativeElement.querySelector('[aria-label="Show earlier messages"]').click();
    await fixture.whenStable();
    expect(gateway.historyMessagePage).toHaveBeenCalledWith('archive-a', 700);
    expect(gateway.historyMessagePage).toHaveBeenCalledWith('archive-a', 600);
    expect(fixture.nativeElement.querySelectorAll('.message')).toHaveLength(450);
  });
  it('returns to its safe browse origin and offers the session identity and fresh project action', async () => {
    const { router } = setup();
    TestBed.overrideComponent(HistoryDetailComponent, { set: { imports: [TranscriptViewComponent], schemas: [NO_ERRORS_SCHEMA] } });
    const fixture = TestBed.createComponent(HistoryDetailComponent);
    fixture.componentRef.setInput('chatId', 'archive-a');
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.session-identity').textContent).toContain('Known older task');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.mobile-transcript .message.assistant .content')?.textContent).toContain('Recorded answer');
    });
    fixture.nativeElement.querySelector('[aria-label="Back to projects"]').click();
    expect(router.navigate).toHaveBeenCalledWith(['/projects']);
    fixture.nativeElement.querySelector('.session-identity button').click();
    expect(router.navigate).toHaveBeenCalledWith(['/new-session'], { queryParams: { dir: '/work/example' }, state: { mobileBrowseOrigin: { hostId: 'host-a', route: '/projects' }, mobileNewSessionPreset: { hostId: 'host-a', directory: '/work/example' } } });
  });

  it('never labels a failed transcript load as an empty conversation and permits Retry', async () => {
    const { gateway } = setup();
    gateway.historyMessages.mockRejectedValueOnce(new Error('HTTP 503'));
    TestBed.overrideComponent(HistoryDetailComponent, { set: { imports: [TranscriptViewComponent], schemas: [NO_ERRORS_SCHEMA] } });
    const fixture = TestBed.createComponent(HistoryDetailComponent);
    fixture.componentRef.setInput('chatId', 'archive-a');
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain('The transcript could not be loaded');
    });
    expect(fixture.nativeElement.textContent).not.toContain('no recorded messages');
    fixture.nativeElement.querySelector('[role="alert"] button').click(); await fixture.whenStable(); fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain('Recorded answer');
    });
    expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
  });
});

function historyGeometry() {
  let maxScroll = 100;
  let position = 0;
  vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockImplementation(() => window.innerHeight + maxScroll);
  vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => position);
  vi.mocked(window.scrollTo).mockImplementation((options?: ScrollToOptions | number, y?: number) => {
    position = Math.max(0, Math.min(maxScroll, typeof options === 'number' ? y ?? 0 : options?.top ?? position));
    window.dispatchEvent(new Event('scroll'));
  });
  return { grow: () => { maxScroll = 4000; }, userScroll: () => { position = 60; window.dispatchEvent(new Event('scroll')); } };
}

function delayedHistoryBrowse(cached = true) {
  const { gateway } = setup();
  if (!cached) gateway.historySessions.set([]);
  let complete!: (sessions: MobileHistorySessionDto[]) => void;
  gateway.history.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
  TestBed.overrideComponent(HistoryComponent, { set: { imports: [], schemas: [NO_ERRORS_SCHEMA] } });
  const browse = TestBed.inject(MobileBrowseStateStore);
  browse.save('/history', { ...browse.read('/history'), scrollTop: 3000 });
  const fixture = TestBed.createComponent(HistoryComponent);
  return { fixture, complete, browse };
}

describe('History delayed restoration and identity recovery', () => {
  it('waits for fresh history beyond the short cached list before restoring the saved scroll', async () => {
    const geometry = historyGeometry();
    const { fixture, complete } = delayedHistoryBrowse();
    fixture.detectChanges(); await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-mobile-session-row')).not.toBeNull();
    expect(window.scrollTo).not.toHaveBeenCalled();
    geometry.grow(); complete([session, { ...session, id: 'archive-b' }]);
    await fixture.whenStable(); fixture.detectChanges();
    expect(window.scrollY).toBe(3000);
  });

  it('settles at the reachable position when fresh history stays short', async () => {
    historyGeometry();
    const { fixture, complete, browse } = delayedHistoryBrowse();
    fixture.detectChanges(); await fixture.whenStable();
    expect(window.scrollTo).not.toHaveBeenCalled();
    complete([session]); await fixture.whenStable(); fixture.detectChanges();
    expect(window.scrollY).toBe(100);
    fixture.destroy(); expect(browse.read('/history').scrollTop).toBe(100);
  });

  it.each(['wheel', 'touchmove', 'pointerdown', 'keyboard'])('keeps deliberate %s scrolling when fresh history arrives', async (gesture) => {
    const geometry = historyGeometry();
    const { fixture, complete, browse } = delayedHistoryBrowse(false);
    fixture.detectChanges(); await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-mobile-session-row')).toBeNull();
    expect(window.scrollTo).not.toHaveBeenCalled();
    window.dispatchEvent(gesture === 'keyboard' ? new KeyboardEvent('keydown', { key: 'PageDown' }) : new Event(gesture));
    geometry.userScroll(); geometry.grow(); complete([session, { ...session, id: 'archive-b' }]);
    await fixture.whenStable(); fixture.detectChanges();
    expect(window.scrollY).toBe(60);
    fixture.destroy(); expect(browse.read('/history').scrollTop).toBe(60);
  });

  it('shows identity loading and failure separately, then retries details without reloading the usable transcript', async () => {
    const { gateway } = setup();
    gateway.historySessions.set([]);
    let rejectIdentity!: (error: Error) => void;
    gateway.history.mockReturnValueOnce(new Promise((_, reject) => { rejectIdentity = reject; }));
    TestBed.overrideComponent(HistoryDetailComponent, { set: { imports: [TranscriptViewComponent], schemas: [NO_ERRORS_SCHEMA] } });
    const fixture = TestBed.createComponent(HistoryDetailComponent);
    fixture.componentRef.setInput('chatId', 'archive-a');
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Loading session details');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.mobile-transcript').textContent).toContain('Recorded answer');
    });
    rejectIdentity(new Error('HTTP 503')); await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.identity-feedback[role="alert"]').textContent).toContain('Session details could not be loaded');
    const content = fixture.nativeElement.querySelector('.mobile-transcript .content');
    fixture.nativeElement.querySelector('.identity-feedback button').click(); await fixture.whenStable(); fixture.detectChanges();
    expect(gateway.historyMessages).toHaveBeenCalledTimes(1);
    expect(fixture.nativeElement.querySelector('.mobile-transcript .content')).toBe(content);
    expect(fixture.nativeElement.querySelector('.session-identity').textContent).toContain('Known older task');
    expect(fixture.nativeElement.querySelector('.session-identity button').textContent).toContain('Start a new session');
    expect(fixture.nativeElement.querySelector('.identity-feedback[role="alert"]')).toBeNull();
  });

  it('preserves cached session identity and its project action when metadata refresh fails', async () => {
    const { gateway } = setup();
    gateway.history.mockRejectedValueOnce(new Error('HTTP 503'));
    TestBed.overrideComponent(HistoryDetailComponent, { set: { imports: [TranscriptViewComponent], schemas: [NO_ERRORS_SCHEMA] } });
    const fixture = TestBed.createComponent(HistoryDetailComponent);
    fixture.componentRef.setInput('chatId', 'archive-a');
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.identity-feedback[role="alert"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.session-identity').textContent).toContain('Known older task');
    expect(fixture.nativeElement.querySelector('.session-identity button')).not.toBeNull();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.mobile-transcript').textContent).toContain('Recorded answer');
    });
  });

  it('rejects an old host identity response after the same detail id loads on another host', async () => {
    const { gateway, activeHost } = setup();
    gateway.historySessions.set([]);
    let completeOld!: (sessions: MobileHistorySessionDto[]) => void;
    gateway.history.mockReturnValueOnce(new Promise((resolve) => { completeOld = resolve; }));
    TestBed.overrideComponent(HistoryDetailComponent, { set: { imports: [TranscriptViewComponent], schemas: [NO_ERRORS_SCHEMA] } });
    const fixture = TestBed.createComponent(HistoryDetailComponent);
    fixture.componentRef.setInput('chatId', 'archive-a');
    fixture.detectChanges(); await fixture.whenStable();
    gateway.history.mockResolvedValue([{ ...session, name: 'Other host task' }]);
    activeHost.set({ id: 'host-b', name: 'Other host' });
    fixture.detectChanges(); await fixture.whenStable();
    completeOld([session]); await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.session-identity').textContent).toContain('Other host task');
    expect(fixture.nativeElement.querySelector('.session-identity').textContent).not.toContain('Known older task');
  });
});
