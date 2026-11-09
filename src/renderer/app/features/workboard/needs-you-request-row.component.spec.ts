import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeedsYouRequestRowComponent } from './needs-you-request-row.component';
import { NeedsYouStore } from './needs-you.store';
import { LoopIpcService } from '../../core/services/ipc/loop-ipc.service';
import { SessionNavigator } from '../../core/services/session-navigator.service';
import { SideChatStore } from '../../core/state/side-chat.store';
import { PermissionApprovalsStore } from '../../core/state/permission-approvals.store';
import { ToolLoopAlertStore } from '../../core/state/tool-loop-alert.store';

await resolveComponentResources((url) => Promise.resolve(url.endsWith('.html') || url.endsWith('.scss')
  ? readFileSync(resolve('src/renderer/app/features/loop', url), 'utf8') : ''));

describe('NeedsYouRequestRowComponent', () => {
  const answerOutstanding = vi.fn().mockResolvedValue({ success: true, data: { ok: true, delivery: 'recorded' } });
  const refreshOutstanding = vi.fn(), openSession = vi.fn();
  const stopTurn = vi.fn<(id: string) => Promise<boolean>>(), letContinue = vi.fn();
  const stopping = signal(new Set<string>());
  const item = { id: 'd', kind: 'decision-applied', status: 'open', text: 'Use the existing helper', recommendedAnswer: 'Use helper', firstSeenRound: 1 };
  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({ imports: [NeedsYouRequestRowComponent], providers: [
      { provide: NeedsYouStore, useValue: { outstanding: signal([item]), refreshOutstanding, markSeen: vi.fn() } },
      { provide: LoopIpcService, useValue: { answerOutstanding } },
      { provide: SessionNavigator, useValue: { openSession } },
      { provide: SideChatStore, useValue: { attentionList: () => [] } },
      { provide: PermissionApprovalsStore, useValue: { now: signal(1000) } },
      { provide: Router, useValue: { navigateByUrl: vi.fn() } },
      { provide: ToolLoopAlertStore, useValue: { stopTurn, letContinue, isStopping: (id: string) => stopping().has(id) } },
    ] });
    stopTurn.mockResolvedValue(true);
    stopping.set(new Set());
  });
  afterEach(() => TestBed.resetTestingModule());
  it('uses the real B5 row and commands for Looks right and one-click Undo', async () => {
    const fixture = TestBed.createComponent(NeedsYouRequestRowComponent);
    fixture.componentRef.setInput('entry', { key: 'loop-decision:d', source: 'loop-decision', kind: 'applied', title: 'Decision applied, tell me if wrong', since: 1, version: '1' });
    fixture.detectChanges();
    const find = (label: string) => [...fixture.nativeElement.querySelectorAll('button')].find((b) => (b as HTMLButtonElement).textContent?.trim() === label) as HTMLButtonElement;
    find('Looks right').click(); await fixture.whenStable();
    expect(answerOutstanding).toHaveBeenCalledWith({ id: 'd', action: 'keep', expectedRecommendation: 'Use helper' });
    fixture.detectChanges(); find('Undo').click(); await fixture.whenStable();
    expect(answerOutstanding).toHaveBeenLastCalledWith({ id: 'd', action: 'undo', expectedRecommendation: 'Use helper', response: '' });
    expect(refreshOutstanding).toHaveBeenCalledTimes(2);
  });
  it('renders an approval deadline and opens its requesting session', () => {
    const fixture = TestBed.createComponent(NeedsYouRequestRowComponent);
    fixture.componentRef.setInput('entry', { key: 'permission-request:r', source: 'permission-request', kind: 'answer', title: 'Allow tool', detail: 'Bash', instanceId: 'a', deadlineAt: 61_000, since: 1, version: '1' });
    fixture.detectChanges(); expect(fixture.nativeElement.textContent).toContain('Expires in 1 min');
    fixture.nativeElement.querySelector('button').click(); expect(openSession).toHaveBeenCalledWith('a');
  });
  it('says a bare document title is waiting for review and offers Review on its own control', () => {
    const fixture = TestBed.createComponent(NeedsYouRequestRowComponent);
    fixture.componentRef.setInput('entry', { key: 'doc-review:x', source: 'doc-review', kind: 'answer', title: 'MiMo: decide the renewal', route: '/doc-review', since: 1, version: '1' });
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.request-kind')?.textContent).toBe('Document waiting for your review');
    expect(element.querySelector('.request-title')?.textContent).toBe('MiMo: decide the renewal');
    const button = element.querySelector('.request-actions button') as HTMLButtonElement;
    expect(button.textContent).toBe('Review');
    expect(button.getAttribute('aria-label')).toBe('Review MiMo: decide the renewal');
  });
  const toolLoopEntry = { key: 'tool-loop:a', source: 'tool-loop', kind: 'answer', title: 'May be stuck: stop it or let it continue',
    detail: 'It has run Bash 12 times in a row and got the same result each time.', instanceId: 'a', since: 1, version: '1' } as const;
  const toolLoopRow = () => {
    const fixture = TestBed.createComponent(NeedsYouRequestRowComponent);
    fixture.componentRef.setInput('entry', toolLoopEntry);
    fixture.detectChanges();
    const find = (label: string) => [...fixture.nativeElement.querySelectorAll('button')].find((b) => (b as HTMLButtonElement).textContent?.trim() === label) as HTMLButtonElement | undefined;
    return { fixture, find };
  };
  it('adds no kind line when the title already says what is asked', () => {
    const { fixture } = toolLoopRow();
    expect((fixture.nativeElement as HTMLElement).querySelector('.request-kind')).toBeNull();
  });
  it('lets a possibly stuck session be stopped or left running from the card itself', async () => {
    const { fixture, find } = toolLoopRow();
    expect([...fixture.nativeElement.querySelectorAll('.request-actions button')].map((b) => (b as HTMLButtonElement).textContent?.trim()))
      .toEqual(['Stop this turn', 'Let it continue', 'Open']);
    // A screen reader hears which session each choice is about.
    expect(find('Stop this turn')?.getAttribute('aria-label')).toBe('Stop this turn: May be stuck: stop it or let it continue');
    find('Let it continue')!.click();
    expect(letContinue).toHaveBeenCalledWith('a');
    expect(stopTurn).not.toHaveBeenCalled();
    find('Stop this turn')!.click(); await fixture.whenStable();
    expect(stopTurn).toHaveBeenCalledWith('a');
    expect(openSession).not.toHaveBeenCalled();
  });
  it('says what letting it continue means, and disables both choices while a stop started anywhere is running', () => {
    const { fixture, find } = toolLoopRow();
    expect(fixture.nativeElement.textContent).toContain("If you let it continue, it keeps working and you won't be asked about this again this turn.");
    stopping.set(new Set(['a'])); fixture.detectChanges();
    expect(find('Stopping…')?.disabled).toBe(true);
    expect(find('Let it continue')?.disabled).toBe(true);
  });
  it('says so when the stuck session will not stop', async () => {
    stopTurn.mockResolvedValueOnce(false);
    const { fixture, find } = toolLoopRow();
    find('Stop this turn')!.click(); await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent).toBe('Could not stop this turn. Open the session and use Stop.');
    // A newer detection for the same session is a new question; the old failure does not carry over.
    fixture.componentRef.setInput('entry', { ...toolLoopEntry, version: '2' }); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
  });
});
