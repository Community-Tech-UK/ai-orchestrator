import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstanceIpcService } from '../core/services/ipc/instance-ipc.service';
import { OrchestrationIpcService } from '../core/services/ipc/orchestration-ipc.service';
import { TaskIpcService } from '../core/services/ipc/task-ipc.service';
import { FileIpcService } from '../core/services/ipc/file-ipc.service';
import { RendererPollSchedulerService } from '../core/services/renderer-poll-scheduler.service';
import { WorkflowPageComponent } from './workflow/workflow-page.component';
import { WorktreePageComponent } from './worktree/worktree-page.component';
import { ReviewsPageComponent } from './review/reviews-page.component';
import { SpecialistsPageComponent } from './specialists/specialists-page.component';

describe('session selectors fed by instance IPC', () => {
  afterEach(() => TestBed.resetTestingModule());

  it.each([
    ['workflow', WorkflowPageComponent],
    ['worktree', WorktreePageComponent],
    ['review', ReviewsPageComponent],
    ['specialists', SpecialistsPageComponent],
  ] as const)('keeps sidechat runtimes out of the %s picker and initial selection', async (_name, Page) => {
    TestBed.configureTestingModule({ providers: [
      { provide: InstanceIpcService, useValue: { listInstances: vi.fn(async () => ({ success: true, data: [
        { id: 'sidechat', displayName: 'Sidechat runtime', status: 'busy', metadata: { hideFromProjectRail: true, sideChatId: 'chat' } },
        { id: 'worker', displayName: 'Internal worker', status: 'idle', metadata: { spawnDepth: 1 } },
        { id: 'session', displayName: 'Main session', status: 'idle' },
      ] })) } },
      { provide: OrchestrationIpcService, useValue: {
        workflowListTemplates: async () => ({ success: true, data: [] }),
        workflowGetByInstance: async () => ({ success: true, data: null }),
        worktreeList: async () => ({ success: true, data: [] }),
        reviewListAgents: async () => ({ success: true, data: [] }),
        specialistList: async () => ({ success: true, data: [] }),
        specialistGetActiveInstances: async () => ({ success: true, data: [] }),
      } },
      { provide: TaskIpcService, useValue: {} },
      { provide: FileIpcService, useValue: {} },
      { provide: Router, useValue: {} },
      { provide: RendererPollSchedulerService, useValue: {} },
    ] });
    const component = TestBed.runInInjectionContext(() => new Page());
    await component.refreshAll();

    expect(component.instances().map(instance => instance.id)).toEqual(['session']);
    expect(component.selectedInstanceId()).toBe('session');
    expect(component.errorMessage()).toBeNull();
  });
});
