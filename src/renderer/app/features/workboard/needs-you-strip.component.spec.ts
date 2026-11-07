import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sortNeedsYou, type NeedsYouEntry } from '../../../../shared/attention/needs-you';
import { requestEntries } from './needs-you-sources';
import { NeedsYouStore } from './needs-you.store';
import { NeedsYouStripComponent } from './needs-you-strip.component';
import { InstanceStore } from '../../core/state/instance.store';
import { PendingRequestStore } from '../../core/state/pending-request.store';
import { SessionNavigator } from '../../core/services/session-navigator.service';

describe('NeedsYouStripComponent', () => {
  const entries = signal<NeedsYouEntry[]>([]), selectedInstanceId = signal<string | null>(null);
  const openSession = vi.fn(), navigateByUrl = vi.fn();
  beforeEach(() => {
    entries.set([]); selectedInstanceId.set(null); vi.clearAllMocks();
    TestBed.configureTestingModule({ imports: [NeedsYouStripComponent], providers: [
      { provide: NeedsYouStore, useValue: { answerEntries: entries } },
      { provide: InstanceStore, useValue: { selectedInstanceId } },
      { provide: PendingRequestStore, useValue: { forInstance: () => [{ kind: 'permission', toolName: 'Bash' }] } },
      { provide: SessionNavigator, useValue: { openSession } }, { provide: Router, useValue: { navigateByUrl } },
    ] });
  });
  afterEach(() => TestBed.resetTestingModule());
  const entry = (source: NeedsYouEntry['source'], instanceId = 'a'): NeedsYouEntry => ({ key: source, source, instanceId, title: 'Fix login', since: 1, version: '1', kind: 'answer' });
  it('hides with no answers, in the open session, and for every timed banner source', () => {
    const fixture = TestBed.createComponent(NeedsYouStripComponent); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('section')).toBeNull();
    entries.set(['permission-request', 'browser-approval', 'paid-fallback'].map((source) => entry(source as NeedsYouEntry['source'])));
    fixture.detectChanges(); expect(fixture.nativeElement.querySelector('section')).toBeNull();
    selectedInstanceId.set('a'); entries.set([entry('session')]);
    fixture.detectChanges(); expect(fixture.nativeElement.querySelector('section')).toBeNull();
  });
  it('names the pending permission and opens the session or the complete board', () => {
    entries.set([entry('session')]);
    const fixture = TestBed.createComponent(NeedsYouStripComponent); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('‘Fix login’ wants permission to use Bash');
    const buttons = fixture.nativeElement.querySelectorAll('button'); buttons[0].click(); buttons[1].click();
    expect(openSession).toHaveBeenCalledWith('a'); expect(navigateByUrl).toHaveBeenCalledWith('/work');
  });
  it.each(['plan-queue-question', 'doc-review', 'loop-question', 'tool-loop'] as const)('keeps the %s notice title instead of treating it as a session name', source => {
    entries.set([{ ...entry(source), title: 'Review the proposed change' }]);
    const fixture = TestBed.createComponent(NeedsYouStripComponent); fixture.detectChanges();
    expect(fixture.componentInstance.line()).toBe('Review the proposed change');
    expect(fixture.nativeElement.textContent).not.toContain('wants permission');
  });
  it.each([
    ['sidechat', 'Sidechat'], ['loop-run', 'Loop'], ['automation-run', 'Automation'], ['repo-job', 'Repository job'],
  ] as const)('explains what needs attention when %s supplies a bare name', (source, label) => {
    entries.set([entry(source)]);
    const fixture = TestBed.createComponent(NeedsYouStripComponent); fixture.detectChanges();
    expect(fixture.componentInstance.line()).toBe(`${label} needs you: Fix login`);
    expect(fixture.nativeElement.textContent).not.toContain('wants permission');
  });
  it('puts the older untimed question in front of a newer sidechat after timed banners are excluded', () => {
    entries.set(sortNeedsYou(requestEntries({
      permissions: [{ id: 'timed', instanceId: 'timed-session', description: 'Allow', createdAt: 900, expiresAt: 2_000 }],
      browsers: [], fallbacks: [], plans: [], documents: [], memories: [],
      sidechats: [{ parent: { kind: 'chat', chatId: 'parent' }, parentTitle: 'Sidechat', needsAttention: 1, attentionSince: 500 }],
      outstanding: [{ id: 'older', kind: 'needs-human', status: 'open', riskClass: null, firstSeenRound: 1,
        userResponse: null, text: 'Older question', createdAt: 100, updatedAt: 100, chatId: 'older-session' }],
      toolLoops: [],
    }, 1_000)));
    const fixture = TestBed.createComponent(NeedsYouStripComponent); fixture.detectChanges();
    expect(fixture.componentInstance.front()?.key).toBe('loop-question:older');
    expect(fixture.componentInstance.eligible().map(item => item.source)).toEqual(['loop-question', 'sidechat']);
    (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click();
    expect(openSession).toHaveBeenCalledWith('older-session');
  });
});
