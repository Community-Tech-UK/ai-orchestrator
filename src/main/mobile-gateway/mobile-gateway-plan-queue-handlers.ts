import type { IncomingMessage, ServerResponse } from 'http';
import type {
  MobilePlanQueueDirectChangeChoice,
  MobilePlanQueueItemDto,
  MobilePlanQueueRunDto,
} from '../../shared/types/mobile-gateway.types';
import {
  MOBILE_PLAN_QUEUE_DIRECT_CHANGE_CHOICES,
  MOBILE_PLAN_QUEUE_ITEM_STATES,
  MOBILE_PLAN_QUEUE_RUN_STATUSES,
  waitsForDirectChangeChoice,
} from '../../shared/types/mobile-gateway.types';
import { MobileRouteError, sendJsonResponse, readJsonBody } from './mobile-gateway-http-utils';
import type { MobileBroadcastEvent } from './mobile-gateway-snapshot';

const ITEM_STATES = new Set<string>(MOBILE_PLAN_QUEUE_ITEM_STATES);
const RUN_STATUSES = new Set<string>(MOBILE_PLAN_QUEUE_RUN_STATUSES);
const CONTROLS = new Set(['pause', 'resume', 'cancel']);
const DIRECT_CHANGE_CHOICES = new Set<string>(MOBILE_PLAN_QUEUE_DIRECT_CHANGE_CHOICES);

export interface GatewayPlanQueueSource {
  list(): MobilePlanQueueRunDto[];
  answer(itemId: string, optionId: string): Promise<void>;
  control(runId: string, action: 'pause' | 'resume' | 'cancel'): Promise<void>;
  /** Only for a job set aside because it would undo a direct change; any other job is refused. */
  chooseDirectChange(itemId: string, choice: MobilePlanQueueDirectChangeChoice): Promise<void>;
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
      return { ...item, title: item.title || basename(item.sourceRef) };
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

/** What a job is waiting for James to do, if anything. */
export type PlanQueueWaitingFor = 'answer' | 'direct-change-choice';

function waitingFor(item: MobilePlanQueueItemDto): PlanQueueWaitingFor | null {
  if (item.state === 'needs-answer') return 'answer';
  return waitsForDirectChangeChoice(item) ? 'direct-change-choice' : null;
}

/**
 * Plan Queue list, answer, run-level pause/resume/cancel, and the direct-change choice. Other landing stays on the desktop.
 */
export class MobileGatewayPlanQueueHandlers {
  private unsubscribe: (() => void) | null = null;
  private readonly waiting = new Map<string, PlanQueueWaitingFor | null>();

  constructor(private readonly deps: {
    getSource(): GatewayPlanQueueSource;
    broadcast(event: MobileBroadcastEvent): void;
    /** A job has started waiting for James. */
    sendWaitingPush(item: MobilePlanQueueItemDto, waitingFor: PlanQueueWaitingFor): void;
  }) {}

  attach(): void {
    if (this.unsubscribe) return;
    const source = this.deps.getSource();
    for (const run of source.list()) {
      for (const item of run.items) this.waiting.set(item.id, waitingFor(item));
    }
    this.unsubscribe = source.subscribe((runId, run) => {
      this.deps.broadcast({ type: 'plan-queue-state', data: { runId, run } });
      if (!run) return;
      for (const item of run.items) {
        const previous = this.waiting.get(item.id);
        const now = waitingFor(item);
        this.waiting.set(item.id, now);
        // A job seen for the first time is not news; one that starts waiting, or waits for something new, is.
        if (previous !== undefined && now && previous !== now) this.deps.sendWaitingPush(item, now);
      }
    });
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.waiting.clear();
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
    if (action === 'direct-change') {
      const body = await readJsonBody(req) as { choice?: unknown };
      const choice = typeof body.choice === 'string' ? body.choice : '';
      if (!DIRECT_CHANGE_CHOICES.has(choice)) throw new MobileRouteError('choice must be keep-change or take-job-version');
      await source.chooseDirectChange(id, choice as MobilePlanQueueDirectChangeChoice);
      sendJsonResponse(res, 200, { ok: true });
      return true;
    }
    return false;
  }
}
