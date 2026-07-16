/**
 * Fable WS7 Phase A — loop provider failover.
 */

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyLoopError } from '../core/loop-error-classification';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';
import {
  attemptLoopFailover,
  decideLoopFailover,
  type AttemptLoopFailoverDeps,
} from './loop-failover';

function makeState(over: Partial<LoopState> = {}): LoopState {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-failover-'));
  const config = defaultLoopConfig(workspace, 'fix the widget');
  config.provider = 'claude';
  config.failover = { enabled: true, providers: ['codex', 'gemini'], maxSwitches: 1 };
  return {
    id: 'loop-1',
    chatId: 'chat-1',
    status: 'running',
    config,
    ...over,
  } as unknown as LoopState;
}

function makeDeps(over: Partial<AttemptLoopFailoverDeps> = {}): AttemptLoopFailoverDeps {
  return {
    classify: (err) => classifyLoopError(err, { provider: 'claude' }),
    selectTarget: ({ candidates, from, veto }) => {
      const considered: Array<{ provider: string; vetoReason: string | null }> = [];
      for (const candidate of candidates) {
        if (candidate === from) { considered.push({ provider: candidate, vetoReason: 'is_current_provider' }); continue; }
        const vetoReason = veto?.(candidate) ?? null;
        considered.push({ provider: candidate, vetoReason });
        if (vetoReason === null) return { to: candidate, considered };
      }
      return { to: null, considered };
    },
    isProviderParked: () => false,
    installedProviders: new Set(['claude', 'codex', 'gemini']),
    notify: vi.fn(),
    emitActivity: vi.fn(),
    ...over,
  };
}

describe('decideLoopFailover', () => {
  const base = {
    shouldFailover: true,
    reason: 'auth',
    config: { enabled: true, providers: ['codex' as const], maxSwitches: 1 },
    currentProvider: 'claude',
    switchesSoFar: 0,
  };

  it('is inert by default (disabled / undefined config)', () => {
    expect(decideLoopFailover({ ...base, config: undefined }).action).toBe('none');
    expect(decideLoopFailover({ ...base, config: { ...base.config, enabled: false } }).action).toBe('none');
  });

  it('refuses non-failover classifications', () => {
    const decision = decideLoopFailover({ ...base, shouldFailover: false, reason: 'validation' });
    expect(decision.action).toBe('none');
    expect(decision.note).toContain('not a failover category');
  });

  it('enforces the per-run switch budget', () => {
    const decision = decideLoopFailover({ ...base, switchesSoFar: 1 });
    expect(decision.action).toBe('none');
    expect(decision.note).toContain('budget exhausted');
  });

  it('excludes the current provider from candidates', () => {
    const decision = decideLoopFailover({
      ...base,
      config: { enabled: true, providers: ['claude', 'codex'], maxSwitches: 2 },
    });
    expect(decision).toMatchObject({ action: 'try-switch', candidates: ['codex'] });
  });

  it('yields none when only the current provider is configured', () => {
    const decision = decideLoopFailover({ ...base, config: { enabled: true, providers: ['claude'], maxSwitches: 1 } });
    expect(decision.action).toBe('none');
  });
});

describe('attemptLoopFailover (category matrix with the REAL classifier)', () => {
  it('an auth failure on an opt-in run switches provider, consumes budget, tags, notifies', () => {
    const state = makeState();
    const deps = makeDeps();
    const outcome = attemptLoopFailover(state, new Error('401 unauthorized: invalid api key'), 3, 'IMPLEMENT', deps);

    expect(outcome).toMatchObject({ switched: true, from: 'claude', to: 'codex' });
    expect(state.config.provider).toBe('codex');
    expect(state.failoverSwitches).toBe(1);
    expect(deps.emitActivity).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('claude → codex'),
    }));
    expect(deps.notify).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringContaining('codex'),
    }));
  });

  it('a validation failure NEVER switches (guardrail category)', () => {
    const state = makeState();
    const outcome = attemptLoopFailover(state, new Error('validation failed: invalid payload schema'), 3, 'IMPLEMENT', makeDeps());
    expect(outcome.switched).toBe(false);
    expect(state.config.provider).toBe('claude');
    expect(state.failoverSwitches).toBeUndefined();
  });

  it('maxSwitches exhaustion leaves the run to pause/terminate as today', () => {
    const state = makeState({ failoverSwitches: 1 } as Partial<LoopState>);
    const outcome = attemptLoopFailover(state, new Error('billing: credits exhausted'), 4, 'IMPLEMENT', makeDeps());
    expect(outcome.switched).toBe(false);
    expect(outcome.note).toContain('budget exhausted');
  });

  it('skips a provider parked in the WS2 limit ledger and takes the next candidate', () => {
    const state = makeState();
    const deps = makeDeps({ isProviderParked: (provider) => provider === 'codex' });
    const outcome = attemptLoopFailover(state, new Error('401 unauthorized: invalid api key'), 3, 'IMPLEMENT', deps);
    expect(outcome).toMatchObject({ switched: true, to: 'gemini' });
  });

  it('skips providers whose CLI is not installed; none eligible = no switch', () => {
    const state = makeState();
    const deps = makeDeps({ installedProviders: new Set(['claude']) });
    const outcome = attemptLoopFailover(state, new Error('401 unauthorized: invalid api key'), 3, 'IMPLEMENT', deps);
    expect(outcome.switched).toBe(false);
    expect(outcome.note).toContain('cli_not_installed');
    expect(state.config.provider).toBe('claude');
  });

  it('is inert when the run did not opt in (default config)', () => {
    const state = makeState();
    state.config.failover = { enabled: false, providers: ['codex'], maxSwitches: 1 };
    const outcome = attemptLoopFailover(state, new Error('401 unauthorized'), 3, 'IMPLEMENT', makeDeps());
    expect(outcome.switched).toBe(false);
  });

  it('never throws — a failing dep degrades to no-switch', () => {
    const state = makeState();
    const deps = makeDeps({ selectTarget: () => { throw new Error('manager offline'); } });
    const outcome = attemptLoopFailover(state, new Error('401 unauthorized: invalid api key'), 3, 'IMPLEMENT', deps);
    expect(outcome.switched).toBe(false);
    expect(outcome.note).toContain('manager offline');
  });
});
