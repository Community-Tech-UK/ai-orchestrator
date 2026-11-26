import { Component, signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import { LearningScanIpcService } from '../../core/services/ipc/learning-scan-ipc.service';
import { InstanceStore } from '../../core/state/instance/instance.store';
import { AutomationStore } from '../../core/state/automation.store';
import { LoopStore } from '../../core/state/loop.store';
import { RepoJobStore } from '../../core/state/repo-job.store';
import { InstanceDetailComponent } from '../instance-detail/instance-detail.component';
import { MemoryReviewStore } from '../memory-review/memory-review.store';
import type { GovernedProposal } from '../memory-review/memory-review.types';
import { WorkboardPageComponent } from './workboard-page.component';
import { needsYouTestSources } from './needs-you.testing';

// The real page, request rows, Needs you projection and memory-review store
// render below; a session transcript is unrelated to a standalone memory review
// and is never opened.
await resolveComponentResources(() => Promise.resolve(''));

@Component({ selector: 'app-instance-detail', template: '' })
class InstanceDetailStubComponent {}

describe('Workboard memory-review push rendering', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
    localStorage.clear();
  });

  it.each(['approved', 'rejected'] as const)(
    'shows a pushed review in Needs You and drops it on a pushed %s decision before polling',
    async status => {
      vi.useFakeTimers();
      localStorage.clear();
      const now = Date.now();
      let proposals: GovernedProposal[] = [];
      let changed: (() => void) | undefined;
      const unsubscribe = vi.fn();
      const list = vi.fn(async () => ({ success: true, data: structuredClone(proposals) }));
      const router = { navigateByUrl: vi.fn() };
      const refreshLoops = vi.fn(async () => ({ ok: true }));

      TestBed.configureTestingModule({
        imports: [WorkboardPageComponent],
        providers: [
          ...needsYouTestSources(now),
          // The real store, so the push listener and list call run end to end.
          MemoryReviewStore,
          { provide: Router, useValue: router },
          { provide: InstanceStore, useValue: {
            instances: signal([]), setSelectedInstance: vi.fn(), selectedInstanceId: signal(null), getInstance: () => undefined,
          } },
          { provide: AutomationStore, useValue: {
            runs: signal([]), automations: signal([]), error: signal(null), refresh: vi.fn(async () => undefined),
          } },
          { provide: LoopStore, useValue: {
            recentRuns: signal([]), activeStates: signal(new Map()), banners: signal(new Map()),
            ensureWired: vi.fn(), refreshRecentRuns: refreshLoops,
          } },
          { provide: RepoJobStore, useValue: {
            jobs: signal([]), error: signal(null), refresh: vi.fn(async () => true),
          } },
          { provide: LearningScanIpcService, useValue: {} },
          { provide: InstanceIpcService, useValue: {} },
          { provide: ElectronIpcService, useValue: { getApi: () => ({
            governedProposalList: list,
            onMemoryReviewChanged: (callback: () => void) => { changed = callback; return unsubscribe; },
            setAttentionBadge: vi.fn(async () => ({ success: true })),
          }) } },
        ],
      });
      TestBed.overrideComponent(WorkboardPageComponent, {
        remove: { imports: [InstanceDetailComponent] },
        add: { imports: [InstanceDetailStubComponent] },
      });
      await TestBed.compileComponents();
      const fixture = TestBed.createComponent(WorkboardPageComponent);
      fixture.detectChanges();
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();
      const root: HTMLElement = fixture.nativeElement;
      const rows = () => root.querySelectorAll('.wb-lane[data-lane="needs-you"] .request-row');
      expect(rows()).toHaveLength(0);
      expect(list).toHaveBeenCalledTimes(1);

      proposals = [{
        id: 'review-disposable', kind: 'memory', status: 'pending', provenance: 'agent-derived',
        title: 'Review project note', description: '', payloadJson: '{}', sourceSessionId: null,
        sourceMessageId: null, createdAt: now, decidedAt: null, decidedBy: null,
        decisionRationale: null, reinforcements: 1, relatedIdsJson: '[]', tagsJson: '[]',
      }];
      expect(changed).toBeDefined();
      changed!();
      await vi.advanceTimersByTimeAsync(1000);
      fixture.detectChanges();
      expect(rows()).toHaveLength(1);
      expect(rows()[0].querySelector('.request-title')?.textContent).toBe('Review project note');
      expect(rows()[0].querySelector('.request-kind')?.textContent).toBe('Memory waiting for your review');

      proposals = [{ ...proposals[0], status, decidedAt: now + 1000, decidedBy: 'test-reviewer' }];
      changed!();
      await vi.advanceTimersByTimeAsync(1000);
      fixture.detectChanges();
      expect(rows()).toHaveLength(0);
      expect(list).toHaveBeenCalledTimes(3);
      // The page's four-second poll has not fired: both visible updates came
      // through the production IPC wrapper and MemoryReviewStore listener.
      expect(refreshLoops).toHaveBeenCalledTimes(1);
      fixture.destroy();
      TestBed.resetTestingModule();
      expect(unsubscribe).toHaveBeenCalledOnce();
    },
  );
});
