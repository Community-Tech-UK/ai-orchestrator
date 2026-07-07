import { describe, expect, it, vi } from 'vitest';
import type { IpcRenderer } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import { createOperatorDomain } from '../domains/operator.preload';

describe('operator preload domain', () => {
  it('exposes run audit and operator project methods', () => {
    const ipcRenderer = {
      invoke: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IpcRenderer;

    const domain = createOperatorDomain(ipcRenderer, IPC_CHANNELS);

    expect(Object.keys(domain).sort()).toEqual([
      'cancelOperatorRun',
      'getOperatorRun',
      'listOperatorProjects',
      'listOperatorRuns',
      'onOperatorEvent',
      'planOperatorProjectVerification',
      'rescanOperatorProjects',
      'resolveOperatorProject',
    ]);
  });
});
