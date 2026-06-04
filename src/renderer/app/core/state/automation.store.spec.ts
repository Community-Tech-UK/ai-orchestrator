import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationIpcService } from '../services/ipc/automation-ipc.service';
import { AutomationStore } from './automation.store';

describe('AutomationStore thread wakeups', () => {
  const ipc = {
    list: vi.fn(),
    listRuns: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    runNow: vi.fn(),
    cancelPending: vi.fn(),
    markSeen: vi.fn(),
    preflight: vi.fn(),
    listTemplates: vi.fn(),
    onChanged: vi.fn(() => () => undefined),
    onRunChanged: vi.fn(() => () => undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    ipc.list.mockResolvedValue({ success: true, data: [] });
    ipc.listRuns.mockResolvedValue({ success: true, data: [] });
    ipc.create.mockResolvedValue({ success: true, data: { id: 'automation-1' } });
    ipc.preflight.mockResolvedValue({ success: true, data: null });
    ipc.listTemplates.mockResolvedValue({ success: true, data: [] });

    TestBed.configureTestingModule({
      providers: [
        AutomationStore,
        { provide: AutomationIpcService, useValue: ipc },
      ],
    });
  });

  it('creates thread wakeups with a thread destination payload', async () => {
    const store = TestBed.inject(AutomationStore);

    await store.createThreadWakeup({
      instanceId: 'instance-1',
      sessionId: 'session-1',
      historyEntryId: 'history-1',
      workingDirectory: '/repo',
      prompt: 'Continue later',
      runAt: 1_800_000,
      reviveIfArchived: true,
    });

    expect(ipc.create).toHaveBeenCalledWith({
      name: 'Thread wakeup',
      schedule: {
        type: 'oneTime',
        runAt: 1_800_000,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      missedRunPolicy: 'notify',
      concurrencyPolicy: 'skip',
      destination: {
        kind: 'thread',
        instanceId: 'instance-1',
        sessionId: 'session-1',
        historyEntryId: 'history-1',
        reviveIfArchived: true,
      },
      action: {
        prompt: 'Continue later',
        workingDirectory: '/repo',
      },
    });
  });

  it('creates interval thread wakeups as cron loops', async () => {
    const store = TestBed.inject(AutomationStore);

    await store.createThreadWakeup({
      instanceId: 'instance-1',
      workingDirectory: '/repo',
      prompt: 'Check again',
      runAt: 1_800_000,
      intervalMinutes: 20,
      reviveIfArchived: false,
    });

    expect(ipc.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Thread loop',
      schedule: expect.objectContaining({
        type: 'cron',
        expression: '*/20 * * * *',
      }),
      destination: expect.objectContaining({
        kind: 'thread',
        instanceId: 'instance-1',
        reviveIfArchived: false,
      }),
    }));
  });

  it('loads templates and returns the selected template for application', async () => {
    ipc.listTemplates.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'daily-repo-health',
          name: 'Daily Repo Health',
          description: 'Check repository health.',
          prompt: 'Check the repo.\n\nReturn a concise summary of findings.',
          suggestedSchedule: { type: 'cron', expression: '0 9 * * 1-5', timezone: 'UTC' },
          tags: ['repo'],
        },
      ],
    });
    const store = TestBed.inject(AutomationStore);

    await store.loadTemplates();
    const applied = store.applyTemplate('daily-repo-health');

    expect(store.templates().map((template) => template.id)).toEqual(['daily-repo-health']);
    expect(applied?.prompt).toContain('Return a concise summary');
  });

  it('markRunSeen reduces the unread badge by one and marks the run seen', async () => {
    ipc.list.mockResolvedValue({
      success: true,
      data: [{ id: 'automation-1', unreadRunCount: 2 }],
    });
    ipc.listRuns.mockResolvedValue({
      success: true,
      data: [{ id: 'run-1', automationId: 'automation-1', status: 'succeeded', seenAt: null }],
    });
    ipc.markSeen.mockResolvedValue({ success: true });
    const store = TestBed.inject(AutomationStore);
    await store.refresh();

    expect(store.unreadCount()).toBe(2);

    await store.markRunSeen('run-1', 'automation-1');

    expect(ipc.markSeen).toHaveBeenCalledWith({ runId: 'run-1' });
    expect(store.unreadCount()).toBe(1);
    expect(store.runs().find((run) => run.id === 'run-1')?.seenAt).toBeTruthy();
  });

  it('markRunSeen is idempotent for an already-seen run', async () => {
    ipc.list.mockResolvedValue({
      success: true,
      data: [{ id: 'automation-1', unreadRunCount: 1 }],
    });
    ipc.listRuns.mockResolvedValue({
      success: true,
      data: [{ id: 'run-1', automationId: 'automation-1', status: 'succeeded', seenAt: 12345 }],
    });
    ipc.markSeen.mockResolvedValue({ success: true });
    const store = TestBed.inject(AutomationStore);
    await store.refresh();

    await store.markRunSeen('run-1', 'automation-1');

    expect(ipc.markSeen).not.toHaveBeenCalled();
    expect(store.unreadCount()).toBe(1);
  });

  it('markRunSeen never drives the unread count below zero', async () => {
    ipc.list.mockResolvedValue({
      success: true,
      data: [{ id: 'automation-1', unreadRunCount: 0 }],
    });
    ipc.listRuns.mockResolvedValue({ success: true, data: [] });
    ipc.markSeen.mockResolvedValue({ success: true });
    const store = TestBed.inject(AutomationStore);
    await store.refresh();

    await store.markRunSeen('run-unknown', 'automation-1');

    expect(store.unreadCount()).toBe(0);
  });

  it('runs automation preflight and stores the latest report', async () => {
    const report = {
      generatedAt: 1,
      workingDirectory: '/repo',
      surface: 'automation',
      taskType: 'automation',
      instructionSummary: { projectRoot: '/repo', appliedLabels: [], warnings: [], sources: [] },
      branchPolicy: {
        state: 'fresh',
        action: 'allow',
        branch: 'main',
        upstream: 'origin/main',
        ahead: 0,
        behind: 0,
        summary: 'fresh',
        recommendedRemediation: 'none',
        requiresManualResolution: false,
      },
      filesystem: {
        workingDirectory: '/repo',
        canReadWorkingDirectory: true,
        canWriteWorkingDirectory: true,
        readPathCount: 1,
        writePathCount: 1,
        blockedPathCount: 0,
        allowTempDir: true,
        notes: [],
      },
      network: {
        allowAllTraffic: true,
        allowedDomainCount: 0,
        blockedDomainCount: 0,
        sampleAllowedDomains: [],
        notes: [],
      },
      mcp: {
        configuredCount: 0,
        connectedCount: 0,
        browserStatus: 'ready',
        browserWarnings: [],
        browserToolNames: [],
        connectedServerNames: [],
      },
      permissions: { preset: 'ask', defaultAction: 'ask', predictions: [] },
      blockers: [],
      warnings: ['permission warning'],
      recommendedLinks: [],
      okToSave: true,
      suggestedPermissionRules: [],
      suggestedPromptEdits: [],
    };
    ipc.preflight.mockResolvedValue({ success: true, data: report });
    const store = TestBed.inject(AutomationStore);

    const result = await store.runPreflight({
      workingDirectory: '/repo',
      prompt: 'Fix lint',
      provider: 'claude',
      expectedUnattended: true,
    });

    expect(ipc.preflight).toHaveBeenCalledWith({
      workingDirectory: '/repo',
      prompt: 'Fix lint',
      provider: 'claude',
      expectedUnattended: true,
    });
    expect(result).toBe(report);
    expect(store.preflight()).toBe(report);
  });
});
