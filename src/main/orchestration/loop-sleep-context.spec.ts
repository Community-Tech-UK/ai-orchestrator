import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { observeClaudeCacheLifetime } from '../cli/adapters/claude-cache-lifetime';
import { registerLoopSleepContext } from './loop-sleep-context';
import { PreSleepContext, setPreSleepContext } from '../context/pre-sleep-context';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

const MIN = 60_000;
const NOW = 5_000_000;

class FakeAdapter extends EventEmitter {
  constructor(private readonly name: string, private readonly used: number | null) { super(); }
  getName(): string { return this.name; }
  getLastContextUsage() {
    return this.used === null
      ? { status: 'unknown' as const, reason: 'not-reported' as const }
      : { status: 'known' as const, used: this.used, total: 1_000_000, source: 'provider-turn' as const };
  }
}

function setup(adapter: unknown, options: { borrowed?: boolean; chatId?: string } = {}) {
  const coordinator = Object.assign(new EventEmitter(), {
    getLoop: vi.fn(() => ({ chatId: options.chatId ?? 'chat-1' })),
    requestContextReset: vi.fn(),
  });
  const noteChatSleep = vi.fn();
  registerLoopSleepContext({
    coordinator,
    getPersistentAdapter: () => adapter,
    isBorrowedChat: () => options.borrowed === true,
    noteChatSleep,
    now: () => NOW,
  });
  const wakeUp = (minutes: number) => coordinator.emit('loop:wakeup-scheduled', { loopRunId: 'loop-1', resumeAt: NOW + minutes * MIN });
  const quotaPark = (minutes: number, willResume = true) =>
    coordinator.emit('loop:provider-limit', { loopRunId: 'loop-1', resumeAt: NOW + minutes * MIN, willResume });
  return { coordinator, noteChatSleep, wakeUp, quotaPark };
}

describe('loop sleep context', () => {
  it('revokes a borrowed chat compaction when its sleeping loop is cancelled', async () => {
    const instance = { provider: 'claude', status: 'busy', contextUsage: { used: 260_000, total: 1_000_000, percentage: 26, occupancyReported: true } };
    const compact = vi.fn(async () => true);
    const service = new PreSleepContext({ getInstance: () => instance, getCacheLifetimeMs: () => null,
      hasPendingWork: () => false, compact, now: () => NOW });
    setPreSleepContext(service);
    try {
      const noted = vi.spyOn(service, 'note');
      const coordinator = Object.assign(new EventEmitter(), { getLoop: () => ({ chatId: 'chat-1' }) });
      registerLoopSleepContext({ coordinator, getPersistentAdapter: () => undefined, isBorrowedChat: () => true, now: () => NOW });
      coordinator.emit('loop:wakeup-scheduled', { loopRunId: 'loop-1', resumeAt: NOW + 180 * MIN });
      await noted.mock.results[0]!.value;
      coordinator.emit('loop:cancelled', { loopRunId: 'loop-1' });
      instance.status = 'idle';
      await service.onIdle('chat-1');
      expect(compact).not.toHaveBeenCalled();
    } finally { setPreSleepContext(null); }
  });
  it('starts the next iteration fresh when a large Claude loop session will sleep past its cache', () => {
    const { coordinator, wakeUp } = setup(new FakeAdapter('claude-cli', 260_000));
    wakeUp(180);
    expect(coordinator.requestContextReset).toHaveBeenCalledWith('loop-1');
  });

  it('does the same on a quota park, because a fresh session needs no model call', () => {
    const { coordinator, quotaPark } = setup(new FakeAdapter('claude-cli', 260_000));
    quotaPark(300);
    expect(coordinator.requestContextReset).toHaveBeenCalledWith('loop-1');
  });

  it('keeps a small or unmeasured session, and a sleep shorter than the cache', () => {
    const small = setup(new FakeAdapter('claude-cli', 150_000));
    small.wakeUp(180);
    const unknown = setup(new FakeAdapter('claude-cli', null));
    unknown.wakeUp(180);
    const short = setup(new FakeAdapter('claude-cli', 260_000));
    short.wakeUp(30);
    for (const harness of [small, unknown, short]) expect(harness.coordinator.requestContextReset).not.toHaveBeenCalled();
  });

  it('uses the lifetime the session measured', () => {
    const adapter = new FakeAdapter('claude-cli', 260_000);
    observeClaudeCacheLifetime(adapter, {
      type: 'assistant',
      message: { usage: { cache_creation: { ephemeral_5m_input_tokens: 9_000, ephemeral_1h_input_tokens: 0 } } },
    }, NOW);
    const { coordinator, wakeUp } = setup(adapter);
    wakeUp(30); // under an hour, but past a measured 5 minute cache
    expect(coordinator.requestContextReset).toHaveBeenCalledWith('loop-1');
  });

  it('ignores other providers and non-resuming parks', () => {
    const codex = setup(new FakeAdapter('codex-app-server', 900_000));
    codex.wakeUp(300);
    const ended = setup(new FakeAdapter('claude-cli', 260_000));
    ended.quotaPark(300, false);
    expect(codex.coordinator.requestContextReset).not.toHaveBeenCalled();
    expect(ended.coordinator.requestContextReset).not.toHaveBeenCalled();
  });

  it('hands a borrowed chat to the general compaction on a scheduled wake-up only', () => {
    const wake = setup(undefined, { borrowed: true, chatId: 'chat-9' });
    wake.wakeUp(180);
    expect(wake.noteChatSleep).toHaveBeenCalledWith('chat-9', NOW + 180 * MIN);

    const park = setup(undefined, { borrowed: true });
    park.quotaPark(180); // the account is out of allowance: a compaction cannot run
    expect(park.noteChatSleep).not.toHaveBeenCalled();

    const own = setup(undefined, { borrowed: false });
    own.wakeUp(180);
    expect(own.noteChatSleep).not.toHaveBeenCalled();
  });
});
