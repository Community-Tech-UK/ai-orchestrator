import { describe, expect, it } from 'vitest';
import type { LoopRunSummaryPayload } from '@contracts/schemas/loop';
import type { LoopStatus } from '../../../../shared/types/loop.types';
import type { InstanceStatus } from '../../core/state/instance/instance.types';
import type {
  Automation,
  AutomationRun,
  AutomationRunStatus,
} from '../../../../shared/types/automation.types';
import type { RepoJobRecord, RepoJobStatus } from '../../../../shared/types/repo-job.types';
import {
  instanceStatusToPhase,
  loopStatusToPhase,
} from '../../../../shared/types/workflow-lifecycle.types';
import { NO_WORKSPACE_KEY, toWorkspaceId } from '../../../../shared/utils/workspace-key';
import {
  WORKBOARD_RETENTION_WINDOW_MS,
  automationRunStatusToLane,
  basename,
  buildWorkboardLanes,
  deriveWorkspaceOptions,
  instanceStatusToLane,
  loopStatusToLane,
  projectWorkboard,
  relativeTime,
  repoJobStatusToLane,
} from './workboard-projection';
import type {
  WorkboardInstanceInput,
  WorkboardLane,
  WorkboardProjectionInput,
} from './workboard.types';

const NOW = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Typed factories
// ---------------------------------------------------------------------------

function instance(overrides: Partial<WorkboardInstanceInput> = {}): WorkboardInstanceInput {
  return {
    id: 'inst-1',
    status: 'busy',
    displayName: 'Build session',
    workingDirectory: '/repo/project',
    provider: 'claude',
    lastActivity: NOW,
    ...overrides,
  };
}

function loop(overrides: Partial<LoopRunSummaryPayload> = {}): LoopRunSummaryPayload {
  return {
    id: 'loop-1',
    chatId: 'inst-1',
    status: 'running',
    totalIterations: 4,
    totalTokens: 1000,
    totalCostCents: 20,
    startedAt: NOW,
    endedAt: null,
    endReason: null,
    workspaceCwd: '/repo/project',
    initialPrompt: 'Implement the feature',
    iterationPrompt: null,
    ...overrides,
  };
}

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    name: 'Nightly audit',
    enabled: true,
    active: true,
    workspaceId: toWorkspaceId('/repo/auto'),
    schedule: { type: 'cron', expression: '0 0 * * *', timezone: 'UTC' },
    trigger: { kind: 'schedule' },
    missedRunPolicy: 'skip',
    concurrencyPolicy: 'skip',
    destination: { kind: 'newInstance' },
    action: { prompt: 'audit', workingDirectory: '/repo/auto' },
    nextFireAt: null,
    lastFiredAt: null,
    lastRunId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function automationRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'auto-1',
    status: 'running',
    trigger: 'scheduled',
    scheduledAt: NOW,
    startedAt: NOW,
    finishedAt: null,
    instanceId: null,
    loopRunId: null,
    error: null,
    outputSummary: null,
    outputFullRef: null,
    idempotencyKey: null,
    triggerSource: null,
    deliveryMode: 'notify',
    seenAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    configSnapshot: null,
    attempt: 1,
    maxAttempts: 1,
    ...overrides,
  };
}

function repoJob(overrides: Partial<RepoJobRecord> = {}): RepoJobRecord {
  return {
    id: 'job-1',
    taskId: 'task-1',
    name: 'PR review',
    type: 'pr-review',
    status: 'running',
    workingDirectory: '/repo/project',
    workflowTemplateId: 'tmpl-1',
    useWorktree: false,
    progress: 40,
    createdAt: NOW,
    repoContext: { gitAvailable: true, isRepo: true, changedFiles: [] },
    submission: { type: 'pr-review', workingDirectory: '/repo/project' },
    ...overrides,
  };
}

