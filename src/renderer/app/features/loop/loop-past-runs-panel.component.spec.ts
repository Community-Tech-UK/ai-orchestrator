import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import type { LoopRunSummaryPayload } from '@contracts/schemas/loop';
import { CLIPBOARD_SERVICE } from '../../core/services/clipboard.service';
import { LoopIpcService } from '../../core/services/ipc/loop-ipc.service';
import { RendererPollSchedulerService } from '../../core/services/renderer-poll-scheduler.service';
import { LoopStore } from '../../core/state/loop.store';
import {
  deriveReattemptSeed,
  canCloseStoredLoopRun,
  LATER_ITERATION_CONTINUATION_LABEL,
  LoopPastRunsPanelComponent,
} from './loop-past-runs-panel.component';
import { LoopPanelOpenerService } from './loop-panel-opener.service';

/**
 * Tests for the pure reattempt-mapping helper that powers the
 * "Reattempt" button on each past loop run.
 *
 * Deliberately not a TestBed/component integration test: the project's
 * vitest config does not include the Angular compiler plugin, so
 * signal-based `input()` declarations don't generate the input metadata
 * `componentRef.setInput` needs. Other components in the codebase work
 * around this by exposing logic as pure functions and testing those
 * directly — same approach here.
 *
 * The component's `onReattempt(run)` is a thin wrapper around
 * {@link deriveReattemptSeed}: it short-circuits on disabled state, then
 * forwards the helper's output to `LoopPanelOpenerService.open`. The
 * forwarding is exercised end-to-end via the existing
 * `LoopPanelOpenerService` spec (which tests the open/consume contract)
 * and via manual UI testing.
 */
describe('deriveReattemptSeed', () => {
  it.each(['paused', 'provider-limit'] as const)('offers Close only for stored-only %s rows without an end time', (status) => {
    expect(canCloseStoredLoopRun({ status, endedAt: null }, false)).toBe(true);
    expect(canCloseStoredLoopRun({ status, endedAt: null }, true)).toBe(false);
    expect(canCloseStoredLoopRun({ status, endedAt: 123 }, false)).toBe(false);
  });
  it.each(['running', 'completed', 'attempt-failed'] as const)('does not offer Close for %s rows', (status) => {
    expect(canCloseStoredLoopRun({ status, endedAt: null }, false)).toBe(false);
  });
  it('uses human wording for the later-iteration prompt role', () => {
    expect(LATER_ITERATION_CONTINUATION_LABEL).toBe('Later-iteration continuation');
  });

  it('splits goal + continuation when the past run had a distinct iterationPrompt', () => {
    const seed = deriveReattemptSeed({
      initialPrompt: 'implement feature X',
      iterationPrompt: 'continue with fresh eyes',
    });

    expect(seed).toEqual({
      seedMessage: 'implement feature X',
      seedPrompt: 'continue with fresh eyes',
    });
  });

  it('leaves textarea empty + seeds panel only when the past run reused a single prompt', () => {
    const seed = deriveReattemptSeed({
      initialPrompt: 'one prompt for everything',
      iterationPrompt: null,
    });

    expect(seed).toEqual({
      seedMessage: '',
      seedPrompt: 'one prompt for everything',
    });
  });

  it('treats iterationPrompt === initialPrompt as "no distinct continuation"', () => {
    const seed = deriveReattemptSeed({
      initialPrompt: 'same string',
      iterationPrompt: 'same string',
    });

    expect(seed).toEqual({
      seedMessage: '',
      seedPrompt: 'same string',
    });
  });

  it('treats an empty-string iterationPrompt as "no distinct continuation"', () => {
    const seed = deriveReattemptSeed({
      initialPrompt: 'goal',
      iterationPrompt: '',
    });

    expect(seed).toEqual({
      seedMessage: '',
      seedPrompt: 'goal',
    });
  });

  it('returns null when the run has no recorded prompt', () => {
    expect(
      deriveReattemptSeed({ initialPrompt: '', iterationPrompt: null }),
    ).toBeNull();
    expect(
      deriveReattemptSeed({ initialPrompt: '', iterationPrompt: 'continuation only' }),
    ).toBeNull();
  });
});

