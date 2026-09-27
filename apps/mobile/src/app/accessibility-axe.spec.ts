import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signal, type Type, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalPresentationStore } from './core/approval-presentation.store';
import { DraftStore } from './core/draft-store';
import { GatewayClient } from './core/gateway-client.service';
import { HapticsService } from './core/haptics.service';
import { HostStore } from './core/host-store';
import { ImageAttachmentService } from './core/image-attachment.service';
import type { MobileSnapshot } from './core/models';
import { VoiceInputService } from './core/voice-input.service';
import { ConversationComponent } from './features/conversation/conversation.component';
import { DocReviewsComponent } from './features/doc-review/doc-reviews.component';
import { HistoryComponent } from './features/history/history.component';
import { InboxComponent } from './features/inbox/inbox.component';
import { NeedsYouStore } from './features/inbox/needs-you.store';
import { LoopDetailComponent } from './features/loops/loop-detail.component';
import { LoopsComponent } from './features/loops/loops.component';
import { PlanQueueDetailComponent } from './features/plan-queue/plan-queue-detail.component';
import { PlanQueueComponent } from './features/plan-queue/plan-queue.component';
import { DocReviewDetailComponent } from './features/doc-review/doc-review-detail.component';
import { ProjectsComponent } from './features/projects/projects.component';
import { SessionsComponent } from './features/sessions/sessions.component';

const resourceRoot = dirname(fileURLToPath(import.meta.url));
const resources = new Map<string, string>();

function indexResources(directory: string): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) indexResources(path);
    else resources.set(entry.name, readFileSync(path, 'utf8'));
  }
}

indexResources(resourceRoot);

await resolveComponentResources((url) => {
  const name = url.split('/').pop() ?? url;
  return Promise.resolve(resources.get(name) ?? '');
});

const snapshot: MobileSnapshot = {
  hostName: 'Preview',
  serverTime: 1,
  projects: [],
  prompts: [],
  pause: { isPaused: false, reasons: [], pausedAt: null, lastChange: 0 },
  instances: [{
    id: 'session',
    displayName: 'Agent',
    status: 'idle',
    provider: 'claude',
    workingDirectory: '/work/demo',
    projectName: 'demo',
    createdAt: 1,
    lastActivity: 1,
    pendingApprovalCount: 0,
    hasUnreadCompletion: false,
  }],
};

function gateway() {
  return {
    snapshot: signal(snapshot),
    online: signal(true),
    state: signal('connected'),
    dataHostId: signal('host'),
    historySessions: signal([]),
    historyState: signal({ status: 'loaded' as const, error: null }),
    loadHistory: vi.fn().mockResolvedValue([]),
    pause: signal(snapshot.pause),
    recentDirs: vi.fn().mockResolvedValue([]),
    setPause: vi.fn().mockResolvedValue(undefined),
    refreshSnapshot: vi.fn().mockResolvedValue(undefined),
    loops: vi.fn().mockResolvedValue([]),
    planQueue: vi.fn().mockResolvedValue({ runs: [] }),
    docReviews: vi.fn().mockResolvedValue([]),
    loopEvent: signal(0),
    planQueueEvent: signal(0),
    messagesFor: () => [],
    messageStateFor: () => ({ status: 'loaded' as const, error: null }),
    hasEarlierFor: () => false,
    earlierStateFor: () => ({ status: 'idle' as const, error: null }),
    loadMessages: vi.fn(),
    sendInput: vi.fn().mockResolvedValue({ queued: false }),
    steerInput: vi.fn(),
    setActiveView: vi.fn(),
    clearActiveView: vi.fn(),
    catchUpMessages: vi.fn(),
  };
}

function host() {
  return {
    activeHost: signal({ id: 'host', name: 'Preview', host: 'preview.local', port: 4879, token: 'placeholder', addedAt: 0 }),
    hosts: signal([]),
    activeId: signal('host'),
  };
}

async function expectClean(screen: string, element: HTMLElement): Promise<void> {
  const results = await axe.run(element, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
    rules: {
      // jsdom does not compute used colors. Pair contrast is checked by
      // scripts/check-appearance-contrast.mjs.
      'color-contrast': { enabled: false },
      // These components are panes, not documents. The shell supplies the landmark.
      region: { enabled: false },
    },
  });
  const summary = results.violations.map((violation) => (
    `${violation.id}: ${violation.nodes.map((node) => node.html).join(' | ')}`
  ));
  expect(summary, screen).toEqual([]);
}

async function mount<T>(component: Type<T>, prepare?: (fixture: ComponentFixture<T>) => void): Promise<HTMLElement> {
  const client = gateway();
  TestBed.configureTestingModule({
    imports: [component],
    providers: [
      provideRouter([]),
      { provide: GatewayClient, useValue: client },
      { provide: HostStore, useValue: host() },
      { provide: Router, useValue: { navigate: vi.fn(), getCurrentNavigation: () => null, url: '/projects' } },
      { provide: NeedsYouStore, useValue: { items: signal([]), hostStates: signal([]), open: vi.fn(), stateFor: () => 'online' } },
      { provide: ApprovalPresentationStore, useValue: { requests: signal([]), open: vi.fn() } },
      { provide: DraftStore, useValue: { load: async () => '', save: vi.fn(), attachments: () => [], saveAttachments: vi.fn() } },
      { provide: VoiceInputService, useValue: { available: false, listening: signal(false), text: signal(''), stop: vi.fn() } },
      { provide: ImageAttachmentService, useValue: { available: false } },
      { provide: HapticsService, useValue: { tap: vi.fn(), error: vi.fn(), heavyTap: vi.fn(), success: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(component);
  prepare?.(fixture);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

afterEach(() => TestBed.resetTestingModule());

describe('fixture screen axe', () => {
  it('loops', async () => {
    await expectClean('loops', await mount(LoopsComponent));
  });

  it('plan queue', async () => {
    await expectClean('plan queue', await mount(PlanQueueComponent));
  });

  it('doc reviews', async () => {
    await expectClean('doc reviews', await mount(DocReviewsComponent));
  });

  it('inbox', async () => {
    await expectClean('inbox', await mount(InboxComponent));
  });

  it('projects', async () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    await expectClean('projects', await mount(ProjectsComponent));
  });

  it('sessions', async () => {
    const client = gateway();
    TestBed.configureTestingModule({
      imports: [SessionsComponent],
      providers: [
        provideRouter([]),
        { provide: GatewayClient, useValue: client },
        { provide: HostStore, useValue: host() },
      ],
    });
    const fixture = TestBed.createComponent(SessionsComponent);
    fixture.componentRef.setInput('projectKey', '/work/demo');
    fixture.detectChanges();
    await fixture.whenStable();
    await expectClean('sessions', fixture.nativeElement as HTMLElement);
  });

  it('history', async () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    await expectClean('history', await mount(HistoryComponent));
  });

  it('loop detail', async () => {
    await expectClean('loop detail', await mount(LoopDetailComponent, (fixture) => {
      fixture.componentRef.setInput('id', 'loop-1');
    }));
  });

  it('plan queue detail', async () => {
    await expectClean('plan queue detail', await mount(PlanQueueDetailComponent, (fixture) => {
      fixture.componentRef.setInput('id', 'item-1');
    }));
  });

  it('doc review detail', async () => {
    await expectClean('doc review detail', await mount(DocReviewDetailComponent, (fixture) => {
      fixture.componentRef.setInput('id', 'review-1');
    }));
  });

  it('conversation', async () => {
    await expectClean('conversation', await mount(ConversationComponent, (fixture) => {
      fixture.componentRef.setInput('instanceId', 'session');
    }));
  });
});
