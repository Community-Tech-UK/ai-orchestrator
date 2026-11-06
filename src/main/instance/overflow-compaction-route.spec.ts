/**
 * Overflow compaction routing (A1-O, Step 16c).
 */

import { describe, expect, it, vi } from 'vitest';
import { compactForOverflow, type OverflowCompactionDeps } from './overflow-compaction-route';
import type { Instance } from '../../shared/types/instance.types';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../cli/adapters/adapter-factory', () => ({
  getCliDisplayName: (cli: string) => `Display(${cli})`,
}));

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'inst-1',
    provider: 'gemini',
    ...overrides,
  } as unknown as Instance;
}

type MockedDeps = OverflowCompactionDeps & {
  compactBuffers: ReturnType<typeof vi.fn>;
  compactInstance: ReturnType<typeof vi.fn>;
  emitSystemNotice: ReturnType<typeof vi.fn>;
};

function makeDeps(overrides: Partial<OverflowCompactionDeps> = {}): MockedDeps {
  const compactBuffers = vi.fn();
  const compactInstance = vi.fn(async () => ({ success: true, method: 'restart-with-summary' as const, resumeDelivered: true }));
  const emitSystemNotice = vi.fn();
  return {
    getInstance: () => makeInstance(),
    getAdapter: () => undefined,
    compactBuffers,
    compactInstance,
    emitSystemNotice,
    waitMs: 1,
    ...overrides,
  } as MockedDeps;
}

const resumeTurn = { text: 'finish the report', attachments: [], internalSource: undefined };

describe('compactForOverflow', () => {
  it('uses the adapter-native compaction where it exists (Codex app-server, local models)', async () => {
    const native = vi.fn(async () => true);
    const deps = makeDeps({
      getAdapter: () => ({ compactContext: native, getName: () => 'codex-app-server' }),
    });
    const outcome = await compactForOverflow(deps, 'inst-1');
    expect(native).toHaveBeenCalledOnce();
    expect(deps.compactBuffers).toHaveBeenCalledOnce();
    expect(outcome).toEqual({ method: 'native', resumeDelivered: false });
  });

  it('does not claim native recovery when the adapter declines it', async () => {
    const deps = makeDeps({ getAdapter: () => ({ compactContext: vi.fn(async () => false), getName: () => 'codex-app-server' }) });
    const outcome = await compactForOverflow(deps, 'inst-1', resumeTurn);
    expect(deps.compactInstance).toHaveBeenCalledOnce();
    expect(outcome).toEqual({ method: 'restart-with-summary', resumeDelivered: true });
  });

  it('gives Claude and OpenCode without native support buffers only', async () => {
    for (const name of ['claude-cli', 'opencode-acp']) {
      const deps = makeDeps({ getAdapter: () => ({ getName: () => name }) });
      const outcome = await compactForOverflow(deps, 'inst-1');
      expect(outcome).toEqual({ method: 'buffers-only', resumeDelivered: false });
      expect(deps.compactInstance).not.toHaveBeenCalled();
      expect(deps.emitSystemNotice).toHaveBeenCalledOnce();
    }
  });

  it('sends everyone else through the summary path carrying the resume turn', async () => {
    const deps = makeDeps({ getAdapter: () => ({ getName: () => 'gemini-cli' }) });
    const outcome = await compactForOverflow(deps, 'inst-1', resumeTurn);
    expect(deps.compactInstance).toHaveBeenCalledWith('inst-1', {
      trigger: 'overflow',
      resumeTurn,
    });
    expect(outcome).toEqual({ method: 'restart-with-summary', resumeDelivered: true });
    expect(deps.emitSystemNotice).not.toHaveBeenCalled();
  });

  it('reports resumeDelivered false when no request was interrupted', async () => {
    const deps = makeDeps();
    const outcome = await compactForOverflow(deps, 'inst-1');
    expect(outcome).toEqual({ method: 'restart-with-summary', resumeDelivered: false });
  });

  it.each([undefined, false])('does not infer delivery from a successful restart without confirmation: %s', async (resumeDelivered) => {
    const deps = makeDeps({
      compactInstance: vi.fn(async () => ({ success: true, method: 'restart-with-summary' as const, resumeDelivered })),
    });
    expect(await compactForOverflow(deps, 'inst-1', resumeTurn))
      .toEqual({ method: 'restart-with-summary', resumeDelivered: false });
  });

  it('never treats a native result as delivery of the interrupted request', async () => {
    const deps = makeDeps({
      compactInstance: vi.fn(async () => ({ success: true, method: 'native' as const, resumeDelivered: true })),
    });
    expect(await compactForOverflow(deps, 'inst-1', resumeTurn))
      .toEqual({ method: 'native', resumeDelivered: false });
  });

  it('a coordinator refusal gives buffers only plus the honest notice', async () => {
    const deps = makeDeps({
      compactInstance: vi.fn(async () => ({ success: false, method: 'native' as const, busy: true })),
    });
    const outcome = await compactForOverflow(deps, 'inst-1', resumeTurn);
    expect(outcome).toEqual({ method: 'buffers-only', resumeDelivered: false });
    expect(deps.compactBuffers).toHaveBeenCalledOnce();
    expect(deps.emitSystemNotice).toHaveBeenCalledWith(
      expect.anything(),
      "Trimmed Harness's copy of the history; Display(gemini)'s own session is unchanged.",
    );
  });

  it('retries once after a bounded wait when a live turn blocked compaction', async () => {
    const compactInstance = vi.fn()
      .mockResolvedValueOnce({ success: false, method: 'native' as const, busy: true })
      .mockResolvedValueOnce({ success: true, method: 'restart-with-summary' as const, resumeDelivered: true });
    const deps = makeDeps({ compactInstance });
    const outcome = await compactForOverflow(deps, 'inst-1', resumeTurn);
    expect(compactInstance).toHaveBeenCalledTimes(2);
    expect(outcome.resumeDelivered).toBe(true);
  });
});
