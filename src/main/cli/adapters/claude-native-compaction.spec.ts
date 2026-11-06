import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeNativeCompaction, CLAUDE_NATIVE_COMPACT_FOCUS, CLAUDE_NATIVE_COMPACT_MIN_VERSION } from './claude-native-compaction';

function harness() {
  const listeners = new Set<() => void>();
  const host = {
    isResident: vi.fn(() => true),
    isTurnActive: vi.fn(() => false),
    cliVersion: vi.fn(() => '2.1.310'),
    writeRaw: vi.fn(async (_line: string) => undefined),
    onCompactionObserved: vi.fn((cb: () => void) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    }),
  };
  const compact = new ClaudeNativeCompaction(host);
  return { compact, host, listeners, boundary: () => { for (const cb of listeners) cb(); } };
}

afterEach(() => vi.useRealTimers());

describe('Claude native compaction', () => {
  it('uses the CLI version with recorded successful protocol evidence as its floor', () => {
    expect(CLAUDE_NATIVE_COMPACT_MIN_VERSION).toBe('2.1.310');
  });

  it('writes exactly one raw compact command and confirms only a provider boundary', async () => {
    const { compact, host, boundary, listeners } = harness();
    const pending = compact.compact();
    expect(host.writeRaw).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
      type: 'user', message: { role: 'user', content: `/compact ${CLAUDE_NATIVE_COMPACT_FOCUS}` },
    }));
    const settled = vi.fn();
    void pending.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    boundary();
    expect(await pending).toBe(true);
    expect(compact.knownUnsupported()).toBe(false);
    compact.observeMessage({ type: 'result' });
    expect(listeners.size).toBe(0);
  });

  it('escapes focus text as JSON without changing it', async () => {
    const { compact, host, boundary } = harness();
    const pending = compact.compact('Keep "paths"\nand commands.');
    expect(JSON.parse(host.writeRaw.mock.calls[0][0]).message.content).toBe('/compact Keep "paths"\nand commands.');
    boundary();
    compact.observeMessage({ type: 'result' });
    expect(await pending).toBe(true);
  });

  it.each(['2.1.309', '2.1.296', '', null, 'unrecognised'])('refuses unproven version %s', async version => {
    const { compact, host, listeners } = harness();
    host.cliVersion.mockReturnValue(version as string);
    expect(await compact.compact()).toBe(false);
    expect(host.writeRaw).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  it.each(['isResident', 'isTurnActive'] as const)('refuses when %s prevents a safe idle command', async key => {
    const { compact, host } = harness();
    host[key].mockReturnValue(key === 'isTurnActive');
    expect(await compact.compact()).toBe(false);
    expect(host.writeRaw).not.toHaveBeenCalled();
  });

  it('marks plain main-thread assistant text unsupported and never retries it', async () => {
    const { compact, host, listeners } = harness();
    const pending = compact.compact();
    compact.observeMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'I cannot compact.' }] } });
    expect(await pending).toBe(false);
    expect(compact.knownUnsupported()).toBe(true);
    expect(await compact.compact()).toBe(false);
    expect(host.writeRaw).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });

  it('ignores helper output and treats API failures as transient', async () => {
    const { compact, boundary } = harness();
    const pending = compact.compact();
    compact.observeMessage({ type: 'assistant', parent_tool_use_id: 'helper', message: { content: [{ type: 'text', text: 'helper output' }] } });
    boundary();
    compact.observeMessage({ type: 'result' });
    expect(await pending).toBe(true);
    const failed = compact.compact();
    compact.observeMessage({ type: 'assistant', isApiErrorMessage: true });
    compact.cancel();
    expect(await failed).toBe(false);
    expect(compact.knownUnsupported()).toBe(false);
  });

  it('rejects a result without a boundary without asserting unsupported', async () => {
    const { compact, listeners } = harness();
    const pending = compact.compact();
    compact.observeMessage({ type: 'result' });
    expect(await pending).toBe(false);
    expect(compact.knownUnsupported()).toBe(false);
    expect(listeners.size).toBe(0);
  });

  it('times out after five minutes and removes its observer', async () => {
    vi.useFakeTimers();
    const { compact, listeners } = harness();
    const pending = compact.compact();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await pending).toBe(false);
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['throw', 'reject'] as const)('cleans up a %s from the raw writer', async kind => {
    const { compact, host, listeners } = harness();
    if (kind === 'throw') host.writeRaw.mockImplementation(() => { throw new Error('synthetic write failure'); });
    else host.writeRaw.mockRejectedValue(new Error('synthetic write failure'));
    expect(await compact.compact()).toBe(false);
    expect(listeners.size).toBe(0);
    expect(compact.knownUnsupported()).toBe(false);
  });

  it('rejects concurrent compactions and retains echo filtering through the terminal result', async () => {
    const { compact, host, boundary } = harness();
    const pending = compact.compact();
    expect(await compact.compact()).toBe(false);
    boundary();
    expect(await pending).toBe(true);
    expect(await compact.compact()).toBe(false);
    expect(compact.isCompactionEcho({ type: 'user', isSynthetic: true })).toBe(true);
    expect(compact.isCompactionEcho({ type: 'user', isReplay: true })).toBe(true);
    expect(compact.isCompactionEcho({ type: 'user', content: 'ordinary input' })).toBe(false);
    compact.observeMessage({ type: 'result' });
    expect(compact.isCompactionEcho({ type: 'user', isReplay: true })).toBe(false);
    expect(host.writeRaw).toHaveBeenCalledTimes(1);
  });

  it('settles immediately on cancellation and releases timers/listeners', async () => {
    vi.useFakeTimers();
    const { compact, listeners } = harness();
    const pending = compact.compact();
    compact.cancel();
    expect(await pending).toBe(false);
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([{ is_error: true }, { subtype: 'error_during_execution' }])('rejects waiting input after a failed terminal receipt (%j)', async failure => {
    const { compact, boundary } = harness();
    const pending = compact.compact();
    boundary();
    expect(await pending).toBe(true);
    const waiting = compact.waitForCompletion().catch(error => error);
    compact.observeMessage({ type: 'result', ...failure });
    expect(await waiting).toBeInstanceOf(Error);
    expect(compact.knownUnsupported()).toBe(false);
    expect(compact.isCompacting()).toBe(false);
  });
});
