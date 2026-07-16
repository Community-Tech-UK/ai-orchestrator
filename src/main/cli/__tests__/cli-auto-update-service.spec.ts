/**
 * provider-model-auto-update Phase 2 — auto-apply policy.
 *
 * The auto-update service watches the update poller and, only when the user has
 * opted into `cliUpdatePolicy: 'auto'`, applies SAFE updates unattended. These
 * tests pin the guardrails: policy gating, safe-strategy-only, active-session
 * skip, per-target backoff, and re-entrancy.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliAutoUpdateService, type CliAutoUpdateServiceDeps } from '../cli-auto-update-service';
import type { CliUpdatePillEntry, CliUpdatePillState } from '../../../shared/types/diagnostics.types';
import type { CliUpdateStrategy } from '../../../shared/types/diagnostics.types';
import type { CliUpdatePolicy } from '../../../shared/types/settings.types';
import type { CliType } from '../cli-detection';

function entry(
  cli: string,
  strategy: CliUpdateStrategy | undefined,
  overrides: Partial<CliUpdatePillEntry> = {},
): CliUpdatePillEntry {
  return {
    cli,
    displayName: cli,
    currentVersion: '1.0.0',
    latestVersion: '2.0.0',
    updateAvailable: true,
    updatePlan: {
      cli,
      displayName: cli,
      supported: true,
      strategy,
    },
    ...overrides,
  };
}

function state(entries: CliUpdatePillEntry[]): CliUpdatePillState {
  return { generatedAt: 0, count: entries.filter((e) => e.updateAvailable).length, entries };
}

interface Harness {
  service: CliAutoUpdateService;
  updateOne: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  emit: (s: CliUpdatePillState) => void;
  firePolicyChange: () => void;
  setPolicy: (p: CliUpdatePolicy) => void;
  setActive: (n: number) => void;
}

function makeHarness(opts: {
  policy?: CliUpdatePolicy;
  active?: number;
  updateResult?: 'updated' | 'failed' | 'skipped';
  now?: () => number;
} = {}): Harness {
  let policy: CliUpdatePolicy = opts.policy ?? 'auto';
  let active = opts.active ?? 0;
  let onChangeCb: ((s: CliUpdatePillState) => void) | null = null;
  let policyCb: (() => void) | null = null;
  let current: CliUpdatePillState = state([]);

  const updateOne = vi.fn(async (cli: CliType) => ({
    cli,
    displayName: cli,
    status: opts.updateResult ?? 'updated',
    message: 'ok',
    durationMs: 1,
  }));
  const refresh = vi.fn(async () => current);

  const deps: CliAutoUpdateServiceDeps = {
    getPolicy: () => policy,
    getActiveInstanceCount: () => active,
    pollService: {
      onChange: (cb) => {
        onChangeCb = cb;
        return () => {
          onChangeCb = null;
        };
      },
      getState: () => current,
      refresh,
    },
    updateService: { updateOne },
    subscribePolicyChanges: (cb) => {
      policyCb = cb;
      return () => {
        policyCb = null;
      };
    },
    now: opts.now ?? (() => 1_000),
  };

  const service = new CliAutoUpdateService(deps);
  service.start();

  return {
    service,
    updateOne,
    refresh,
    emit: (s) => {
      current = s;
      onChangeCb?.(s);
    },
    firePolicyChange: () => policyCb?.(),
    setPolicy: (p) => {
      policy = p;
    },
    setActive: (n) => {
      active = n;
    },
  };
}

describe('CliAutoUpdateService (provider-model Phase 2)', () => {
  afterEach(() => {
    CliAutoUpdateService._resetForTesting();
    vi.restoreAllMocks();
  });

  it('applies a safe npm update when policy is auto and no instances are active', async () => {
    const h = makeHarness({ policy: 'auto', active: 0 });
    await h.service.handleState(state([entry('codex', 'npm')]));
    expect(h.updateOne).toHaveBeenCalledWith('codex');
    expect(h.refresh).toHaveBeenCalled();
  });

  it('does nothing when policy is notify', async () => {
    const h = makeHarness({ policy: 'notify' });
    await h.service.handleState(state([entry('codex', 'npm')]));
    expect(h.updateOne).not.toHaveBeenCalled();
  });

  it('does nothing when policy is off', async () => {
    const h = makeHarness({ policy: 'off' });
    await h.service.handleState(state([entry('codex', 'npm')]));
    expect(h.updateOne).not.toHaveBeenCalled();
  });

  it('skips unsafe strategies (homebrew, gh-extension, unknown)', async () => {
    const h = makeHarness({ policy: 'auto' });
    await h.service.handleState(
      state([
        entry('ollama', 'homebrew'),
        entry('copilot', 'gh-extension'),
        entry('weird', undefined),
      ]),
    );
    expect(h.updateOne).not.toHaveBeenCalled();
  });

  it('applies the safe one but not the unsafe ones in a mixed batch', async () => {
    const h = makeHarness({ policy: 'auto' });
    await h.service.handleState(state([entry('ollama', 'homebrew'), entry('codex', 'pnpm')]));
    expect(h.updateOne).toHaveBeenCalledTimes(1);
    expect(h.updateOne).toHaveBeenCalledWith('codex');
  });

  it('does not update while an instance is active', async () => {
    const h = makeHarness({ policy: 'auto', active: 1 });
    await h.service.handleState(state([entry('codex', 'npm')]));
    expect(h.updateOne).not.toHaveBeenCalled();
  });

  it('ignores entries that are not flagged updateAvailable', async () => {
    const h = makeHarness({ policy: 'auto' });
    await h.service.handleState(state([entry('codex', 'npm', { updateAvailable: false })]));
    expect(h.updateOne).not.toHaveBeenCalled();
  });

  it('backs off a target after one attempt (no repeated install of the same version)', async () => {
    const h = makeHarness({ policy: 'auto', now: () => 1_000 });
    const s = state([entry('codex', 'npm')]);
    await h.service.handleState(s);
    await h.service.handleState(s); // same cli@version → must not retry
    expect(h.updateOne).toHaveBeenCalledTimes(1);
  });

  it('retries a NEW version after backing off the previous one', async () => {
    const h = makeHarness({ policy: 'auto' });
    await h.service.handleState(state([entry('codex', 'npm', { latestVersion: '2.0.0' })]));
    await h.service.handleState(state([entry('codex', 'npm', { latestVersion: '3.0.0' })]));
    expect(h.updateOne).toHaveBeenCalledTimes(2);
  });

  it('backs off a FAILED target so it does not loop', async () => {
    const h = makeHarness({ policy: 'auto', updateResult: 'failed' });
    const s = state([entry('codex', 'npm')]);
    await h.service.handleState(s);
    await h.service.handleState(s);
    expect(h.updateOne).toHaveBeenCalledTimes(1);
  });

  it('evaluates the latest poll state when policy flips to auto', async () => {
    const h = makeHarness({ policy: 'notify' });
    h.emit(state([entry('codex', 'npm')]));
    expect(h.updateOne).not.toHaveBeenCalled();
    h.setPolicy('auto');
    h.firePolicyChange();
    // allow the async handler kicked off by the policy-change callback to settle
    await Promise.resolve();
    await Promise.resolve();
    expect(h.updateOne).toHaveBeenCalledWith('codex');
  });

  it('stop() unsubscribes so later poll emissions are ignored', async () => {
    const h = makeHarness({ policy: 'auto' });
    h.service.stop();
    h.emit(state([entry('codex', 'npm')]));
    await Promise.resolve();
    expect(h.updateOne).not.toHaveBeenCalled();
  });
});
