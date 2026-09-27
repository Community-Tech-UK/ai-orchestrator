import type { IncomingMessage, ServerResponse } from 'http';
import type {
  MobileLoopControlResponse,
  MobileLoopDetailDto,
  MobileLoopIterationDto,
  MobileLoopRunDto,
  MobileLoopStage,
  MobileLoopStatus,
  MobileLoopVerdict,
  MobileServerEvent,
} from '../../shared/types/mobile-gateway.types';
import { MOBILE_LOOP_STATUSES } from '../../shared/types/mobile-gateway.types';
import { MobileRouteError, sendJsonResponse } from './mobile-gateway-http-utils';

const STATUSES = new Set<string>(MOBILE_LOOP_STATUSES);
const STAGES = new Set<string>(['PLAN', 'REVIEW', 'IMPLEMENT']);
const VERDICTS = new Set<string>(['OK', 'WARN', 'CRITICAL']);
const PUSH_COMPLETED = new Set<MobileLoopStatus>(['completed']);
const PUSH_NEEDS_REVIEW = new Set<MobileLoopStatus>(['completed-needs-review', 'needs-human-arbitration']);
const PUSH_FAILED = new Set<MobileLoopStatus>([
  'failed', 'error', 'no-progress', 'cap-reached', 'provider-limit',
  'cost-exceeded', 'reviewer-unreliable', 'reviewer-unavailable', 'builder-unreliable',
]);

export interface GatewayLoopIterationRecord {
  seq: number;
  stage: string;
  startedAt: number;
  endedAt: number | null;
  verdict: string;
  testPassCount: number | null;
  testFailCount: number | null;
  filesChanged: number;
  summary: string;
}

export interface GatewayLoopRunRecord {
  id: string;
  chatId: string;
  status: string;
  currentStage: string;
  iteration: number;
  maxIterations: number | null;
  startedAt: number;
  endedAt: number | null;
  totalTokens: number;
  totalCostCents: number;
  workspaceCwd: string;
  endReason: string | null;
  pausedForInput: boolean;
  lastIteration?: GatewayLoopIterationRecord;
}

export interface GatewayLoopDetailRecord extends GatewayLoopRunRecord {
  iterations: GatewayLoopIterationRecord[];
  outstanding: MobileLoopDetailDto['outstanding'];
}

export interface GatewayLoopControl {
  list(): GatewayLoopRunRecord[];
  get(id: string): GatewayLoopDetailRecord | null;
  pause(id: string): { ok: boolean; run: GatewayLoopRunRecord | null; error?: string };
  resume(id: string): Promise<{ ok: boolean; run: GatewayLoopRunRecord | null; error?: string }>;
  stop(id: string): Promise<{ ok: boolean; run: GatewayLoopRunRecord | null; error?: string }>;
  subscribe(listener: (runId: string, run: GatewayLoopRunRecord | null) => void): () => void;
}

function asStatus(value: string): MobileLoopStatus {
  return STATUSES.has(value) ? value as MobileLoopStatus : 'error';
}

function asStage(value: string): MobileLoopStage {
  return STAGES.has(value) ? value as MobileLoopStage : 'IMPLEMENT';
}

function asVerdict(value: string): MobileLoopVerdict {
  return VERDICTS.has(value) ? value as MobileLoopVerdict : 'WARN';
}

export function projectLoopIteration(record: GatewayLoopIterationRecord): MobileLoopIterationDto {
  return {
    seq: record.seq,
    stage: asStage(record.stage),
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    verdict: asVerdict(record.verdict),
    testPassCount: record.testPassCount,
    testFailCount: record.testFailCount,
    filesChanged: record.filesChanged,
    summary: record.summary.slice(0, 280),
  };
}

export function projectLoopRun(record: GatewayLoopRunRecord): MobileLoopRunDto {
  return {
    id: record.id,
    chatId: record.chatId,
    status: asStatus(record.status),
    currentStage: asStage(record.currentStage),
    iteration: record.iteration,
    maxIterations: record.maxIterations,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    totalTokens: record.totalTokens,
    totalCostCents: record.totalCostCents,
    workspaceCwd: record.workspaceCwd,
    endReason: record.endReason,
    pausedForInput: record.pausedForInput,
    ...(record.lastIteration ? { lastIteration: projectLoopIteration(record.lastIteration) } : {}),
  };
}

function pushKind(status: MobileLoopStatus): 'completed' | 'failed' | 'needs-review' | null {
  if (PUSH_COMPLETED.has(status)) return 'completed';
  if (PUSH_NEEDS_REVIEW.has(status)) return 'needs-review';
  if (PUSH_FAILED.has(status)) return 'failed';
  return null;
}

function decodeId(raw: string): string {
  try {
    const id = decodeURIComponent(raw).trim();
    if (!id || id.length > 200) throw new Error('bad');
    return id;
  } catch {
    throw new MobileRouteError('A valid loop id is required');
  }
}

/** Loop list, detail, and pause/resume/stop. Control always goes through the coordinator API. */
export class MobileGatewayLoopHandlers {
  private unsubscribe: (() => void) | null = null;
  private readonly statusByRun = new Map<string, MobileLoopStatus>();

  constructor(private readonly deps: {
    getControl(): GatewayLoopControl;
    broadcast(event: MobileServerEvent): void;
    sendPush(run: MobileLoopRunDto, kind: 'completed' | 'failed' | 'needs-review'): void;
  }) {}

  attach(): void {
    if (this.unsubscribe) return;
    const control = this.deps.getControl();
    for (const run of control.list()) this.statusByRun.set(run.id, asStatus(run.status));
    this.unsubscribe = control.subscribe((runId, record) => {
      const run = record ? projectLoopRun(record) : null;
      const previous = this.statusByRun.get(runId);
      if (run) this.statusByRun.set(runId, run.status);
      else this.statusByRun.delete(runId);
      this.deps.broadcast({ type: 'loop-state', data: { runId, run } });
      const kind = run && previous && previous !== run.status ? pushKind(run.status) : null;
      if (run && kind) this.deps.sendPush(run, kind);
    });
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.statusByRun.clear();
  }

  async handle(req: IncomingMessage, res: ServerResponse, segments: string[], method: string): Promise<boolean> {
    if (segments[1] !== 'loops') return false;
    const control = this.deps.getControl();
    if (segments.length === 2 && method === 'GET') {
      sendJsonResponse(res, 200, control.list().map(projectLoopRun));
      return true;
    }
    if (segments.length === 3 && method === 'GET') {
      const detail = control.get(decodeId(segments[2]));
      if (!detail) {
        sendJsonResponse(res, 404, { error: 'Loop not found' });
        return true;
      }
      const body: MobileLoopDetailDto = {
        run: projectLoopRun(detail),
        iterations: detail.iterations.map(projectLoopIteration),
        outstanding: detail.outstanding,
      };
      sendJsonResponse(res, 200, body);
      return true;
    }
    if (segments.length === 4 && method === 'POST') {
      const id = decodeId(segments[2]);
      const action = segments[3];
      const outcome = action === 'pause' ? control.pause(id)
        : action === 'resume' ? await control.resume(id)
          : action === 'stop' ? await control.stop(id)
            : null;
      if (!outcome) return false;
      const body: MobileLoopControlResponse = outcome.ok
        ? { ok: true, run: outcome.run ? projectLoopRun(outcome.run) : null }
        : { ok: false, error: outcome.error || 'Loop control failed' };
      sendJsonResponse(res, outcome.ok ? 200 : 409, body);
      return true;
    }
    return false;
  }
}