function input(overrides: Partial<WorkboardProjectionInput> = {}): WorkboardProjectionInput {
  return {
    instances: [],
    loopRuns: [],
    automationRuns: [],
    automations: [],
    repoJobs: [],
    now: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 4.1 — exhaustive lane policy
// ---------------------------------------------------------------------------

describe('source-status → lane policy (exhaustive)', () => {
  // Exhaustive Record maps: adding a new status to any source union is a COMPILE
  // error here until it is mapped, so the policy can never silently fall behind.
  const INSTANCE_LANES: Record<InstanceStatus, WorkboardLane> = {
    waiting_for_permission: 'needs-you',
    waiting_for_input: 'needs-you',
    degraded: 'needs-you',
    error: 'needs-you',
    failed: 'needs-you',
    initializing: 'working',
    busy: 'working',
    processing: 'working',
    thinking_deeply: 'working',
    respawning: 'working',
    waking: 'working',
    interrupting: 'working',
    cancelling: 'working',
    'interrupt-escalating': 'working',
    hibernating: 'waiting',
    hibernated: 'waiting',
    ready: 'done',
    idle: 'done',
    terminated: 'done',
    cancelled: 'done',
    superseded: 'done',
  };

  it('maps every InstanceStatus to its lane', () => {
    for (const [status, lane] of Object.entries(INSTANCE_LANES) as [InstanceStatus, WorkboardLane][]) {
      expect(instanceStatusToLane(status)).toBe(lane);
    }
  });

  const LOOP_LANES: Record<LoopStatus, WorkboardLane> = {
    running: 'working',
    paused: 'waiting',
    'provider-limit': 'waiting', // active/resumable when endedAt is null (asserted below)
    completed: 'done',
    'completed-needs-review': 'needs-you',
    cancelled: 'done',
    failed: 'needs-you',
    error: 'needs-you',
    'no-progress': 'needs-you',
    'cap-reached': 'needs-you',
    'cost-exceeded': 'needs-you',
    'needs-human-arbitration': 'needs-you',
    'reviewer-unreliable': 'needs-you',
    'reviewer-unavailable': 'needs-you',
    'builder-unreliable': 'needs-you',
  };

  it('maps every LoopStatus to its lane (endedAt=null baseline)', () => {
    for (const [status, lane] of Object.entries(LOOP_LANES) as [LoopStatus, WorkboardLane][]) {
      expect(loopStatusToLane(status, null)).toBe(lane);
    }
  });

  it('splits provider-limit on endedAt: null → waiting, terminal → needs-you', () => {
    expect(loopStatusToLane('provider-limit', null)).toBe('waiting');
    expect(loopStatusToLane('provider-limit', NOW)).toBe('needs-you');
  });

  const AUTOMATION_LANES: Record<AutomationRunStatus, WorkboardLane> = {
    running: 'working',
    pending: 'waiting',
    failed: 'needs-you',
    succeeded: 'done',
    skipped: 'done',
    cancelled: 'done',
  };

  it('maps every AutomationRunStatus to its lane', () => {
    for (const [status, lane] of Object.entries(AUTOMATION_LANES) as [AutomationRunStatus, WorkboardLane][]) {
      expect(automationRunStatusToLane(status)).toBe(lane);
    }
  });

  const REPO_JOB_LANES: Record<RepoJobStatus, WorkboardLane> = {
    running: 'working',
    queued: 'waiting',
    failed: 'needs-you',
    completed: 'done',
    cancelled: 'done',
  };

  it('maps every RepoJobStatus to its lane', () => {
    for (const [status, lane] of Object.entries(REPO_JOB_LANES) as [RepoJobStatus, WorkboardLane][]) {
      expect(repoJobStatusToLane(status)).toBe(lane);
    }
  });

  it('retains raw status and coarse phase in each relation', () => {
    const items = projectWorkboard(input({
      instances: [instance({ status: 'waiting_for_permission' })],
    }));
    expect(items).toHaveLength(1);
    expect(items[0].primary.rawStatus).toBe('waiting_for_permission');
    expect(items[0].primary.phase).toBe(instanceStatusToPhase('waiting_for_permission'));

    const loopItems = projectWorkboard(input({ loopRuns: [loop({ status: 'no-progress', endedAt: NOW })] }));
    expect(loopItems[0].primary.rawStatus).toBe('no-progress');
    expect(loopItems[0].primary.phase).toBe(loopStatusToPhase('no-progress'));
  });
});

// ---------------------------------------------------------------------------
// 4.2 — retention + workspace derivation
// ---------------------------------------------------------------------------

describe('retention window', () => {
  it('keeps live/resumable records regardless of age', () => {
    const items = projectWorkboard(input({
      loopRuns: [loop({ status: 'running', startedAt: NOW - 10 * WORKBOARD_RETENTION_WINDOW_MS, endedAt: null })],
    }));
    expect(items).toHaveLength(1);
  });

  it('keeps a terminal record at 23h59m and excludes one beyond 24h', () => {
    const nearEdge = NOW - (23 * 3600 + 59 * 60) * 1000;
    const beyond = NOW - (WORKBOARD_RETENTION_WINDOW_MS + 60_000);

    const kept = projectWorkboard(input({
      loopRuns: [loop({ id: 'loop-keep', status: 'completed', startedAt: nearEdge, endedAt: nearEdge })],
    }));
    expect(kept.map((i) => i.id)).toEqual(['loop-run:loop-keep']);

    const dropped = projectWorkboard(input({
      loopRuns: [loop({ id: 'loop-old', status: 'completed', startedAt: beyond, endedAt: beyond })],
    }));
    expect(dropped).toHaveLength(0);
  });
});

describe('workspace derivation', () => {
  it('normalizes the workspace id via toWorkspaceId and preserves the display path', () => {
    const items = projectWorkboard(input({ instances: [instance({ workingDirectory: '/Repo/Project' })] }));
    expect(items[0].workspaceId).toBe(toWorkspaceId('/Repo/Project'));
    expect(items[0].workingDirectory).toBe('/Repo/Project');
  });

  it('falls back to the owning automation directory when the run snapshot is absent', () => {
    const items = projectWorkboard(input({
      automations: [automation({ id: 'auto-1', action: { prompt: 'x', workingDirectory: '/repo/auto' } })],
      automationRuns: [automationRun({ automationId: 'auto-1', configSnapshot: null })],
    }));
    expect(items[0].workspaceId).toBe(toWorkspaceId('/repo/auto'));
  });

  it('uses the sentinel for absent/blank workspaces without crashing', () => {
    const items = projectWorkboard(input({ instances: [instance({ workingDirectory: '' })] }));
    expect(items[0].workspaceId).toBe(NO_WORKSPACE_KEY);
  });
});

// ---------------------------------------------------------------------------
// 4.3 — correlation
// ---------------------------------------------------------------------------

describe('correlation', () => {
  it('collapses a repository job and its linked instance into one repo-job item', () => {
    const items = projectWorkboard(input({
      repoJobs: [repoJob({ id: 'job-1', instanceId: 'inst-1' })],
      instances: [instance({ id: 'inst-1' })],
    }));
    expect(items).toHaveLength(1);
    expect(items[0].primary.kind).toBe('repo-job');
    expect(items[0].instanceId).toBe('inst-1');
    expect(items[0].relations.map((r) => r.kind).sort()).toEqual(['instance', 'repo-job']);
  });

  it('collapses an automation run with its linked loop and instance into one automation item', () => {
    const items = projectWorkboard(input({
      automationRuns: [automationRun({ id: 'run-1', loopRunId: 'loop-1', instanceId: 'inst-1' })],
      loopRuns: [loop({ id: 'loop-1', chatId: 'inst-1' })],
      instances: [instance({ id: 'inst-1' })],
    }));
    expect(items).toHaveLength(1);
    expect(items[0].primary.kind).toBe('automation-run');
    expect(items[0].automationRunId).toBe('run-1');
    expect(items[0].loopRunId).toBe('loop-1');
    expect(items[0].instanceId).toBe('inst-1');
  });

  it('collapses a standalone loop and its chat/instance into one loop item', () => {
    const items = projectWorkboard(input({
      loopRuns: [loop({ id: 'loop-1', chatId: 'inst-1' })],
      instances: [instance({ id: 'inst-1' })],
    }));
    expect(items).toHaveLength(1);
    expect(items[0].primary.kind).toBe('loop-run');
    expect(items[0].loopRunId).toBe('loop-1');
    expect(items[0].instanceId).toBe('inst-1');
  });

  it('leaves an unlinked instance standalone', () => {
    const items = projectWorkboard(input({ instances: [instance({ id: 'inst-solo' })] }));
    expect(items).toHaveLength(1);
    expect(items[0].primary.kind).toBe('instance');
    expect(items[0].id).toBe('instance:inst-solo');
  });

  it('never merges records that only share a title/path (no explicit id link)', () => {
    const items = projectWorkboard(input({
      instances: [
        instance({ id: 'inst-a', displayName: 'Same name', workingDirectory: '/repo/x' }),
        instance({ id: 'inst-b', displayName: 'Same name', workingDirectory: '/repo/x' }),
      ],
      loopRuns: [loop({ id: 'loop-z', chatId: 'no-such-instance', workspaceCwd: '/repo/x' })],
    }));
    expect(items).toHaveLength(3);
  });

  it('uses the most urgent related lane for the group (needs-you beats working)', () => {
    const items = projectWorkboard(input({
      repoJobs: [repoJob({ id: 'job-1', status: 'running', instanceId: 'inst-1' })],
      instances: [instance({ id: 'inst-1', status: 'waiting_for_permission' })],
    }));
    expect(items[0].primary.kind).toBe('repo-job');
    expect(items[0].lane).toBe('needs-you');
  });

  it('produces stable ids and correlation regardless of input order', () => {
    const base = {
      repoJobs: [repoJob({ id: 'job-1', instanceId: 'inst-1' })],
      automationRuns: [automationRun({ id: 'run-1', loopRunId: 'loop-1', instanceId: 'inst-2' })],
      loopRuns: [loop({ id: 'loop-1', chatId: 'inst-2' }), loop({ id: 'loop-3', chatId: 'inst-3' })],
      instances: [instance({ id: 'inst-1' }), instance({ id: 'inst-2' }), instance({ id: 'inst-3' })],
    };
    const forward = projectWorkboard(input(base));
    const reversed = projectWorkboard(input({
      repoJobs: [...base.repoJobs].reverse(),
      automationRuns: [...base.automationRuns].reverse(),
      loopRuns: [...base.loopRuns].reverse(),
      instances: [...base.instances].reverse(),
    }));
    const ids = (list: { id: string }[]) => list.map((i) => i.id).sort();
    expect(ids(forward)).toEqual(ids(reversed));
    // Stable item ids use the primary source kind + primary id.
    expect(ids(forward)).toContain('repo-job:job-1');
    expect(ids(forward)).toContain('automation-run:run-1');
    expect(ids(forward)).toContain('loop-run:loop-3');
  });

  it('does not collapse many loop runs sharing one instance into a single card', () => {
    const items = projectWorkboard(input({
      loopRuns: [
        loop({ id: 'loop-a', chatId: 'inst-1', startedAt: NOW - 1000, endedAt: null }),
        loop({ id: 'loop-b', chatId: 'inst-1', startedAt: NOW - 2000, status: 'completed', endedAt: NOW - 1500 }),
      ],
      instances: [instance({ id: 'inst-1' })],
    }));
    // Two loop cards; the instance folds into exactly one of them, never both.
    expect(items.filter((i) => i.primary.kind === 'loop-run')).toHaveLength(2);
    const withInstance = items.filter((i) => i.relations.some((r) => r.kind === 'instance'));
    expect(withInstance).toHaveLength(1);
    // Both loop cards still carry the backing instance id for navigation.
    expect(items.every((i) => i.instanceId === 'inst-1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// lane grouping + workspace options
// ---------------------------------------------------------------------------

describe('buildWorkboardLanes', () => {
  it('orders Needs You / Working / Done newest-first and Waiting oldest-first', () => {
    const items = projectWorkboard(input({
      loopRuns: [
        loop({ id: 'wait-new', status: 'paused', startedAt: NOW - 1000, endedAt: null }),
        loop({ id: 'wait-old', status: 'paused', startedAt: NOW - 5000, endedAt: null }),
        loop({ id: 'work-new', status: 'running', startedAt: NOW - 1000, endedAt: null, chatId: 'c1' }),
        loop({ id: 'work-old', status: 'running', startedAt: NOW - 5000, endedAt: null, chatId: 'c2' }),
      ],
    }));
    const lanes = buildWorkboardLanes(items);
    expect(lanes.waiting.map((i) => i.id)).toEqual(['loop-run:wait-old', 'loop-run:wait-new']);
    expect(lanes.working.map((i) => i.id)).toEqual(['loop-run:work-new', 'loop-run:work-old']);
  });

  it('always returns all four lanes even when empty', () => {
    const lanes = buildWorkboardLanes([]);
    expect(Object.keys(lanes).sort()).toEqual(['done', 'needs-you', 'waiting', 'working']);
  });
});

// Presentation helpers migrated from the retired Fleet dashboard.
describe('relativeTime', () => {
  it('formats recent, minute, hour, and day spans deterministically', () => {
    expect(relativeTime(NOW, NOW)).toBe('just now');
    expect(relativeTime(NOW - 3_000, NOW)).toBe('just now');
    expect(relativeTime(NOW - 30_000, NOW)).toBe('30s ago');
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
    expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe('2d ago');
  });
});

describe('basename', () => {
  it('returns the final path segment across slash styles and trailing separators', () => {
    expect(basename('/repo/project')).toBe('project');
    expect(basename('/repo/project/')).toBe('project');
    expect(basename('C:\\work\\thing')).toBe('thing');
    expect(basename('')).toBe('');
  });
});

describe('deriveWorkspaceOptions', () => {
  it('dedupes by normalized id and sorts by label', () => {
    const items = projectWorkboard(input({
      instances: [
        instance({ id: 'i1', workingDirectory: '/repo/zebra' }),
        instance({ id: 'i2', workingDirectory: '/repo/zebra' }),
        instance({ id: 'i3', workingDirectory: '/repo/apple' }),
      ],
    }));
    const options = deriveWorkspaceOptions(items);
    expect(options.map((o) => o.label)).toEqual(['apple', 'zebra']);
    expect(options).toHaveLength(2);
  });
});
