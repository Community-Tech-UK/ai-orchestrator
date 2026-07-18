import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  findRendererEventSendsInSource,
  findRegisteredChannelsInSource,
  normalizeChannelKey,
} = require('../verify-renderer-event-contract.js') as {
  findRendererEventSendsInSource: (
    file: string,
    source: string,
  ) => Array<{ channel: string | null; line: number }>;
  findRegisteredChannelsInSource: (source: string) => Set<string>;
  normalizeChannelKey: (channel: string | null, values: Map<string, string>) => string | null;
};

describe('verify-renderer-event-contract', () => {
  it('extracts constant and literal channels from renderer send calls', () => {
    const sends = findRendererEventSendsInSource('events.ts', `
      windowManager.sendToRenderer(IPC_CHANNELS.SAFE_EVENT, payload);
      sendToRenderer('literal:event', payload);
      event.sender.send(IPC_CHANNELS.DIRECT_EVENT, payload);
      windowManager.sendToRenderer(channel, payload);
    `);

    expect(sends.map((send) => send.channel)).toEqual([
      'IPC_CHANNELS.SAFE_EVENT',
      'literal:event',
      'IPC_CHANNELS.DIRECT_EVENT',
      null,
    ]);
  });

  it('does not treat fixed-channel event wrappers as renderer sender aliases', () => {
    const sends = findRendererEventSendsInSource('campaign.ts', `
      const forward = (event: string) => {
        windowManager.sendToRenderer('campaign:state-changed', { event });
      };
      const send = (channel: string, payload: unknown) => {
        windowManager.sendToRenderer(channel, payload);
      };

      forward('campaign:started');
      send('real:event', payload);
    `);

    expect(sends.map((entry) => entry.channel)).toEqual([
      'campaign:state-changed',
      'real:event',
    ]);
  });

  it('suppresses the wrapper declaration body but keeps its dynamic call sites', () => {
    const sends = findRendererEventSendsInSource('wrapped.ts', `
      const send = (channel: string, payload: unknown) => {
        windowManager.sendToRenderer(channel, payload);
      };

      send(computedChannel, payload);
    `);

    expect(sends.map((entry) => entry.channel)).toEqual([null]);
  });

  it('resolves local const string channels', () => {
    const sends = findRendererEventSendsInSource('cost.ts', `
      const WARNING_CHANNEL = 'cost:budget-warning';
      windowManager.sendToRenderer(WARNING_CHANNEL, payload);
    `);

    expect(sends.map((entry) => entry.channel)).toEqual(['cost:budget-warning']);
  });

  it('resolves ternary channels to both branches when both are static', () => {
    const sends = findRendererEventSendsInSource('cost.ts', `
      const EXCEEDED_CHANNEL = 'cost:budget-exceeded';
      sendToRenderer(exceeded ? EXCEEDED_CHANNEL : 'cost:budget-warning', payload);
      sendToRenderer(exceeded ? EXCEEDED_CHANNEL : computed, payload);
    `);

    expect(sends.map((entry) => entry.channel)).toEqual([
      'cost:budget-exceeded',
      'cost:budget-warning',
      null,
    ]);
  });

  it('extracts channel keys from the renderer event schema registry', () => {
    const channels = findRegisteredChannelsInSource(`
      const RENDERER_EVENT_SCHEMAS = new Map([
        [IPC_CHANNELS.SAFE_EVENT, SafeEventSchema],
        ['literal:event', LiteralEventSchema],
      ]);
    `);

    expect(channels).toEqual(new Set([
      'IPC_CHANNELS.SAFE_EVENT',
      'literal:event',
    ]));
  });

  it('normalizes IPC constants to their literal channel value', () => {
    const values = new Map([['IPC_CHANNELS.INSTANCE_CREATED', 'instance:created']]);

    expect(normalizeChannelKey('IPC_CHANNELS.INSTANCE_CREATED', values)).toBe('instance:created');
    expect(normalizeChannelKey('instance:created', values)).toBe('instance:created');
  });
});
