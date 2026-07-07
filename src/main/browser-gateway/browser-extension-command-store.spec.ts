import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserExtensionCommandStore } from './browser-extension-command-store';

describe('BrowserExtensionCommandStore', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers a queued tab command to the extension and resolves the caller result', async () => {
    const store = new BrowserExtensionCommandStore();
    const pending = store.sendCommand({
      command: 'click',
      target: {
        profileId: 'existing-tab:7:42',
        targetId: 'existing-tab:7:42:target',
        tabId: 42,
        windowId: 7,
      },
      payload: {
        selector: '#submit',
      },
      timeoutMs: 1_000,
    });

    const command = await store.pollCommand({ timeoutMs: 1 });

    expect(command).toMatchObject({
      command: 'click',
      target: {
        tabId: 42,
        windowId: 7,
      },
      payload: {
        selector: '#submit',
      },
    });

    store.resolveCommand({
      commandId: command!.id,
      ok: true,
      result: {
        clicked: true,
      },
    });

    await expect(pending).resolves.toEqual({
      clicked: true,
    });
  });

  it('delivers an extension execution timeout separately from the caller wait budget', async () => {
    const store = new BrowserExtensionCommandStore();
    const pending = store.sendCommand({
      command: 'accessibility_snapshot',
      target: {
        profileId: 'existing-tab:7:42',
        targetId: 'existing-tab:7:42:target',
        tabId: 42,
        windowId: 7,
      },
      timeoutMs: 65_000,
      executionTimeoutMs: 60_000,
    } as never);

    const command = await store.pollCommand({ timeoutMs: 1 });

    expect(command).toMatchObject({
      command: 'accessibility_snapshot',
      timeoutMs: 60_000,
    });

    store.resolveCommand({
      commandId: command!.id,
      ok: true,
      result: { nodes: [] },
    });
    await expect(pending).resolves.toEqual({ nodes: [] });
  });

  it('removes an undelivered queued command when the caller wait budget expires', async () => {
    vi.useFakeTimers();
    const store = new BrowserExtensionCommandStore();
    const pending = store.sendCommand({
      command: 'accessibility_snapshot',
      target: {
        profileId: 'existing-tab:7:42',
        targetId: 'existing-tab:7:42:target',
        tabId: 42,
        windowId: 7,
      },
      timeoutMs: 10,
      executionTimeoutMs: 60_000,
    } as never);
    // Never handed to a poller ⇒ the command provably did not run, and the
    // rejection says so (distinct from a delivered-but-unanswered timeout).
    const rejected = expect(pending).rejects.toThrow('browser_extension_command_not_delivered');

    await vi.advanceTimersByTimeAsync(10);
    await rejected;

    const poll = store.pollCommand({ timeoutMs: 1 });
    await vi.advanceTimersByTimeAsync(1);
    await expect(poll).resolves.toBeNull();
  });

  it('waits out an extension channel gap when undeliveredWaitMs exceeds timeoutMs', async () => {
    vi.useFakeTimers();
    const store = new BrowserExtensionCommandStore();
    const pending = store.sendCommand({
      command: 'open_tab',
      payload: { url: 'https://example.com/' },
      timeoutMs: 30_000,
      undeliveredWaitMs: 90_000,
    });
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });

    // At 30s (the old failure point) the command is still queued and alive.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);

    // Channel recovers at 60s (one extension alarm cycle) and polls.
    await vi.advanceTimersByTimeAsync(30_000);
    const command = await store.pollCommand({ timeoutMs: 1 });
    expect(command).toMatchObject({ command: 'open_tab' });

    store.resolveCommand({ commandId: command!.id, ok: true, result: { tabId: 9 } });
    await expect(pending).resolves.toEqual({ tabId: 9 });
  });

  it('grants a late-delivered command its full execution window before timing out as delivered', async () => {
    vi.useFakeTimers();
    const store = new BrowserExtensionCommandStore();
    const pending = store.sendCommand({
      command: 'open_tab',
      payload: { url: 'https://example.com/' },
      timeoutMs: 30_000,
      undeliveredWaitMs: 90_000,
    });
    const rejected = expect(pending).rejects.toThrow('browser_extension_command_timeout');

    // Delivered at 89s — just inside the undelivered budget…
    await vi.advanceTimersByTimeAsync(89_000);
    const command = await store.pollCommand({ timeoutMs: 1 });
    expect(command).toMatchObject({ command: 'open_tab' });

    // …so the delivered-timeout clock restarts: still pending at 89s+29s…
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(settled).toBe(false);

    // …and rejects as a DELIVERED timeout (maybe applied) at 89s+30s.
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
  });

  it('fails an undelivered command as not_delivered even when it is a mutation', async () => {
    vi.useFakeTimers();
    const store = new BrowserExtensionCommandStore();
    const pending = store.sendCommand({
      command: 'click',
      payload: { selector: '#submit' },
      timeoutMs: 10,
      undeliveredWaitMs: 20,
    });
    const rejected = expect(pending).rejects.toThrow('browser_extension_command_not_delivered');

    await vi.advanceTimersByTimeAsync(20);
    await rejected;
  });

  it('enforces receipt acks only on queues that have proven receipt support', async () => {
    vi.useFakeTimers();
    const store = new BrowserExtensionCommandStore();

    // First command: queue has never sent a receipt — no enforcement, the
    // delivered command gets the classic full execution window.
    const first = store.sendCommand({ queueKey: 'node:node-1', command: 'click', timeoutMs: 30_000 });
    const firstRejected = expect(first).rejects.toThrow('browser_extension_command_timeout');
    const firstCommand = await store.pollCommand('node:node-1', { timeoutMs: 1 });
    // The (old-build) extension answers without ever acking receipt…
    await vi.advanceTimersByTimeAsync(20_000);
    // …and at 20s the command is still alive: no receipt watchdog fired.
    store.resolveCommand({
      queueKey: 'node:node-1', commandId: firstCommand!.id, ok: false, error: 'browser_extension_command_timeout',
    });
    await firstRejected;

    // A receipt registers the queue as receipt-capable.
    const second = store.sendCommand({ queueKey: 'node:node-1', command: 'click', timeoutMs: 30_000 });
    const secondCommand = await store.pollCommand('node:node-1', { timeoutMs: 1 });
    store.markReceived('node:node-1', secondCommand!.id);
    store.resolveCommand({ queueKey: 'node:node-1', commandId: secondCommand!.id, ok: true, result: { ok: 1 } });
    await expect(second).resolves.toEqual({ ok: 1 });

    // From now on, a delivered command with no receipt fails fast as a lost
    // handoff instead of burning the full window as maybe-applied.
    const third = store.sendCommand({ queueKey: 'node:node-1', command: 'click', timeoutMs: 30_000 });
    const thirdRejected = expect(third).rejects.toThrow('browser_extension_command_receipt_missing');
    await store.pollCommand('node:node-1', { timeoutMs: 1 });
    await vi.advanceTimersByTimeAsync(15_000);
    await thirdRejected;
  });

  it('gives a receipt-acked command its full execution window', async () => {
    vi.useFakeTimers();
    const store = new BrowserExtensionCommandStore();
    // Prove receipt capability first.
    const warmup = store.sendCommand({ queueKey: 'node:node-1', command: 'snapshot', timeoutMs: 10_000 });
    const warmupCommand = await store.pollCommand('node:node-1', { timeoutMs: 1 });
    store.markReceived('node:node-1', warmupCommand!.id);
    store.resolveCommand({ queueKey: 'node:node-1', commandId: warmupCommand!.id, ok: true, result: {} });
    await warmup;

    const pending = store.sendCommand({ queueKey: 'node:node-1', command: 'snapshot', timeoutMs: 30_000 });
    const command = await store.pollCommand('node:node-1', { timeoutMs: 1 });
    // Receipt arrives at 14s — just inside the receipt window…
    await vi.advanceTimersByTimeAsync(14_000);
    store.markReceived('node:node-1', command!.id);
    // …and the command survives well past the receipt window, resolving at 40s.
    await vi.advanceTimersByTimeAsync(26_000);
    store.resolveCommand({ queueKey: 'node:node-1', commandId: command!.id, ok: true, result: { late: true } });
    await expect(pending).resolves.toEqual({ late: true });
  });

  it('never leaves a command timer-less when a receipt lands before delivery', async () => {
    // Today markDelivered always runs synchronously at handoff, so a receipt
    // cannot precede it — but if that ordering ever breaks, the delivered
    // command must still carry a live watchdog rather than hang forever.
    vi.useFakeTimers();
    const store = new BrowserExtensionCommandStore();
    // Prove receipt capability first.
    const warmup = store.sendCommand({ queueKey: 'node:node-1', command: 'snapshot', timeoutMs: 10_000 });
    const warmupCommand = await store.pollCommand('node:node-1', { timeoutMs: 1 });
    store.markReceived('node:node-1', warmupCommand!.id);
    store.resolveCommand({ queueKey: 'node:node-1', commandId: warmupCommand!.id, ok: true, result: {} });
    await warmup;

    // Command sits queued (no poller yet); the receipt arrives out-of-order.
    const pending = store.sendCommand({ queueKey: 'node:node-1', command: 'click', timeoutMs: 30_000 });
    const rejected = expect(pending).rejects.toThrow('browser_extension_command_timeout');
    const internals = store as unknown as {
      queues: Map<string, Array<{ id: string }>>;
    };
    const queuedId = internals.queues.get('node:node-1')![0]!.id;
    store.markReceived('node:node-1', queuedId);

    // Delivery happens after the receipt. The receipt window must be skipped
    // (the ack already proved arrival) and the execution watchdog re-armed.
    const command = await store.pollCommand('node:node-1', { timeoutMs: 1 });
    expect(command!.id).toBe(queuedId);
    // Past the 15s receipt window: no false receipt_missing, still pending.
    await vi.advanceTimersByTimeAsync(16_000);
    // At the full execution window the watchdog fires — proving a timer exists.
    await vi.advanceTimersByTimeAsync(14_000);
    await rejected;
  });

  it('re-proves receipt capability after a queue rejection (node reconnect)', async () => {
    vi.useFakeTimers();
    const store = new BrowserExtensionCommandStore();
    const warmup = store.sendCommand({ queueKey: 'node:node-1', command: 'snapshot', timeoutMs: 10_000 });
    const warmupCommand = await store.pollCommand('node:node-1', { timeoutMs: 1 });
    store.markReceived('node:node-1', warmupCommand!.id);
    store.resolveCommand({ queueKey: 'node:node-1', commandId: warmupCommand!.id, ok: true, result: {} });
    await warmup;

    store.rejectQueue('node:node-1', 'node_disconnected');

    // Post-reconnect the channel may run an older extension: no enforcement
    // until a fresh receipt proves support again.
    const pending = store.sendCommand({ queueKey: 'node:node-1', command: 'click', timeoutMs: 30_000 });
    const rejected = expect(pending).rejects.toThrow('browser_extension_command_timeout');
    await store.pollCommand('node:node-1', { timeoutMs: 1 });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
  });

  it('ignores a stale receipt from the pre-disconnect channel after rejectQueue', async () => {
    vi.useFakeTimers();
    const store = new BrowserExtensionCommandStore();
    const doomed = store.sendCommand({ queueKey: 'node:node-1', command: 'click', timeoutMs: 30_000 });
    const doomedRejected = expect(doomed).rejects.toThrow('node_disconnected');
    const doomedCommand = await store.pollCommand('node:node-1', { timeoutMs: 1 });

    // Node disconnects; capability reset. THEN the old channel's receipt
    // straggles in — it must not re-register receipt capability.
    store.rejectQueue('node:node-1', 'node_disconnected');
    await doomedRejected;
    store.markReceived('node:node-1', doomedCommand!.id);

    // The reconnected channel may run an old receipt-less extension build:
    // its next command must get the legacy full execution window, not a
    // false 15s receipt_missing.
    const pending = store.sendCommand({ queueKey: 'node:node-1', command: 'click', timeoutMs: 30_000 });
    const rejected = expect(pending).rejects.toThrow('browser_extension_command_timeout');
    await store.pollCommand('node:node-1', { timeoutMs: 1 });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
  });

  it('describes queue load for health pre-flight', async () => {
    const store = new BrowserExtensionCommandStore();
    expect(store.describeQueue('node:node-1')).toEqual({
      queueKey: 'node:node-1',
      queuedCount: 0,
      inFlightCount: 0,
      waitingPollerCount: 0,
    });

    const first = store.sendCommand({ queueKey: 'node:node-1', command: 'snapshot', timeoutMs: 10_000 });
    const second = store.sendCommand({ queueKey: 'node:node-1', command: 'snapshot', timeoutMs: 10_000 });
    expect(store.describeQueue('node:node-1')).toMatchObject({ queuedCount: 2, inFlightCount: 0 });

    const command = await store.pollCommand('node:node-1', { timeoutMs: 1 });
    expect(store.describeQueue('node:node-1')).toMatchObject({ queuedCount: 1, inFlightCount: 1 });

    store.rejectQueue('node:node-1', 'test_cleanup');
    await expect(first).rejects.toThrow('test_cleanup');
    await expect(second).rejects.toThrow('test_cleanup');
    void command;
  });

  it('returns null when the extension polls and no command arrives before the timeout', async () => {
    const store = new BrowserExtensionCommandStore();

    await expect(store.pollCommand({ timeoutMs: 1 })).resolves.toBeNull();
  });

  it('isolates local and remote node command queues', async () => {
    const store = new BrowserExtensionCommandStore();
    const pending = store.sendCommand({
      command: 'snapshot',
      target: {
        profileId: 'existing-tab:n.node-1:7:42',
        targetId: 'existing-tab:n.node-1:7:42:target',
        tabId: 42,
        windowId: 7,
      },
      queueKey: 'node:node-1',
      timeoutMs: 1_000,
    } as never);

    await expect(store.pollCommand('local' as never, { timeoutMs: 1 })).resolves.toBeNull();
    const command = await store.pollCommand('node:node-1' as never, { timeoutMs: 1 });
    expect(command).toMatchObject({
      command: 'snapshot',
      target: {
        tabId: 42,
        windowId: 7,
      },
    });
    store.resolveCommand({
      commandId: command!.id,
      ok: true,
      result: { ok: true },
      queueKey: 'node:node-1',
    } as never);
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('rejects command results from a different queue', async () => {
    const store = new BrowserExtensionCommandStore();
    const pending = store.sendCommand({
      command: 'click',
      target: {
        profileId: 'existing-tab:n.node-1:7:42',
        targetId: 'existing-tab:n.node-1:7:42:target',
        tabId: 42,
        windowId: 7,
      },
      queueKey: 'node:node-1',
      timeoutMs: 1_000,
    } as never);
    const command = await store.pollCommand('node:node-1' as never, { timeoutMs: 1 });

    expect(() =>
      store.resolveCommand({
        commandId: command!.id,
        ok: true,
        result: { clicked: true },
        queueKey: 'node:node-2',
      } as never),
    ).toThrow(/browser_extension_command_queue_mismatch/);

    store.resolveCommand({
      commandId: command!.id,
      ok: true,
      result: { clicked: true },
      queueKey: 'node:node-1',
    } as never);
    await expect(pending).resolves.toEqual({ clicked: true });
  });

  it('rejects pending commands and releases pollers for a rejected queue', async () => {
    const store = new BrowserExtensionCommandStore();
    const pending = store.sendCommand({
      queueKey: 'node:node-1',
      command: 'snapshot',
      timeoutMs: 10_000,
    });
    await expect(store.pollCommand('node:node-1', { timeoutMs: 1 })).resolves.toMatchObject({
      command: 'snapshot',
    });
    const poll = store.pollCommand('node:node-1', { timeoutMs: 10_000 });

    store.rejectQueue('node:node-1', 'node_disconnected');

    await expect(pending).rejects.toThrow('node_disconnected');
    await expect(poll).resolves.toBeNull();
  });
});
