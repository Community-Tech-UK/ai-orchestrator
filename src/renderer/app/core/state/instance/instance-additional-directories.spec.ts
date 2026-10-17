import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcFacadeService } from '../../services/ipc';
import { ProviderStateService } from '../../services/provider-state.service';
import { InstanceListStore } from './instance-list.store';
import { InstanceStateService } from './instance-state.service';
const response = { success: true, data: { id: 'created', provider: 'opencode', parentId: null, workingDirectory: '/repo', outputBuffer: [] } };
const ipc = { createInstance: vi.fn(async (_config: Record<string, unknown>) => response), createInstanceWithMessage: vi.fn(async (_config: Record<string, unknown>) => response) };
beforeEach(() => {
  vi.clearAllMocks(); TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [InstanceListStore, InstanceStateService, { provide: IpcFacadeService, useValue: ipc },
    { provide: ProviderStateService, useValue: { selectedProvider: () => 'opencode', getFastModeForProvider: () => false } }] });
});
afterEach(() => TestBed.resetTestingModule());
describe('renderer creation extra folders', () => {
  it('keeps extra folders on ordinary creation', async () => {
    const store = TestBed.inject(InstanceListStore);
    const additionalDirectories = ['/other'];
    await store.createInstanceAndReturnId({ workingDirectory: '/repo', provider: 'opencode', additionalDirectories });
    expect(ipc.createInstance).toHaveBeenCalledWith(expect.objectContaining({ additionalDirectories }));
    expect(ipc.createInstance.mock.calls[0][0]['additionalDirectories']).not.toBe(additionalDirectories);
  });
  it('keeps extra folders on creation with a first message', async () => {
    const store = TestBed.inject(InstanceListStore);
    const additionalDirectories = ['/other'];
    await store.createInstanceWithMessageResult({ workingDirectory: '/repo', provider: 'opencode', message: 'work', additionalDirectories });
    expect(ipc.createInstanceWithMessage).toHaveBeenCalledWith(expect.objectContaining({ additionalDirectories }));
    expect(ipc.createInstanceWithMessage.mock.calls[0][0]['additionalDirectories']).not.toBe(additionalDirectories);
  });
});

it('preserves stored extra folders when rebuilding renderer instances', () => {
  const additionalDirectories = ['/other'];
  const instance = TestBed.inject(InstanceListStore).deserializeInstance({ ...response.data, additionalDirectories });
  expect(instance.additionalDirectories).toEqual(additionalDirectories);
  expect(instance.additionalDirectories).not.toBe(additionalDirectories);
});
