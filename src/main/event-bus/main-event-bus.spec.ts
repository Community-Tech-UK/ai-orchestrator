import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';
import type { EventTier, ThinClientEvent } from '../../shared/types/thin-client-event.types';
import { ElectronWindowTransport } from './electron-window-transport';
import { MainEventBus } from './main-event-bus';

class CollectingTransport {
  readonly events: ThinClientEvent[] = [];

  constructor(readonly tiers: Set<EventTier> | 'all' = 'all') {}

  send(event: ThinClientEvent): void {
    this.events.push(event);
  }
}

describe('MainEventBus', () => {
  it('wraps emitted payloads in a thin-client envelope and respects tier filters', () => {
    const bus = new MainEventBus({ now: () => 1234 });
    const allTransport = new CollectingTransport();
    const lifecycleOnly = new CollectingTransport(new Set<EventTier>(['lifecycle']));

    bus.addTransport(allTransport);
    bus.addTransport(lifecycleOnly);

    bus.emit('status', IPC_CHANNELS.QUOTA_UPDATED, { provider: 'claude' });

    expect(allTransport.events).toEqual([
      {
        seq: 1,
        ts: 1234,
        tier: 'status',
        type: IPC_CHANNELS.QUOTA_UPDATED,
        payload: { provider: 'claude' },
      },
    ]);
    expect(lifecycleOnly.events).toEqual([]);
  });

  it('assigns sequence numbers per transport so filtered tiers do not create gaps', () => {
    const bus = new MainEventBus({ now: () => 1234 });
    const allTransport = new CollectingTransport();
    const lifecycleOnly = new CollectingTransport(new Set<EventTier>(['lifecycle']));

    bus.addTransport(allTransport);
    bus.addTransport(lifecycleOnly);

    bus.emit('status', IPC_CHANNELS.QUOTA_UPDATED, { provider: 'claude' });
    bus.emit('lifecycle', IPC_CHANNELS.INSTANCE_CREATED, { instanceId: 'inst-1' });

    expect(allTransport.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(lifecycleOnly.events.map((event) => event.seq)).toEqual([1]);
  });

  it('keeps the snapshot sequence at the highest issued event sequence', () => {
    const bus = new MainEventBus({ now: () => 1234 });
    const allTransport = new CollectingTransport();
    const lifecycleOnly = new CollectingTransport(new Set<EventTier>(['lifecycle']));
    bus.addTransport(allTransport);
    bus.addTransport(lifecycleOnly);

    bus.emit('status', IPC_CHANNELS.QUOTA_UPDATED, { provider: 'claude' });
    bus.emit('lifecycle', IPC_CHANNELS.INSTANCE_CREATED, { instanceId: 'inst-1' });

    expect(bus.getSnapshotSeq()).toBe(2);
  });

  it('reports snapshot sequence per transport without cross-transport bleed', () => {
    const bus = new MainEventBus({ now: () => 1234 });
    const electronTransport = new CollectingTransport();
    const wsTransport = new CollectingTransport(new Set<EventTier>(['lifecycle']));
    bus.addTransport(electronTransport);
    bus.addTransport(wsTransport);

    bus.emit('status', IPC_CHANNELS.QUOTA_UPDATED, { provider: 'claude' });
    bus.emit('lifecycle', IPC_CHANNELS.INSTANCE_CREATED, { instanceId: 'inst-1' });

    expect(bus.getSnapshotSeqForTransport(electronTransport)).toBe(2);
    expect(bus.getSnapshotSeqForTransport(wsTransport)).toBe(1);
  });

  it('preserves the legacy Electron webContents.send channel and argument list', () => {
    const send = vi.fn();
    const webContents = { send };
    const bus = new MainEventBus({ now: () => 100 });
    bus.addTransport(new ElectronWindowTransport(() => webContents));

    bus.emitRendererEvent(IPC_CHANNELS.MENU_NEW_INSTANCE);
    bus.emitRendererEvent('custom:multi-arg', 'one', { two: 2 });

    expect(send).toHaveBeenNthCalledWith(1, IPC_CHANNELS.MENU_NEW_INSTANCE);
    expect(send).toHaveBeenNthCalledWith(2, 'custom:multi-arg', 'one', { two: 2 });
  });

  it('derives instance lifecycle phase events from state updates', () => {
    const bus = new MainEventBus({ now: () => 10 });
    const lifecycle = new CollectingTransport(new Set<EventTier>(['lifecycle']));
    const control = new CollectingTransport(new Set<EventTier>(['control']));
    bus.addTransport(lifecycle);
    bus.addTransport(control);

    bus.emitRendererEvent(IPC_CHANNELS.INSTANCE_STATE_UPDATE, {
      instanceId: 'inst-1',
      status: 'waiting_for_input',
    });

    expect(control.events).toEqual([
      expect.objectContaining({
        seq: 1,
        tier: 'control',
        type: IPC_CHANNELS.INSTANCE_STATE_UPDATE,
      }),
    ]);
    expect(lifecycle.events).toEqual([
      expect.objectContaining({
        seq: 1,
        tier: 'lifecycle',
        type: 'instance:phase-changed',
        payload: {
          instanceId: 'inst-1',
          status: 'waiting_for_input',
          phase: 'blocked',
        },
      }),
    ]);
  });

  it('derives loop lifecycle phase events from loop state changes', () => {
    const bus = new MainEventBus({ now: () => 20 });
    const lifecycle = new CollectingTransport(new Set<EventTier>(['lifecycle']));
    bus.addTransport(lifecycle);

    bus.emitRendererEvent(IPC_CHANNELS.LOOP_STATE_CHANGED, {
      loopRunId: 'loop-1',
      state: {
        id: 'loop-1',
        chatId: 'chat-1',
        status: 'provider-limit',
      },
    });

    expect(lifecycle.events.at(-1)).toEqual(expect.objectContaining({
      seq: 1,
      tier: 'lifecycle',
      type: 'loop:phase-changed',
      payload: {
        loopRunId: 'loop-1',
        chatId: 'chat-1',
        status: 'provider-limit',
        phase: 'paused',
      },
    }));
  });

  it('derives ended provider-limit loop state changes as failed lifecycle events', () => {
    const bus = new MainEventBus({ now: () => 20 });
    const lifecycle = new CollectingTransport(new Set<EventTier>(['lifecycle']));
    bus.addTransport(lifecycle);

    bus.emitRendererEvent(IPC_CHANNELS.LOOP_STATE_CHANGED, {
      loopRunId: 'loop-ended-provider-limit',
      state: {
        id: 'loop-ended-provider-limit',
        chatId: 'chat-1',
        status: 'provider-limit',
        endedAt: 1_778_310_600_000,
      },
    });

    expect(lifecycle.events.at(-1)).toEqual(expect.objectContaining({
      seq: 1,
      tier: 'lifecycle',
      type: 'loop:phase-changed',
      payload: {
        loopRunId: 'loop-ended-provider-limit',
        chatId: 'chat-1',
        status: 'provider-limit',
        phase: 'failed',
      },
    }));
  });

  it('keeps nested state endedAt=null authoritative over stale top-level loop payload data', () => {
    const bus = new MainEventBus({ now: () => 20 });
    const lifecycle = new CollectingTransport(new Set<EventTier>(['lifecycle']));
    bus.addTransport(lifecycle);

    bus.emitRendererEvent(IPC_CHANNELS.LOOP_STATE_CHANGED, {
      loopRunId: 'loop-restored-provider-limit',
      endedAt: 1_778_310_600_000,
      state: {
        id: 'loop-restored-provider-limit',
        chatId: 'chat-1',
        status: 'provider-limit',
        endedAt: null,
      },
    });

    expect(lifecycle.events.at(-1)).toEqual(expect.objectContaining({
      seq: 1,
      tier: 'lifecycle',
      type: 'loop:phase-changed',
      payload: {
        loopRunId: 'loop-restored-provider-limit',
        chatId: 'chat-1',
        status: 'provider-limit',
        phase: 'paused',
      },
    }));
  });

  it('derives automation lifecycle phase events from automation run changes', () => {
    const bus = new MainEventBus({ now: () => 30 });
    const lifecycle = new CollectingTransport(new Set<EventTier>(['lifecycle']));
    bus.addTransport(lifecycle);

    bus.emitRendererEvent(IPC_CHANNELS.AUTOMATION_RUN_CHANGED, {
      automationId: 'automation-1',
      run: {
        id: 'run-1',
        automationId: 'automation-1',
        status: 'succeeded',
      },
    });

    expect(lifecycle.events.at(-1)).toEqual(expect.objectContaining({
      seq: 1,
      tier: 'lifecycle',
      type: 'automation:phase-changed',
      payload: {
        runId: 'run-1',
        automationId: 'automation-1',
        status: 'succeeded',
        phase: 'completed',
      },
    }));
  });
});
