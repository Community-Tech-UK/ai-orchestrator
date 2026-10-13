/**
 * Runtime-change notice wording and delivery (LT-015).
 *
 * The regression these guard: the notices were sent with `adapter.sendInput`
 * only, which reaches the CLI but never renders. Live checks across three doc
 * families asserted on a transcript line that could not appear.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  announceRuntimeChangeSet,
  modelChangeNoticeText,
  providerChangeNoticeText,
  runtimeChangeNoticesFor,
  yoloNoticeText,
} from './runtime-change-notices';

describe('notice wording', () => {
  it('names the permission posture in both directions', () => {
    expect(yoloNoticeText(true)).toContain('YOLO mode enabled');
    expect(yoloNoticeText(false)).toContain('YOLO mode disabled');
  });

  it('states both providers, both models and that context carried over', () => {
    const text = providerChangeNoticeText({
      oldProvider: 'claude',
      oldModel: 'sonnet',
      newProvider: 'codex',
      newModel: 'gpt-5.6-sol',
      oldReasoningEffort: 'high',
      newReasoningEffort: 'medium',
    });
    expect(text).toContain('Provider changed from claude (model sonnet) to codex (model gpt-5.6-sol)');
    expect(text).toContain('Thinking changed from high to medium');
    expect(text).toContain('carried over from the previous provider');
  });

  it('falls back to "provider default" for an absent model or effort', () => {
    const text = providerChangeNoticeText({
      oldProvider: 'claude',
      oldModel: undefined,
      newProvider: 'codex',
      newModel: '',
      oldReasoningEffort: undefined,
      newReasoningEffort: null,
    });
    expect(text).toContain('(model provider default) to codex (model provider default)');
    expect(text).toContain('Thinking changed from provider default to provider default');
  });

  it('says context is preserved for a same-provider model change', () => {
    const text = modelChangeNoticeText({
      oldModel: 'sonnet',
      newModel: 'opus',
      oldReasoningEffort: 'low',
      newReasoningEffort: 'high',
    });
    expect(text).toContain('Model changed from sonnet to opus');
    expect(text).toContain('Conversation context has been preserved');
  });
});

describe('runtimeChangeNoticesFor', () => {
  const base = {
    isProviderSwap: false,
    yoloModeChanged: false,
    nextYoloMode: true,
    oldProvider: 'claude',
    newProvider: 'claude',
    oldModel: 'sonnet',
    newModel: 'opus',
    oldReasoningEffort: 'high' as const,
    newReasoningEffort: 'high' as const,
  };

  it('announces only the permission change for a pure yolo flip', () => {
    const notices = runtimeChangeNoticesFor({ ...base, isYoloOnlyChange: true });
    expect(notices).toHaveLength(1);
    expect(notices[0].kind).toBe('yolo-mode-changed');
  });

  it('announces a provider swap with the provider-changed kind', () => {
    const notices = runtimeChangeNoticesFor({
      ...base,
      isYoloOnlyChange: false,
      isProviderSwap: true,
      newProvider: 'codex',
    });
    expect(notices).toHaveLength(1);
    expect(notices[0].kind).toBe('provider-changed');
  });

  it('announces a model change with the model-changed kind', () => {
    const notices = runtimeChangeNoticesFor({ ...base, isYoloOnlyChange: false });
    expect(notices.map((n) => n.kind)).toEqual(['model-changed']);
  });

  it('announces both when a queued model swap and yolo flip land together', () => {
    const notices = runtimeChangeNoticesFor({
      ...base,
      isYoloOnlyChange: false,
      yoloModeChanged: true,
    });
    expect(notices.map((n) => n.kind)).toEqual(['model-changed', 'yolo-mode-changed']);
  });
});


/**
 * LT-030. The original order — `await adapter.sendInput(...)` THEN render —
 * deadlocked on a loop-bearing session: after a provider swap the loop
 * immediately reclaims the adapter, `sendInput` never resolves, and everything
 * after it is dead code. The user saw no provider-change notice at all on that
 * path, and `applyRuntimeChange` never resolved.
 */

/**
 * These target the function the reconciler ACTUALLY calls. The previous tests
 * exercised a single-notice helper that no longer has a production caller — the
 * multi-send it implied is precisely what caused LT-030.
 */
