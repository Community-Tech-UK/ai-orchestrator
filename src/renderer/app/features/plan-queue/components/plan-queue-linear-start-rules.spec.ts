import { describe, expect, it } from 'vitest';
import type { PlanQueueLinearPreview, PlanQueueLinearPreviewRow, PlanQueueRouting } from '@contracts/schemas/plan-queue';
import {
  allowedForTicked,
  linearCommentTime,
  linearPriorityWord,
  providersNotAllowed,
  providersOfRun,
} from './plan-queue-linear-start-rules';

const row = (id: string, teamId: string): PlanQueueLinearPreviewRow => ({
  id, identifier: `${teamId.toUpperCase()}-1`, title: 'A ticket', priority: 3, assigneeName: null, labels: [], teamId, projectId: `p-${teamId}`,
  ticked: false, canTick: true, waitingFor: [], reason: null, notes: [],
});

const preview = (): PlanQueueLinearPreview => ({
  previewId: 'pv', loadedAt: 1, expiresAt: 2, folder: '/repo', labelNote: null, rows: [],
  projects: [
    { projectId: 'p-orc', projectName: 'Orc', teamId: 'orc', teamKey: 'ORC', ownership: 'own', ready: true, reasons: [],
      allowedProviders: [{ id: 'claude', label: 'Claude' }, { id: 'codex', label: 'Codex' }] },
    { projectId: 'p-com', projectName: 'Com', teamId: 'com', teamKey: 'COM', ownership: 'own', ready: true, reasons: [],
      allowedProviders: [{ id: 'openai', label: 'Codex' }] },
  ],
});

describe('Linear Start preview rules', () => {
  it('says the priority in words and treats an unknown number as none', () => {
    expect([0, 1, 2, 3, 4, 9].map(linearPriorityWord)).toEqual(['No priority', 'Urgent', 'High', 'Medium', 'Low', 'No priority']);
  });

  it('allows only the providers every ticked team allows, matching a legacy id to its current one', () => {
    expect(allowedForTicked(preview(), [row('1', 'orc')]).map((provider) => provider.id)).toEqual(['claude', 'codex']);
    expect(allowedForTicked(preview(), [row('1', 'orc'), row('2', 'com')]).map((provider) => provider.id)).toEqual(['codex']);
    expect(allowedForTicked(preview(), [])).toEqual([]);
  });

  it('lists the run providers: the starting session when no worker is named, plus step-up and checkers', () => {
    const none: PlanQueueRouting = { workers: [], verifiers: [] };
    expect(providersOfRun(none, 'claude')).toEqual(['claude']);
    expect(providersOfRun(none, null)).toEqual([]);
    const routing: PlanQueueRouting = { workers: [{ provider: 'openai' }], verifiers: [{ provider: 'gemini' }], stepUp: { provider: 'claude' } };
    expect(providersOfRun(routing, 'claude')).toEqual(['codex', 'claude', 'antigravity']);
  });

  it('names the run providers that are not allowed', () => {
    const allowed = allowedForTicked(preview(), [row('1', 'orc')]);
    expect(providersNotAllowed(['claude', 'codex'], allowed)).toEqual([]);
    expect(providersNotAllowed(['claude', 'copilot'], allowed)).toHaveLength(1);
    expect(providersNotAllowed(['claude', 'copilot'], allowed)[0]).toMatch(/copilot/i);
  });

  it('leaves out a time it cannot read', () => {
    expect(linearCommentTime('not a date')).toBe('');
    expect(linearCommentTime('2026-11-16T10:00:00Z')).not.toBe('');
  });
});
