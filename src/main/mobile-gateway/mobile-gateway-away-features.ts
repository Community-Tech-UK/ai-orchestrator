import type { IncomingMessage, ServerResponse } from 'http';
import { resumeInstanceAfterBrowserDecision } from '../ipc/handlers/browser-gateway-handlers';
import { getLogger } from '../logging/logger';
import type { MobileServerEvent } from '../../shared/types/mobile-gateway.types';
import { MobileGatewayBrowserApprovalHandlers, type BrowserPromptSink } from './mobile-gateway-browser-approval-handlers';
import { createLiveBrowserApprovalSource } from './mobile-gateway-browser-approval-source';
import { MobileGatewayDocReviewHandlers } from './mobile-gateway-doc-review-handlers';
import { createLiveDocReviewSource } from './mobile-gateway-doc-review-source';
import { MobileGatewayHistoryContinueHandlers } from './mobile-gateway-history-continue';
import { MobileGatewayLoopHandlers } from './mobile-gateway-loop-handlers';
import { createLiveLoopControl } from './mobile-gateway-loop-source';
import { MobileGatewayPlanQueueHandlers } from './mobile-gateway-plan-queue-handlers';
import { createLivePlanQueueSource } from './mobile-gateway-plan-queue-source';
import {
  sendMobileDocReviewPush,
  sendMobileLoopPush,
  sendMobilePlanQueuePush,
} from './mobile-gateway-push';

const logger = getLogger('MobileGatewayAwayFeatures');

type PushDeps = Parameters<typeof sendMobileLoopPush>[0];

/**
 * Loops, Plan Queue, doc review, browser approvals, and history continue.
 * Kept off MobileGatewayServer so that file stays under its line ceiling.
 * Prompt and instance lookups are callbacks because those fields initialise later.
 */
export class MobileGatewayAwayFeatures {
  private readonly loops: MobileGatewayLoopHandlers;
  private readonly planQueue: MobileGatewayPlanQueueHandlers;
  private readonly docReviews: MobileGatewayDocReviewHandlers;
  private readonly browserApprovals: MobileGatewayBrowserApprovalHandlers;
  private readonly historyContinue: MobileGatewayHistoryContinueHandlers;

  constructor(private readonly deps: {
    broadcast(event: MobileServerEvent): void;
    pushDeps(): PushDeps;
    prompts(): BrowserPromptSink;
    instanceManager(): unknown;
    restore(entryId: string): Promise<{
      instanceId: string;
      sessionId: string;
      historyThreadId: string;
      restoreMode: 'native-resume' | 'resume-unconfirmed' | 'replay-fallback';
    }>;
    wake(instanceId: string): Promise<void>;
  }) {
    this.loops = new MobileGatewayLoopHandlers({
      getControl: () => createLiveLoopControl(),
      broadcast: (event) => this.deps.broadcast(event),
      sendPush: (run, kind) => sendMobileLoopPush(this.deps.pushDeps(), run, kind),
    });
    this.planQueue = new MobileGatewayPlanQueueHandlers({
      getSource: () => createLivePlanQueueSource(),
      broadcast: (event) => this.deps.broadcast(event),
      sendNeedsAnswerPush: (item) => sendMobilePlanQueuePush(this.deps.pushDeps(), item.id),
    });
    this.docReviews = new MobileGatewayDocReviewHandlers({
      getSource: () => createLiveDocReviewSource(),
      sendPendingPush: (summary) => sendMobileDocReviewPush(this.deps.pushDeps(), summary.id),
    });
    this.browserApprovals = new MobileGatewayBrowserApprovalHandlers({
      getSource: () => createLiveBrowserApprovalSource((decision, requestId, result) => {
        const manager = this.deps.instanceManager();
        if (manager) resumeInstanceAfterBrowserDecision(manager as never, decision, requestId, result);
      }),
      prompts: {
        syncBrowser: (prompts) => this.deps.prompts().syncBrowser(prompts),
        get: (requestId) => this.deps.prompts().get(requestId),
        clear: (requestId) => this.deps.prompts().clear(requestId),
      },
    });
    this.historyContinue = new MobileGatewayHistoryContinueHandlers({
      getSource: () => ({
        restore: (entryId) => this.deps.restore(entryId),
        wake: (instanceId) => this.deps.wake(instanceId),
      }),
    });
  }

  async handle(req: IncomingMessage, res: ServerResponse, segments: string[], method: string): Promise<boolean> {
    if (await this.loops.handle(req, res, segments, method)) return true;
    if (await this.planQueue.handle(req, res, segments, method)) return true;
    if (await this.docReviews.handle(req, res, segments, method)) return true;
    if (await this.browserApprovals.handle(req, res, segments, method)) return true;
    if (await this.historyContinue.handle(req, res, segments, method)) return true;
    return false;
  }

  attach(): void {
    const attach = (name: string, run: () => void) => {
      try { run(); }
      catch (error) {
        logger.warn(`${name} unavailable`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    attach('Loop control', () => this.loops.attach());
    attach('Plan queue', () => this.planQueue.attach());
    attach('Doc review', () => this.docReviews.attach());
    attach('Browser approvals', () => this.browserApprovals.attach());
  }

  detach(): void {
    this.browserApprovals.detach();
    this.docReviews.detach();
    this.planQueue.detach();
    this.loops.detach();
  }
}
