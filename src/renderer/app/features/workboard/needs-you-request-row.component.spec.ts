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
import { SessionWatcherStore } from '../../core/state/session-watcher.store';
import type { SessionWatcherFlagPayload } from '@contracts/schemas/session-watcher';

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

describe('NeedsYouRequestRowComponent for a session the watcher handed back', () => {
  const answerYes = vi.fn<(flag: unknown) => Promise<string | null>>();
  const openSession = vi.fn();
  const flags = signal<SessionWatcherFlagPayload[]>([]);
  const flag = (overrides: Partial<SessionWatcherFlagPayload> = {}): SessionWatcherFlagPayload => ({
    instanceId: 'inst-1', requestCount: 4, question: 'Shall I push it?', closing: 'I have finished the change.\nShall I push it?',
    stop: 'asked_to_continue', acceptsYes: true, since: 1, ...overrides,
  });
  const entry = { key: 'session-question:inst-1', source: 'session-question', kind: 'answer', title: 'Fix login', detail: 'Asked you: Shall I push it?', instanceId: 'inst-1', since: 1, version: '4' } as const;
  const render = (flagValue: SessionWatcherFlagPayload | null) => {
    flags.set(flagValue ? [flagValue] : []);
    const fixture = TestBed.createComponent(NeedsYouRequestRowComponent);
    fixture.componentRef.setInput('entry', entry);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const buttons = () => [...element.querySelectorAll('button')] as HTMLButtonElement[];
    return { fixture, element, buttons, yes: () => buttons().find((b) => b.textContent?.trim() === 'Yes, go ahead') };
  };
  beforeEach(() => {
    vi.clearAllMocks();
    answerYes.mockResolvedValue(null);
    TestBed.configureTestingModule({ imports: [NeedsYouRequestRowComponent], providers: [
      { provide: NeedsYouStore, useValue: { outstanding: signal([]), markSeen: vi.fn() } },
      { provide: LoopIpcService, useValue: {} },
      { provide: SessionNavigator, useValue: { openSession } },
      { provide: SideChatStore, useValue: { attentionList: () => [] } },
      { provide: PermissionApprovalsStore, useValue: { now: signal(1000) } },
      { provide: Router, useValue: { navigateByUrl: vi.fn() } },
      { provide: ToolLoopAlertStore, useValue: { isStopping: () => false } },
      { provide: SessionWatcherStore, useValue: { flagFor: (id: string) => flags().find((item) => item.instanceId === id), answerYes } },
    ] });
  });
  afterEach(() => TestBed.resetTestingModule());

  it('shows the agent\'s closing paragraph and a "Yes, go ahead" button when a yes would answer it', () => {
    const { element, yes } = render(flag());
    expect(element.querySelector('.request-closing')?.textContent).toBe('I have finished the change.\nShall I push it?');
    expect(yes()).toBeDefined();
    expect(yes()?.getAttribute('aria-label')).toBe('Yes, go ahead: Fix login');
  });

  it('shows only Open when the flag does not take a yes', () => {
    const { element, buttons, yes } = render(flag({ acceptsYes: false, stop: 'offered_choice' }));
    expect(yes()).toBeUndefined();
    expect(element.querySelector('.request-closing')).toBeNull();
    expect(buttons().map((b) => b.textContent?.trim())).toEqual(['Open']);
  });

  it('shows only Open when there is no flag behind the entry', () => {
    const { buttons } = render(null);
    expect(buttons().map((b) => b.textContent?.trim())).toEqual(['Open']);
  });

  it('ties the consequence line to the yes button for screen readers', () => {
    const { element, yes } = render(flag({ stop: 'asked_to_continue' }));
    const describedBy = yes()?.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(element.querySelector(`#${describedBy}`)?.textContent).toBe('This approves the step the agent asked about.');
  });

  it('says what the yes approves beside every yes button, whatever the judge called the stop', () => {
    expect(render(flag({ stop: 'asked_before_outward_step' })).element.textContent).toContain('This approves the step the agent asked about.');
    expect(render(flag({ stop: 'asked_to_continue' })).element.textContent).toContain('This approves the step the agent asked about.');
    expect(render(flag({ acceptsYes: false, stop: 'offered_choice' })).element.textContent).not.toContain('This approves the step');
  });

  it('shows the closing paragraph as text, never as markup', () => {
    const { element } = render(flag({ closing: '<img src=x onerror="alert(1)"><b>Push it?</b>' }));
    expect(element.querySelector('.request-closing img')).toBeNull();
    expect(element.querySelector('.request-closing b')).toBeNull();
    expect(element.querySelector('.request-closing')?.textContent).toBe('<img src=x onerror="alert(1)"><b>Push it?</b>');
  });

  it('sends the click for exactly the stop that is shown', async () => {
    const { fixture, yes } = render(flag());
    yes()!.click(); await fixture.whenStable();
    expect(answerYes).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'inst-1', requestCount: 4 }));
  });

  it('shows why when the yes was refused', async () => {
    answerYes.mockResolvedValueOnce('This question has already been dealt with. Nothing was sent.');
    const { fixture, element, yes } = render(flag());
    yes()!.click(); await fixture.whenStable(); fixture.detectChanges();
    expect(element.querySelector('[role="alert"]')?.textContent).toBe('This question has already been dealt with. Nothing was sent.');
  });
});
