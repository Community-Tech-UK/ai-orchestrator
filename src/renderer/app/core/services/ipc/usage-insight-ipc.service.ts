/**
 * IPC wrapper for "Where your usage went".
 */

import { Injectable, inject } from '@angular/core';
import type { UsageInsightRequest, UsageInsightResponse } from '../../../../../shared/usage-insight/usage-insight.types';
import { ElectronIpcService, type IpcResponse } from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class UsageInsightIpcService {
  private readonly base = inject(ElectronIpcService);

  /** The last 7 days of Claude usage, split into Anthropic's nine causes. */
  async get(request: UsageInsightRequest = {}): Promise<IpcResponse<UsageInsightResponse>> {
    const api = this.base.getApi();
    if (!api) return { success: false, error: { message: 'Not in Electron' } };
    return api.usageInsightGet(request);
  }
}
