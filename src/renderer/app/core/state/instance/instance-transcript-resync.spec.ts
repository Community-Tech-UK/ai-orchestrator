import { TestBed } from '@angular/core/testing';
import { NgZone } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IpcFacadeService } from '../../services/ipc';
import { ProviderStateService } from '../../services/provider-state.service';
import { ToastService } from '../../services/toast.service';
import { ImageAttachmentService } from '../../../features/instance-detail/image-attachment.service';
import { encodeJsonChunks } from '../../../../../shared/utils/json-chunks';
import { InstanceListStore } from './instance-list.store';
import { InstanceOutputStore } from './instance-output.store';
import { InstanceStateService } from './instance-state.service';

const original = { id: 'placeholder', createdAt: 1, adapterGeneration: 1, restartEpoch: 0,
  provider: 'opencode', status: 'idle', workingDirectory: '/tmp/placeholder',
  outputBuffer: [{ id: 'tail', type: 'assistant', timestamp: 1, content: 'old tail' }] };
const repaired = [{ id: 'prefix', type: 'user', timestamp: 0, content: 'earlier question' }, ...original.outputBuffer];
function setup() {
  let resolve!: (value: unknown) => void;
  const snapshot = new Promise(complete => { resolve = complete; });
  TestBed.configureTestingModule({ providers: [
    { provide: IpcFacadeService, useValue: { stateResync: () => snapshot } },
    { provide: ProviderStateService, useValue: {} }, { provide: ToastService, useValue: {} },
    { provide: ImageAttachmentService, useValue: { processMessage: vi.fn() } },
    { provide: NgZone, useValue: { run: (callback: () => void) => callback() } },
  ] });
  const list = TestBed.inject(InstanceListStore);
  const state = TestBed.inject(InstanceStateService);
  const output = TestBed.inject(InstanceOutputStore);
  const replay = () => {
    const identity = { kind: 'history-replay', instanceId: original.id, createdAt: 1,
      adapterGeneration: 1, restartEpoch: 0, revision: 1 };
    for (const chunk of encodeJsonChunks({ ...identity, messages: repaired }, 'placeholder-transfer')) {
      output.acceptTranscriptChunk({ ...identity, chunk });
    }
  };
  return { list, state, output, replay, resolve };
}
afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); });

describe('authoritative transcript versus renderer snapshots', () => {
  it('keeps a replay and subsequent live output when an older in-flight resync resolves', async () => {
    const { list, state, output, replay, resolve } = setup();
    list.addInstance(original);
    const pending = list.loadInitialInstances();
    replay();
    const live = { id: 'live', type: 'assistant' as const, timestamp: 2, content: 'new answer' };
    output.queueOutput(original.id, live);
    output.flushOutput(original.id, false);
    resolve({ success: true, data: { instances: [original] } });
    await pending;
    expect(state.getInstance(original.id)?.outputBuffer).toEqual([...repaired, live]);
  });

  it('keeps repaired history through duplicate created events but accepts a new incarnation', () => {
    const { list, state, replay } = setup();
    list.addInstance(original);
    replay();
    list.addInstance(original);
    expect(state.getInstance(original.id)?.outputBuffer).toEqual(repaired);
    list.addInstance({ ...original, createdAt: 2 });
    expect(state.getInstance(original.id)?.outputBuffer).toEqual(original.outputBuffer);
  });

  it('keeps an instance repaired after an in-flight snapshot that did not yet contain it', async () => {
    const { list, state, replay, resolve } = setup();
    const pending = list.loadInitialInstances();
    list.addInstance(original);
    replay();
    resolve({ success: true, data: { instances: [] } });
    await pending;
    expect(state.getInstance(original.id)?.outputBuffer).toEqual(repaired);
  });

  it('allows a later snapshot from a newer adapter to replace repaired history', async () => {
    const { list, state, replay, resolve } = setup();
    list.addInstance(original);
    replay();
    const pending = list.loadInitialInstances();
    resolve({ success: true, data: { instances: [{ ...original, adapterGeneration: 2 }] } });
    await pending;
    expect(state.getInstance(original.id)?.adapterGeneration).toBe(2);
    expect(state.getInstance(original.id)?.outputBuffer).toEqual(original.outputBuffer);
  });
});
