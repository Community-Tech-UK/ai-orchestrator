import { describe, it, expect } from 'vitest';
import {
  automationEquivalenceKey,
  findEquivalentAutomation,
} from './automation-equivalence';
import type {
  Automation,
  AutomationSchedule,
  CreateAutomationInput,
} from '../../shared/types/automation.types';

const CRON: AutomationSchedule = { type: 'cron', expression: '0 * * * *', timezone: 'UTC' };

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  const workingDirectory = overrides.action?.workingDirectory ?? '/repo';
  return {
    id: 'auto-1',
    name: 'Hourly server watch',
    enabled: true,
    active: true,
    workspaceId: workingDirectory.toLowerCase(),
    schedule: CRON,
    trigger: { kind: 'schedule' },
    missedRunPolicy: 'notify',
    concurrencyPolicy: 'skip',
    destination: { kind: 'newInstance' },
    action: { prompt: 'Check server', workingDirectory },
    nextFireAt: 1_000,
    lastFiredAt: null,
    lastRunId: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function makeInput(overrides: Partial<CreateAutomationInput> = {}): CreateAutomationInput {
  return {
    name: 'freshly worded name',
    enabled: true,
    schedule: CRON,
    concurrencyPolicy: 'skip',
    action: { prompt: 'Check server', workingDirectory: '/repo' },
    ...overrides,
  };
}

describe('automationEquivalenceKey', () => {
  it('ignores the name (the reworded field that caused the pile-up)', () => {
    const a = automationEquivalenceKey('/repo', CRON, { prompt: 'Check server' });
    const b = automationEquivalenceKey('/repo', CRON, { prompt: 'Check server' });
    expect(a).toBe(b);
  });

  it('trims the prompt before comparing', () => {
    const a = automationEquivalenceKey('/repo', CRON, { prompt: 'Check server' });
    const b = automationEquivalenceKey('/repo', CRON, { prompt: '  Check server\n' });
    expect(a).toBe(b);
  });

  it('distinguishes prompt, provider, schedule, and workspace', () => {
    const base = automationEquivalenceKey('/repo', CRON, { prompt: 'Check server' });
    expect(automationEquivalenceKey('/repo', CRON, { prompt: 'Other' })).not.toBe(base);
    expect(
      automationEquivalenceKey('/repo', CRON, { prompt: 'Check server', provider: 'codex' }),
    ).not.toBe(base);
    expect(
      automationEquivalenceKey(
        '/repo',
        { type: 'cron', expression: '*/5 * * * *', timezone: 'UTC' },
        { prompt: 'Check server' },
      ),
    ).not.toBe(base);
    expect(
      automationEquivalenceKey(
        '/repo',
        { type: 'cron', expression: '0 * * * *', timezone: 'Europe/London' },
        { prompt: 'Check server' },
      ),
    ).not.toBe(base);
    expect(automationEquivalenceKey('/other', CRON, { prompt: 'Check server' })).not.toBe(base);
  });

  it('is collision-free across field boundaries', () => {
    // Naive `a|b` joins would collide these; JSON encoding must not.
    const a = automationEquivalenceKey('x', CRON, { prompt: 'y', provider: undefined });
    const b = automationEquivalenceKey('x', CRON, { prompt: 'y","z', provider: undefined });
    expect(a).not.toBe(b);
  });
});

describe('findEquivalentAutomation', () => {
  it('matches an equivalent active automation regardless of name', () => {
    const existing = makeAutomation({ id: 'keeper', name: 'Realer hourly server watch' });
    const match = findEquivalentAutomation([existing], makeInput({ name: 'reworded' }));
    expect(match?.id).toBe('keeper');
  });

  it('returns null when no candidate matches', () => {
    const existing = makeAutomation({ action: { prompt: 'Different', workingDirectory: '/repo' } });
    expect(findEquivalentAutomation([existing], makeInput())).toBeNull();
  });

  it('ignores inactive candidates', () => {
    const inactive = makeAutomation({ id: 'stale', active: false });
    expect(findEquivalentAutomation([inactive], makeInput())).toBeNull();
  });

  it('ignores webhook-triggered candidates', () => {
    const webhook = makeAutomation({
      id: 'hook',
      trigger: { kind: 'webhook', routeId: 'r1', filters: [] },
    });
    expect(findEquivalentAutomation([webhook], makeInput())).toBeNull();
  });

  it('never dedupes a webhook-triggered input', () => {
    const existing = makeAutomation();
    const webhookInput = makeInput({ trigger: { kind: 'webhook', routeId: 'r1', filters: [] } });
    expect(findEquivalentAutomation([existing], webhookInput)).toBeNull();
  });

  it('normalizes the input working directory to a workspace id (trim + lowercase)', () => {
    const existing = makeAutomation({ id: 'keeper' });
    const upper = makeInput({ action: { prompt: 'Check server', workingDirectory: '/REPO' } });
    expect(findEquivalentAutomation([existing], upper)?.id).toBe('keeper');
  });

  it('returns the earliest-created match so the keeper is stable', () => {
    const older = makeAutomation({ id: 'b-older', createdAt: 100 });
    const newer = makeAutomation({ id: 'a-newer', createdAt: 200 });
    expect(findEquivalentAutomation([newer, older], makeInput())?.id).toBe('b-older');
  });

  it('breaks a created-at tie by id', () => {
    const first = makeAutomation({ id: 'aaa', createdAt: 100 });
    const second = makeAutomation({ id: 'bbb', createdAt: 100 });
    expect(findEquivalentAutomation([second, first], makeInput())?.id).toBe('aaa');
  });
});