// The class is constructed in an injection context rather than rendered: the
// action touches no signal inputs, so the limitation above does not apply.
describe('LoopPastRunsPanelComponent.onResolveBlocked', () => {
  function setup(response: { success: boolean; error?: { message: string } }) {
    const refreshHistory = vi.fn(async () => undefined);
    const resolveBlockedWorktree = vi.fn(async () => response);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: LoopStore,
          useValue: { ensureWired: vi.fn(), refreshHistory, runsForChat: () => () => [] },
        },
        { provide: LoopIpcService, useValue: { resolveBlockedWorktree } },
        { provide: CLIPBOARD_SERVICE, useValue: { copyText: vi.fn() } },
        { provide: LoopPanelOpenerService, useValue: { open: vi.fn() } },
        { provide: RendererPollSchedulerService, useValue: { register: () => () => undefined } },
      ],
    });
    const panel = TestBed.runInInjectionContext(() => new LoopPastRunsPanelComponent());
    const internals = panel as unknown as {
      onResolveBlocked(run: LoopRunSummaryPayload): Promise<void>;
      resolvingRunId(): string | null;
      resolveError(): { runId: string; message: string } | null;
    };
    return { internals, refreshHistory, resolveBlockedWorktree };
  }

  const run = { id: 'loop-1', chatId: 'chat-1' } as LoopRunSummaryPayload;

  it('resolves through IPC and refreshes the chat history', async () => {
    const { internals, refreshHistory, resolveBlockedWorktree } = setup({ success: true });

    await internals.onResolveBlocked(run);

    expect(resolveBlockedWorktree).toHaveBeenCalledWith('loop-1');
    expect(refreshHistory).toHaveBeenCalledWith('chat-1');
    expect(internals.resolveError()).toBeNull();
    expect(internals.resolvingRunId()).toBeNull();
  });

  it('shows the refusal reason on the row and does not refresh', async () => {
    const { internals, refreshHistory } = setup({
      success: false,
      error: { message: 'The worktree folder still has uncommitted changes; commit or discard them first' },
    });

    await internals.onResolveBlocked(run);

    expect(internals.resolveError()).toEqual({
      runId: 'loop-1',
      message: 'The worktree folder still has uncommitted changes; commit or discard them first',
    });
    expect(refreshHistory).not.toHaveBeenCalled();
    expect(internals.resolvingRunId()).toBeNull();
  });
});


describe('LoopPastRunsPanelComponent stored Close', () => {
  function setup(response = { success: true, data: { ok: true } }) {
    const run = { id: 'stranded', chatId: 'chat-1', status: 'paused', endedAt: null, initialPrompt: 'goal', totalIterations: 0, totalTokens: 0, totalCostCents: 0, startedAt: 100 } as LoopRunSummaryPayload;
    const cancel = vi.fn(async () => response);
    const refreshHistory = vi.fn(async () => undefined);
    const refreshRecentRuns = vi.fn(async () => ({ ok: true }));
    const activeByChat = vi.fn(() => new Map<string, { id: string }>());
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [
      { provide: LoopStore, useValue: { ensureWired: vi.fn(), refreshHistory, refreshRecentRuns, activeForChat: (id: string) => () => activeByChat().get(id), runsForChat: () => () => [run] } },
      { provide: LoopIpcService, useValue: { cancel } },
      { provide: CLIPBOARD_SERVICE, useValue: { copyText: vi.fn() } },
      { provide: LoopPanelOpenerService, useValue: { open: vi.fn() } },
      { provide: RendererPollSchedulerService, useValue: { register: () => () => undefined } },
    ] });
    const fixture = TestBed.createComponent(LoopPastRunsPanelComponent);
    Object.defineProperty(fixture.componentInstance, 'chatId', { value: () => 'chat-1' });
    const panel = fixture.componentInstance as unknown as {
      panelExpanded: { set(value: boolean): void };
      pendingClose(): LoopRunSummaryPayload | null;
      requestClose(run: LoopRunSummaryPayload): void;
      confirmClose(): Promise<void>;
      resolveError(): { runId: string; message: string } | null;
    };
    panel.panelExpanded.set(true);
    fixture.detectChanges();
    return { fixture, panel, run, cancel, refreshHistory, refreshRecentRuns, activeByChat };
  }

  it('shows an eligible Close button and asks before sending IPC', async () => {
    const { fixture, panel, run, cancel, refreshHistory, refreshRecentRuns } = setup();
    const button = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find((el) => el.textContent?.trim() === 'Close');
    expect(button).toBeDefined();
    button!.click();
    fixture.detectChanges();
    expect(panel.pendingClose()?.id).toBe(run.id);
    expect(cancel).not.toHaveBeenCalled();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Close this run? It will not be resumed.');
    await panel.confirmClose();
    expect(cancel).toHaveBeenCalledWith(run.id);
    expect(refreshHistory).toHaveBeenCalledWith(run.chatId);
    expect(refreshRecentRuns).toHaveBeenCalledOnce();
    expect(panel.pendingClose()).toBeNull();
    fixture.destroy();
  });

  it('hides Close for a live row and rechecks liveness before confirmation', async () => {
    const { fixture, panel, run, cancel, activeByChat } = setup();
    panel.requestClose(run);
    activeByChat.mockReturnValue(new Map([['chat-1', { id: run.id }]]));
    fixture.detectChanges();
    expect([...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].some((el) => el.textContent?.trim() === 'Close')).toBe(false);
    await panel.confirmClose();
    expect(cancel).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('keeps the row and displays an IPC refusal', async () => {
    const { fixture, panel, run, refreshRecentRuns } = setup({ success: true, data: { ok: false } });
    panel.requestClose(run);
    await panel.confirmClose();
    expect(panel.resolveError()?.message).toContain('could not be closed');
    expect(refreshRecentRuns).not.toHaveBeenCalled();
    fixture.destroy();
  });
});