describe('announceRuntimeChangeSet (LT-030)', () => {
  const instance = { id: 'inst-1' } as never;
  const notice = (text: string, kind: string) => ({ text, kind }) as never;

  it('renders every notice, then delivers them as ONE message', async () => {
    const order: string[] = [];
    const emitSystemNotice = vi.fn((_i: unknown, text: string) => { order.push(`render:${text}`); });
    const adapter = { sendInput: vi.fn(async (t: string) => { order.push(`send:${t}`); }) } as never;

    await announceRuntimeChangeSet({
      instance, adapter, emitSystemNotice,
      notices: [notice('MODEL', 'model-changed'), notice('YOLO', 'yolo-mode-changed')],
      preamble: 'PREAMBLE',
    });

    // One send, preamble first, both notices in it.
    expect((adapter as unknown as { sendInput: { mock: { calls: string[][] } } }).sendInput.mock.calls).toHaveLength(1);
    const body = (adapter as unknown as { sendInput: { mock: { calls: string[][] } } }).sendInput.mock.calls[0][0];
    expect(body).toBe('PREAMBLE\n\nMODEL\n\nYOLO');
    // Both rendered BEFORE anything was delivered.
    expect(order.slice(0, 2)).toEqual(['render:MODEL', 'render:YOLO']);
  });

  it('queues account notice and replay context with the next prompt without starting a turn', async () => {
    const emitted: string[] = [];
    const queued: string[] = [];
    const adapter = { sendInput: vi.fn(async () => undefined), queueNextPromptContext: (text: string) => { queued.push(text); } };
    await announceRuntimeChangeSet({ instance, adapter, emitSystemNotice: (_instance, text) => { emitted.push(text); },
      notices: [notice('ACCOUNT', 'account-changed')], preamble: 'REPLAY', delivery: 'next-prompt',
    } as Parameters<typeof announceRuntimeChangeSet>[0]);
    expect(emitted).toEqual(['ACCOUNT']);
    expect(queued).toEqual(['REPLAY\n\nACCOUNT']);
    expect(adapter.sendInput).not.toHaveBeenCalled();
  });

  it('renders the divergence line too, and sends nothing when there is no body', async () => {
    const emitSystemNotice = vi.fn();
    const adapter = { sendInput: vi.fn() } as never;

    await announceRuntimeChangeSet({
      instance, adapter, emitSystemNotice, notices: [], divergence: 'DIVERGED',
    });

    expect(emitSystemNotice).toHaveBeenCalledWith(instance, 'DIVERGED',
      { kind: 'loop-provider-divergence' });
    expect((adapter as unknown as { sendInput: { mock: { calls: unknown[] } } }).sendInput.mock.calls).toHaveLength(0);
  });

  it('never throws when a render fails — the change is already applied', async () => {
    const emitSystemNotice = vi.fn(() => { throw new Error('renderer detached'); });
    const adapter = { sendInput: vi.fn(async () => undefined) } as never;

    await expect(announceRuntimeChangeSet({
      instance, adapter, emitSystemNotice,
      notices: [notice('MODEL', 'model-changed')], divergence: 'DIVERGED',
    })).resolves.toBeUndefined();
  });

  it('never throws when delivery is refused — a notice must not revert a swap', async () => {
    const emitSystemNotice = vi.fn();
    const adapter = {
      sendInput: vi.fn(async () => { throw new Error('runtime already has an active turn'); }),
    } as never;

    await expect(announceRuntimeChangeSet({
      instance, adapter, emitSystemNotice, notices: [notice('MODEL', 'model-changed')],
    })).resolves.toBeUndefined();
    expect(emitSystemNotice).toHaveBeenCalledTimes(1);
  });

  it('does not hang when the CLI never accepts the message', async () => {
    vi.useFakeTimers();
    const emitSystemNotice = vi.fn();
    const adapter = { sendInput: vi.fn(() => new Promise<void>(() => undefined)) } as never;

    const promise = announceRuntimeChangeSet({
      instance, adapter, emitSystemNotice, notices: [notice('MODEL', 'model-changed')],
    });
    expect(emitSystemNotice).toHaveBeenCalledTimes(1);   // rendered before awaiting
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  const workspaces: string[] = [];
  afterEach(() => {
    for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function workspace(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'replay-notice-'));
    workspaces.push(dir);
    return dir;
  }

  function imageInstance(dir: string) {
    return {
      id: 'inst-1',
      sessionId: 'session-1',
      workingDirectory: dir,
      outputBuffer: [{
        id: 'u1',
        type: 'user',
        content: 'please suspend this user.',
        timestamp: 1,
        attachments: [{ name: 'who.png', type: 'image/png', size: 4, data: 'data:image/png;base64,AAAA' }],
      }],
    } as never;
  }

  it('sends the original image with the replay when the new provider accepts images', async () => {
    const sent: unknown[][] = [];
    const adapter = {
      sendInput: vi.fn(async (...args: unknown[]) => { sent.push(args); }),
      getCapabilities: () => ({ vision: true }),
    };
    await announceRuntimeChangeSet({
      instance: imageInstance(workspace()),
      adapter,
      emitSystemNotice: vi.fn(),
      notices: [notice('PROVIDER', 'provider-changed')],
      preamble: 'replay preamble',
    });

    expect(sent).toHaveLength(1);
    expect(String(sent[0]?.[0])).toContain('please suspend this user.');
    expect(String(sent[0]?.[0])).toContain('who.png');
    expect(sent[0]?.[1]).toEqual([
      { name: 'who.png', type: 'image/png', size: 4, data: 'data:image/png;base64,AAAA' },
    ]);
  });

  it('saves the original image and points the replay at it when the provider refuses attachments', async () => {
    const dir = workspace();
    const sent: unknown[][] = [];
    const adapter = { sendInput: vi.fn(async (...args: unknown[]) => { sent.push(args); }) };
    await announceRuntimeChangeSet({
      instance: imageInstance(dir),
      adapter,
      emitSystemNotice: vi.fn(),
      notices: [notice('PROVIDER', 'provider-changed')],
      preamble: 'replay preamble',
    });

    const body = String(sent[0]?.[0]);
    expect(body).toContain('replay preamble');
    expect(body).toContain('please suspend this user.');
    expect(body).toContain(path.join(dir, '.claude-attachments', 'session-1', '1-who.png'));
    expect(sent[0]?.[1]).toBeUndefined();
  });

  it('does not resend images on a notice that is not replaying the conversation', async () => {
    const sent: unknown[][] = [];
    const adapter = {
      sendInput: vi.fn(async (...args: unknown[]) => { sent.push(args); }),
      getCapabilities: () => ({ vision: true }),
    };
    await announceRuntimeChangeSet({
      instance: imageInstance(workspace()),
      adapter,
      emitSystemNotice: vi.fn(),
      notices: [notice('YOLO', 'yolo-mode-changed')],
    });

    expect(String(sent[0]?.[0])).toBe('YOLO');
    expect(sent[0]?.[1]).toBeUndefined();
  });
});
