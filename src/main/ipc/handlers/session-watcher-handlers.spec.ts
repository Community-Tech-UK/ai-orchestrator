import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WatcherFlag } from '../../session-watcher/session-watcher';
import { _resetWatcherDecisionLogForTesting, hashSessionId } from '../../session-watcher/watcher-decision-log';
import { WATCHER_YES_MESSAGE } from '../../session-watcher/watcher-replies';
import { ipcMain } from 'electron';
import {
  WATCHER_TYPING_HOLD_CAP_MS, answerWatcherYes, registerSessionWatcherHandlers, setWatcherMuted, setWatcherTypingHold,
  type SessionWatcherActionDeps,
} from './session-watcher-handlers';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../../session/session-continuity', () => ({ getSessionContinuityManager: vi.fn() }));

const flagFor = (overrides: Partial<WatcherFlag> = {}): WatcherFlag => ({
  instanceId: 'inst-1', requestCount: 7, question: 'Shall I push it?', closing: 'Shall I push it?',
  stop: 'asked_before_outward_step', acceptsYes: true, since: 1, ...overrides,
});

describe('session watcher handlers', () => {
  let logDirectory: string;
  let flags: Map<string, WatcherFlag>;
  let instance: { id: string; watcherMuted?: boolean; requestCount: number } | undefined;
  let deps: SessionWatcherActionDeps;
  let sendInput: ReturnType<typeof vi.fn>;
  let hold: ReturnType<typeof vi.fn>;
  let persistMuted: ReturnType<typeof vi.fn>;
  const logLines = (): Record<string, unknown>[] => readdirSync(logDirectory)
    .flatMap((file) => readFileSync(join(logDirectory, file), 'utf8').trim().split('\n'))
    .filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);

  beforeEach(() => {
    logDirectory = mkdtempSync(join(tmpdir(), 'watcher-handlers-'));
    process.env['AIO_SESSION_WATCHER_DIR'] = logDirectory;
    _resetWatcherDecisionLogForTesting();
    flags = new Map([['inst-1', flagFor()]]);
    instance = { id: 'inst-1', requestCount: 7 };
    sendInput = vi.fn().mockResolvedValue(undefined);
    hold = vi.fn();
    persistMuted = vi.fn();
    deps = {
      getInstance: () => instance,
      sendInput: sendInput as unknown as SessionWatcherActionDeps['sendInput'],
      persistMuted: persistMuted as unknown as SessionWatcherActionDeps['persistMuted'],
      attention: { get: (id) => flags.get(id), clear: (id) => { flags.delete(id); } },
      typingHold: { set: hold as unknown as SessionWatcherActionDeps['typingHold']['set'] },
      now: () => 1_000_000,
    };
  });

  afterEach(() => {
    delete process.env['AIO_SESSION_WATCHER_DIR'];
    rmSync(logDirectory, { recursive: true, force: true });
  });

  describe('answerWatcherYes', () => {
    it('sends the fixed yes as the user\'s own answer, carrying the question it answered', async () => {
      await answerWatcherYes(deps, { instanceId: 'inst-1', requestCount: 7 });

      expect(sendInput).toHaveBeenCalledTimes(1);
      const [id, message, attachments, options] = sendInput.mock.calls[0] as [string, string, undefined, Record<string, unknown>];
      expect(id).toBe('inst-1');
      expect(message).toBe(WATCHER_YES_MESSAGE);
      expect(attachments).toBeUndefined();
      expect(options).toEqual({ watcherApproval: { question: 'Shall I push it?' } });
    });

    it('is not automatic input and has no typed-by-a-person origin', async () => {
      await answerWatcherYes(deps, { instanceId: 'inst-1', requestCount: 7 });
      const options = sendInput.mock.calls[0]?.[3] as Record<string, unknown>;
      for (const key of ['autoContinuation', 'automatedInput', 'internalSource', 'crossSessionSourceId', 'origin']) {
        expect(options).not.toHaveProperty(key);
      }
    });

    it('drops the flag and logs a "yes-clicked" follow-up with the hashed session', async () => {
      await answerWatcherYes(deps, { instanceId: 'inst-1', requestCount: 7 });
      expect(flags.has('inst-1')).toBe(false);
      expect(logLines()).toEqual([expect.objectContaining({ event: 'follow-up', kind: 'yes-clicked', session: hashSessionId('inst-1'), requestCount: 7 })]);
    });

    it('refuses a stale request count and sends nothing', async () => {
      await expect(answerWatcherYes(deps, { instanceId: 'inst-1', requestCount: 6 })).rejects.toThrow(/already been dealt with/);
      expect(sendInput).not.toHaveBeenCalled();
      expect(flags.has('inst-1')).toBe(true);
    });

    it('refuses when the session has moved on since the question was shown', async () => {
      instance = { id: 'inst-1', requestCount: 8 };
      await expect(answerWatcherYes(deps, { instanceId: 'inst-1', requestCount: 7 })).rejects.toThrow(/already been dealt with/);
      expect(sendInput).not.toHaveBeenCalled();
    });

    it('refuses a session with no flag', async () => {
      await expect(answerWatcherYes(deps, { instanceId: 'other', requestCount: 7 })).rejects.toThrow(/already been dealt with/);
      expect(sendInput).not.toHaveBeenCalled();
    });

    it('refuses a flag that a plain yes would not answer', async () => {
      flags.set('inst-1', flagFor({ acceptsYes: false, stop: 'offered_choice' }));
      await expect(answerWatcherYes(deps, { instanceId: 'inst-1', requestCount: 7 })).rejects.toThrow(/written answer/);
      expect(sendInput).not.toHaveBeenCalled();
    });

    it('keeps the flag and logs nothing when the send fails, so the user can try again', async () => {
      sendInput.mockRejectedValueOnce(new Error('session is stopping'));
      await expect(answerWatcherYes(deps, { instanceId: 'inst-1', requestCount: 7 })).rejects.toThrow('session is stopping');
      expect(flags.has('inst-1')).toBe(true);
      expect(readdirSync(logDirectory)).toEqual([]);
    });

    it('sends only once when clicked twice before the first send finishes', async () => {
      let release: () => void = () => undefined;
      sendInput.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve; }));
      const first = answerWatcherYes(deps, { instanceId: 'inst-1', requestCount: 7 });
      await expect(answerWatcherYes(deps, { instanceId: 'inst-1', requestCount: 7 })).rejects.toThrow(/already being sent/);
      release();
      await first;
      expect(sendInput).toHaveBeenCalledTimes(1);
    });
  });

  describe('setWatcherMuted', () => {
    it('sets the field on the session, saves it and drops the open flag', () => {
      setWatcherMuted(deps, { instanceId: 'inst-1', muted: true });
      expect(instance?.watcherMuted).toBe(true);
      expect(persistMuted).toHaveBeenCalledWith('inst-1', true);
      expect(flags.has('inst-1')).toBe(false);
    });

    it('logs a "muted" follow-up against the stop that was flagged', () => {
      setWatcherMuted(deps, { instanceId: 'inst-1', muted: true });
      expect(logLines()).toEqual([expect.objectContaining({ event: 'follow-up', kind: 'muted', session: hashSessionId('inst-1'), requestCount: 7 })]);
    });

    it('unmutes without touching flags or the log', () => {
      instance = { id: 'inst-1', requestCount: 7, watcherMuted: true };
      setWatcherMuted(deps, { instanceId: 'inst-1', muted: false });
      expect(instance.watcherMuted).toBe(false);
      expect(persistMuted).toHaveBeenCalledWith('inst-1', false);
      expect(flags.has('inst-1')).toBe(true);
      expect(readdirSync(logDirectory)).toEqual([]);
    });

    it('refuses a session that is not open', () => {
      instance = undefined;
      expect(() => setWatcherMuted(deps, { instanceId: 'inst-1', muted: true })).toThrow(/no longer open/);
      expect(persistMuted).not.toHaveBeenCalled();
    });
  });

  describe('setWatcherTypingHold', () => {
    it('passes a hold through', () => {
      setWatcherTypingHold(deps, { instanceId: 'inst-1', untilMs: 1_000_000 + 120_000 });
      expect(hold).toHaveBeenCalledWith('inst-1', 1_120_000);
    });

    it('caps a hold at three minutes from now', () => {
      setWatcherTypingHold(deps, { instanceId: 'inst-1', untilMs: 1_000_000 + 60 * 60_000 });
      expect(hold).toHaveBeenCalledWith('inst-1', 1_000_000 + WATCHER_TYPING_HOLD_CAP_MS);
      expect(WATCHER_TYPING_HOLD_CAP_MS).toBe(180_000);
    });

    it('passes a release (0) through', () => {
      setWatcherTypingHold(deps, { instanceId: 'inst-1', untilMs: 0 });
      expect(hold).toHaveBeenCalledWith('inst-1', 0);
    });
  });

  describe('registerSessionWatcherHandlers', () => {
    type Handler = (event: unknown, payload: unknown) => Promise<{ success: boolean; error?: { code: string } }>;
    const registered = (): Map<string, Handler> =>
      new Map(vi.mocked(ipcMain.handle).mock.calls.map(([channel, handler]) => [channel, handler as unknown as Handler]));

    it('refuses every channel for a sender that is not the main window, and does nothing', async () => {
      vi.mocked(ipcMain.handle).mockClear();
      const send = vi.fn();
      const denied = { success: false, error: { code: 'UNTRUSTED_SENDER', message: 'no', timestamp: 0 } };
      registerSessionWatcherHandlers({ getInstance: () => instance, sendInput: send, ensureTrustedSender: () => denied });
      const handlers = registered();
      expect([...handlers.keys()].sort()).toEqual([
        'session-watcher:answer-yes', 'session-watcher:list-flags', 'session-watcher:set-muted', 'session-watcher:typing-hold',
      ]);
      for (const handler of handlers.values()) {
        expect(await handler({}, { instanceId: 'inst-1', requestCount: 7, muted: true, untilMs: 1 })).toBe(denied);
      }
      expect(send).not.toHaveBeenCalled();
      expect(instance?.watcherMuted).toBeUndefined();
    });

    it('rejects a malformed payload from a trusted sender without acting', async () => {
      vi.mocked(ipcMain.handle).mockClear();
      const send = vi.fn();
      registerSessionWatcherHandlers({ getInstance: () => instance, sendInput: send, ensureTrustedSender: () => null });
      const result = await registered().get('session-watcher:answer-yes')!({}, { instanceId: 42 });
      expect(result.success).toBe(false);
      expect(send).not.toHaveBeenCalled();
    });
  });
});
