import { EventEmitter } from 'events';
import type { IpcRenderer } from 'electron';
import { describe, expect, it } from 'vitest';
import { createDiagnosticsDomain } from '../domains/diagnostics.preload';
import { IPC_CHANNELS } from '../generated/channels';

describe('diagnostics inbox push subscriptions', () => {
  it.each([
    ['onMemoryReviewChanged', 'memory-review:changed'],
    ['onRepoJobChanged', 'repo-job:changed'],
  ] as const)('delivers %s through its channel and detaches on unsubscribe', (method, channel) => {
    const transport = new EventEmitter();
    const domain = createDiagnosticsDomain(transport as unknown as IpcRenderer, IPC_CHANNELS);
    const received: unknown[] = [];
    const unsubscribe = domain[method](event => received.push(event));

    transport.emit(channel, {}, { changedAt: 1000 });
    expect(received).toEqual([{ changedAt: 1000 }]);
    unsubscribe();
    transport.emit(channel, {}, { changedAt: 2000 });
    expect(received).toEqual([{ changedAt: 1000 }]);
  });
});
