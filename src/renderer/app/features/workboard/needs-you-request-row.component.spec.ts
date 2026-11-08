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

await resolveComponentResources((url) => Promise.resolve(url.endsWith('.html') || url.endsWith('.scss')
  ? readFileSync(resolve('src/renderer/app/features/loop', url), 'utf8') : ''));

describe('NeedsYouRequestRowComponent', () => {
  const answerOutstanding = vi.fn().mockResolvedValue({ success: true, data: { ok: true, delivery: 'recorded' } });
  const refreshOutstanding = vi.fn(), openSession = vi.fn();
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
    ] });
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
  it('adds no kind line when the title already says what is asked', () => {
    const fixture = TestBed.createComponent(NeedsYouRequestRowComponent);
    fixture.componentRef.setInput('entry', { key: 'tool-loop:a', source: 'tool-loop', kind: 'answer', title: 'Repeated tool calls need your decision', detail: 'Bash', instanceId: 'a', since: 1, version: '1' });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.request-kind')).toBeNull();
  });
});
