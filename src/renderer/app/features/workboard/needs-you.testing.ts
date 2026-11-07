/** Narrow source doubles for tests that exercise WorkboardStore with the real root projection. */
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { PermissionApprovalsStore } from '../../core/state/permission-approvals.store';
import { BrowserApprovalsStore } from '../../core/state/browser-approvals.store';
import { PlanQueueStore } from '../../core/state/plan-queue.store';
import { PendingRequestStore } from '../../core/state/pending-request.store';
import { LocalAiGuardStore } from '../../core/state/local-ai-guard.store';
import { SideChatStore } from '../../core/state/side-chat.store';
import { ToolLoopAlertStore } from '../../core/state/tool-loop-alert.store';
import { LoopIpcService } from '../../core/services/ipc/loop-ipc.service';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import { DocReviewStore } from '../doc-review/doc-review.store';
import { MemoryReviewStore } from '../memory-review/memory-review.store';

export function needsYouTestSources(now: number) {
  return [
    { provide: PermissionApprovalsStore, useValue: { pendingRequests: signal([]), now: signal(now) } },
    { provide: BrowserApprovalsStore, useValue: { pendingRequests: signal([]) } },
    { provide: PlanQueueStore, useValue: { needsAnswerItems: signal([]) } },
    { provide: PendingRequestStore, useValue: { forInstance: () => [] } },
    { provide: LocalAiGuardStore, useValue: { pendingFallbacks: signal([]) } },
    { provide: SideChatStore, useValue: { attentionList: signal([]) } },
    { provide: ToolLoopAlertStore, useValue: { liveIds: signal(new Set()), alertFor: () => null } },
    { provide: LoopIpcService, useValue: {} },
    { provide: ElectronIpcService, useValue: { getApi: () => ({ setAttentionBadge: vi.fn().mockResolvedValue({ success: true }) }) } },
    { provide: DocReviewStore, useValue: { sessions: signal([]) } },
    { provide: MemoryReviewStore, useValue: { proposals: signal([]) } },
  ];
}
