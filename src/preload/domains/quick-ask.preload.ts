/**
 * Quick ask preload domain (A8.1, Step 14c). New domain on purpose: the
 * existing instance.preload.ts is at its LOC ceiling.
 */

import type { IpcRenderer } from 'electron';
import type { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export interface QuickAskResultPayload {
  ok: boolean;
  answer?: string;
  elapsedMs?: number;
  /** Set when a different model answered after a refusal (14c). */
  notice?: string;
  code?: string;
  message?: string;
}

export function createQuickAskDomain(
  ipcRenderer: IpcRenderer,
  ch: typeof IPC_CHANNELS,
) {
  return {
    quickAsk: (
      payload: { instanceId: string; question: string },
    ): Promise<IpcResponse<QuickAskResultPayload>> =>
      ipcRenderer.invoke(ch.INSTANCE_QUICK_ASK, payload),
  };
}
