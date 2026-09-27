import type { IncomingMessage, ServerResponse } from 'http';
import type {
  MobilePlanQueueItemDto,
  MobilePlanQueueRunDto,
  MobileServerEvent,
} from '../../shared/types/mobile-gateway.types';
import {
  MOBILE_PLAN_QUEUE_ITEM_STATES,
  MOBILE_PLAN_QUEUE_RUN_STATUSES,
} from '../../shared/types/mobile-gateway.types';
import { MobileRouteError, sendJsonResponse, readJsonBody } from './mobile-gateway-http-utils';

const ITEM_STATES = new Set<string>(MOBILE_PLAN_QUEUE_ITEM_STATES);
const RUN_STATUSES = new Set<string>(MOBILE_PLAN_QUEUE_RUN_STATUSES);
const CONTROLS = new Set(['pause', 'resume', 'cancel']);

export interface GatewayPlanQueueSource {
  list(): MobilePlanQueueRunDto[];
  answer(itemId: string, optionId: string): Promise<void>;
  control(runId: string, action: 'pause' | 'resume' | 'cancel'): Promise<void>;
  diffstat(itemId: string): Promise<string>;
  subscribe(listener: (runId: string, run: MobilePlanQueueRunDto | null) => void): () => void;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || path;
}

export function assertPlanQueueRun(run: MobilePlanQueueRunDto): MobilePlanQueueRunDto {
  if (!RUN_STATUSES.has(run.status)) throw new MobileRouteError('Unsupported plan queue status', 500);
  return {
    ...run,
    items: run.items.map((item) => {
      if (!ITEM_STATES.has(item.state)) throw new MobileRouteError('Unsupported plan queue item state', 500);
      return { ...item, title: item.title || basename(item.documentPath) };
    }),
  };
}

function decodeId(raw: string, label: string): string {
  try {
    const id = decodeURIComponent(raw).trim();
    if (!id || id.length > 200) throw new Error('bad');
    return id;
  } catch {
    throw new MobileRouteError(`A valid ${label} is required`);
  }
}

/** Plan Queue list, answer, and run-level pause/resume/cancel. Landing stays on the desktop. */
export class MobileGatewayPlanQueueHandlers {
  private unsubscribe: (() => void) | null = null;
  private readonly itemStates = new Map<string, string>();

  constructor(private readonly deps: {
    getSource(): GatewayPlanQueueSource;
    broadcast(event: MobileServerEvent): void;
    sendNeedsAnswerPush(item: MobilePlanQueueItemDto): void;
  }) {}

  attach(): void {
    if (this.unsubscribe) return;
    const source = this.deps.getSource();
    for (const run of source.list()) {
      for (const item of run.items) this.itemStates.set(item.id, item.state);
    }
    this.unsubscribe = source.subscribe((runId, run) => {
      this.deps.broadcast({ type: 'plan-queue-state', data: { runId, run } });
      if (!run) return;
      for (const item of run.items) {
        const previous = this.itemStates.get(item.id);
        this.itemStates.set(item.id, item.state);
        if (previous && previous !== 'needs-answer' && item.state === 'needs-answer') {
          this.deps.sendNeedsAnswerPush(item);
        }
      }
    });
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.itemStates.clear();
  }

  async handle(req: IncomingMessage, res: ServerResponse, segments: string[], method: string): Promise<boolean> {
    if (segments[1] !== 'plan-queue') return false;
    const source = this.deps.getSource();
    if (segments.length === 2 && method === 'GET') {
      sendJsonResponse(res, 200, { runs: source.list().map(assertPlanQueueRun) });
      return true;
    }
    if (segments.length !== 4 || method !== 'POST' && method !== 'GET') return false;
    const id = decodeId(segments[2], 'plan queue id');
    const action = segments[3];
    if (action === 'diffstat' && method === 'GET') {
      sendJsonResponse(res, 200, { diffstat: await source.diffstat(id) });
      return true;
    }
    if (method !== 'POST') return false;
    if (action === 'answer') {
      const body = await readJsonBody(req) as { optionId?: unknown };
      const optionId = typeof body.optionId === 'string' ? body.optionId.trim() : '';
      if (!optionId || optionId.length > 50) throw new MobileRouteError('A valid optionId is required');
      await source.answer(id, optionId);
      sendJsonResponse(res, 200, { ok: true });
      return true;
    }
    if (action === 'control') {
      const body = await readJsonBody(req) as { action?: unknown };
      const control = typeof body.action === 'string' ? body.action : '';
      if (!CONTROLS.has(control)) throw new MobileRouteError('action must be pause, resume, or cancel');
      await source.control(id, control as 'pause' | 'resume' | 'cancel');
      sendJsonResponse(res, 200, { ok: true });
      return true;
    }
    return false;
  }
}
