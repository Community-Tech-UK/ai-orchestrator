import type {
  MobileAutomationDto,
  MobileAutomationRunRequest,
  MobileAutomationRunResponse,
} from '../../shared/types/mobile-gateway.types';
import type {
  Automation,
  AutomationFireOutcome,
  AutomationRun,
} from '../../shared/types/automation.types';
import {
  resolveAutomationSpawnTarget,
  type AutomationModelDefaults,
} from '../../shared/automations/automation-model-resolution';
import type { AutomationEventMap } from '../automations/automation-events';
import type { AutomationFireOptions } from '../automations/automation-runner';
import type { IncomingMessage, ServerResponse } from 'http';
import { sendJsonResponse } from './mobile-gateway-http-utils';

const MAX_AUTOMATION_ID_LENGTH = 100;
const MAX_IDEMPOTENCY_KEY_LENGTH = 500;
const MAX_PUSH_DEDUPE_RUNS = 2_000;
const MAX_RUN_BODY_BYTES = 2 * 1024;
export const MAX_MOBILE_AUTOMATIONS = 100;

export interface GatewayAutomationStore {
  list(options?: { limit?: number }): Promise<Automation[]>;
  listLatestRuns(automationIds: readonly string[]): ReadonlyMap<string, AutomationRun>;
}

export interface GatewayAutomationRunner {
  fire(automationId: string, options: AutomationFireOptions): Promise<AutomationFireOutcome>;
}

export interface GatewayAutomationEvents {
  on(event: 'automation:run-terminal', listener: (payload: AutomationEventMap['runTerminal']) => void): unknown;
  removeListener(event: 'automation:run-terminal', listener: (payload: AutomationEventMap['runTerminal']) => void): unknown;
}

interface MobileGatewayAutomationDeps {
  getStore(): GatewayAutomationStore;
  getRunner(): GatewayAutomationRunner;
  getEvents(): GatewayAutomationEvents;
  getModelDefaults(): AutomationModelDefaults;
  sendFailedPush(payload: { automationId: string; runId: string }): void;
}

export class MobileAutomationRequestError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'MobileAutomationRequestError';
  }
}

/** This control route never carries attachments, so retain a deliberately tiny body cap. */
export async function readMobileAutomationRunRequest(req: IncomingMessage): Promise<MobileAutomationRunRequest> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_RUN_BODY_BYTES) {
      throw new MobileAutomationRequestError('Automation run request body is too large');
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return { idempotencyKey: '' };
  try {
    return JSON.parse(raw) as MobileAutomationRunRequest;
  } catch {
    throw new MobileAutomationRequestError('Invalid JSON body');
  }
}

function lastRunProjection(run: AutomationRun | undefined): MobileAutomationDto['lastRun'] {
  if (!run) return null;
  return {
    status: run.status,
    at: run.finishedAt ?? run.startedAt ?? run.createdAt,
  };
}

function responseFor(outcome: AutomationFireOutcome): MobileAutomationRunResponse {
  if (outcome.status === 'started' || outcome.status === 'queued') {
    return { status: outcome.status, runId: outcome.run.id };
  }
  return {
    status: 'skipped',
    ...(outcome.run ? { runId: outcome.run.id } : {}),
    reason: outcome.reason,
  };
}

export class MobileGatewayAutomationHandlers {
  private attached = false;
  private attachedEvents: GatewayAutomationEvents | null = null;
  private readonly pushedFailureRunIds = new Set<string>();
  private readonly onTerminal = (event: AutomationEventMap['runTerminal']): void => {
    if (event.status !== 'failed' || this.pushedFailureRunIds.has(event.runId)) return;
    this.pushedFailureRunIds.add(event.runId);
    if (this.pushedFailureRunIds.size > MAX_PUSH_DEDUPE_RUNS) {
      const oldest = this.pushedFailureRunIds.values().next().value as string | undefined;
      if (oldest) this.pushedFailureRunIds.delete(oldest);
    }
    this.deps.sendFailedPush({ automationId: event.automationId, runId: event.runId });
  };

  constructor(private readonly deps: MobileGatewayAutomationDeps) {}

  attach(): void {
    if (this.attached) return;
    const events = this.deps.getEvents();
    events.on('automation:run-terminal', this.onTerminal);
    this.attachedEvents = events;
    this.attached = true;
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.attachedEvents?.removeListener('automation:run-terminal', this.onTerminal);
    this.attachedEvents = null;
    this.pushedFailureRunIds.clear();
  }

  async list(): Promise<MobileAutomationDto[]> {
    const store = this.deps.getStore();
    const defaults = this.deps.getModelDefaults();
    const automations = (await store.list({ limit: MAX_MOBILE_AUTOMATIONS })).slice(0, MAX_MOBILE_AUTOMATIONS);
    const latestRuns = store.listLatestRuns(automations.map(automation => automation.id));
    return automations.map((automation) => {
      const target = resolveAutomationSpawnTarget(automation.action, defaults);
      const lastRun = latestRuns.get(automation.id);
      return {
        id: automation.id,
        name: automation.name,
        schedule: automation.schedule,
        enabled: automation.enabled,
        nextRunAt: automation.nextFireAt,
        lastRun: lastRunProjection(lastRun),
        provider: target.provider && target.provider !== 'auto' ? target.provider : null,
        model: target.modelOverride ?? null,
      };
    });
  }

  async run(automationId: string, body: MobileAutomationRunRequest): Promise<MobileAutomationRunResponse> {
    const id = automationId.trim();
    if (!id || id.length > MAX_AUTOMATION_ID_LENGTH) {
      throw new MobileAutomationRequestError('A valid automation id is required');
    }
    const key = typeof body?.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
    if (!key || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new MobileAutomationRequestError('A valid idempotencyKey is required');
    }
    const outcome = await this.deps.getRunner().fire(id, {
      trigger: 'manual',
      idempotencyKey: key,
      triggerSource: { type: 'manual', id: 'mobile' },
    });
    return responseFor(outcome);
  }

  /**
   * GET /api/automations and POST /api/automations/:id/run. Returns false when
   * the request is not one of these routes; request errors propagate to the
   * caller's error mapping so their status codes survive.
   */
  async handle(req: IncomingMessage, res: ServerResponse, segments: string[], method: string): Promise<boolean> {
    if (segments[1] === 'automations' && segments.length === 2 && method === 'GET') {
      sendJsonResponse(res, 200, await this.list());
      return true;
    }
    if (segments[1] === 'automations' && segments.length === 4 && segments[3] === 'run' && method === 'POST') {
      const body = await readMobileAutomationRunRequest(req);
      let automationId: string;
      try {
        automationId = decodeURIComponent(segments[2]);
      } catch {
        throw new MobileAutomationRequestError('A valid automation id is required');
      }
      sendJsonResponse(res, 200, await this.run(automationId, body));
      return true;
    }
    return false;
  }
}
