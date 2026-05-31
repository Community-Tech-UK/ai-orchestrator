import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { LspFeedbackCoordinator, type LspDiagnostic, type LspFeedbackDeps } from '../lsp-feedback-coordinator';
import type { FileEditedEvent } from '../../instance/file-edit-bus';

function harness(overrides: Partial<LspFeedbackDeps> = {}) {
  let listener: ((e: FileEditedEvent) => void) | null = null;
  const inject = vi.fn();
  const getDiagnostics = vi.fn<(f: string) => Promise<LspDiagnostic[] | null>>(async () => []);
  const deps: LspFeedbackDeps = {
    isEnabled: () => true,
    isInstanceIdle: () => true,
    getDiagnostics,
    injectFeedback: inject,
    subscribe: (cb) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    debounceMs: 100,
    ...overrides,
  };
  const coord = new LspFeedbackCoordinator(deps);
  coord.attach();
  const edit = (e: Partial<FileEditedEvent> = {}) =>
    listener?.({ instanceId: 'i1', filePath: '/p/a.ts', toolName: 'Edit', provider: 'claude', ...e });
  return { coord, edit, inject, getDiagnostics };
}

const errDiag = (message: string, line = 1): LspDiagnostic => ({ severity: 'error', message, line });

describe('LspFeedbackCoordinator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('injects a note when edited files have errors (after debounce)', async () => {
    const { edit, inject, getDiagnostics } = harness();
    getDiagnostics.mockResolvedValue([errDiag('Type X is not assignable to Y', 12)]);
    edit({ filePath: '/p/a.ts' });
    await vi.advanceTimersByTimeAsync(100);
    expect(inject).toHaveBeenCalledOnce();
    const note = inject.mock.calls[0][1] as string;
    expect(note).toMatch(/LSP reported errors/);
    expect(note).toContain('/p/a.ts:12: Type X is not assignable to Y');
  });

  it('does nothing when disabled', async () => {
    const { edit, inject, getDiagnostics } = harness({ isEnabled: () => false });
    getDiagnostics.mockResolvedValue([errDiag('boom')]);
    edit();
    await vi.advanceTimersByTimeAsync(200);
    expect(inject).not.toHaveBeenCalled();
  });

  it('does not inject mid-turn (instance not idle)', async () => {
    const { edit, inject, getDiagnostics } = harness({ isInstanceIdle: () => false });
    getDiagnostics.mockResolvedValue([errDiag('boom')]);
    edit();
    await vi.advanceTimersByTimeAsync(200);
    expect(inject).not.toHaveBeenCalled();
  });

  it('ignores warnings/hints — only errors trigger feedback', async () => {
    const { edit, inject, getDiagnostics } = harness();
    getDiagnostics.mockResolvedValue([
      { severity: 'warning', message: 'unused var' },
      { severity: 'hint', message: 'prefer const' },
    ]);
    edit();
    await vi.advanceTimersByTimeAsync(200);
    expect(inject).not.toHaveBeenCalled();
  });

  it('coalesces a burst of edits into a single check', async () => {
    const { edit, getDiagnostics, inject } = harness();
    getDiagnostics.mockResolvedValue([errDiag('e')]);
    edit({ filePath: '/p/a.ts' });
    edit({ filePath: '/p/b.ts' });
    edit({ filePath: '/p/a.ts' });
    await vi.advanceTimersByTimeAsync(100);
    // Two distinct files checked once each, one injection.
    expect(getDiagnostics).toHaveBeenCalledTimes(2);
    expect(inject).toHaveBeenCalledOnce();
  });

  it('does not re-inject an identical error set (loop guard)', async () => {
    const { edit, inject, getDiagnostics } = harness();
    getDiagnostics.mockResolvedValue([errDiag('same error', 3)]);
    edit();
    await vi.advanceTimersByTimeAsync(100);
    expect(inject).toHaveBeenCalledOnce();

    edit(); // same file, same diagnostics
    await vi.advanceTimersByTimeAsync(100);
    expect(inject).toHaveBeenCalledOnce(); // not called again
  });

  it('injects again when the error set changes', async () => {
    const { edit, inject, getDiagnostics } = harness();
    getDiagnostics.mockResolvedValue([errDiag('first', 1)]);
    edit();
    await vi.advanceTimersByTimeAsync(100);
    expect(inject).toHaveBeenCalledTimes(1);

    getDiagnostics.mockResolvedValue([errDiag('second', 2)]);
    edit();
    await vi.advanceTimersByTimeAsync(100);
    expect(inject).toHaveBeenCalledTimes(2);
  });

  it('skips files where the LSP is unavailable (null)', async () => {
    const { edit, inject, getDiagnostics } = harness();
    getDiagnostics.mockResolvedValue(null);
    edit();
    await vi.advanceTimersByTimeAsync(100);
    expect(inject).not.toHaveBeenCalled();
  });

  it('stops listening after dispose', async () => {
    const { coord, edit, inject, getDiagnostics } = harness();
    getDiagnostics.mockResolvedValue([errDiag('e')]);
    coord.dispose();
    edit();
    await vi.advanceTimersByTimeAsync(200);
    expect(inject).not.toHaveBeenCalled();
  });
});
