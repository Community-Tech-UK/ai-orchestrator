import { IPC_CHANNELS } from '@contracts/channels';
import type { AutomationRunStatus } from '../../shared/types/automation.types';
import type { InstanceStatus } from '../../shared/types/instance.types';
import type { LoopStatus } from '../../shared/types/loop.types';
import type {
  AutomationPhaseChangedPayload,
  EventTier,
  InstancePhaseChangedPayload,
  LoopPhaseChangedPayload,
  ThinClientEvent,
} from '../../shared/types/thin-client-event.types';
import {
  automationRunStatusToPhase,
  instanceStatusToPhase,
  loopStatusToPhase,
} from '../../shared/types/workflow-lifecycle.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('MainEventBus');
const U32_MODULO = 0x1_0000_0000;
const U32_HALF_RANGE = 0x8000_0000;

export interface EventTransport {
  tiers: Set<EventTier> | 'all';
  send(event: ThinClientEvent, rendererArgs?: readonly unknown[]): void;
}

export interface MainEventBusOptions {
  now?: () => number;
  initialSeq?: number;
}

interface EmitOptions {
  rendererArgs?: readonly unknown[];
  synthesizeLifecycleEvents?: boolean;
}

type PendingThinClientEvent<T = unknown> = Omit<ThinClientEvent<T>, 'seq'>;

const LIFECYCLE_EVENTS = new Set<string>([
  IPC_CHANNELS.INSTANCE_CREATED,
  IPC_CHANNELS.INSTANCE_REMOVED,
  IPC_CHANNELS.INSTANCE_COMPACT_STATUS,
  IPC_CHANNELS.MEMORY_WARNING,
  IPC_CHANNELS.MEMORY_CRITICAL,
  'context:warning',
  'instance:phase-changed',
  'loop:phase-changed',
  'automation:phase-changed',
]);

const OUTPUT_EVENTS = new Set<string>([
  IPC_CHANNELS.PROVIDER_RUNTIME_EVENT,
  IPC_CHANNELS.INSTANCE_TRANSCRIPT_CHUNK,
  IPC_CHANNELS.LLM_STREAM_CHUNK,
]);

const INTERACTION_EVENTS = new Set<string>([
  IPC_CHANNELS.INPUT_REQUIRED,
  IPC_CHANNELS.USER_ACTION_REQUEST,
  IPC_CHANNELS.WORKFLOW_GATE_PENDING,
  IPC_CHANNELS.PLAN_MODE_UPDATE,
  'instance:input-required',
  'user-action:request',
]);

const CONTROL_EVENTS = new Set<string>([
  IPC_CHANNELS.WORKFLOW_PHASE_CHANGED,
  IPC_CHANNELS.DEBATE_EVENT_ROUND_COMPLETE,
  IPC_CHANNELS.VERIFICATION_EVENT_PROGRESS,
  IPC_CHANNELS.VERIFICATION_EVENT_COMPLETED,
  IPC_CHANNELS.ORCHESTRATION_ACTIVITY,
  IPC_CHANNELS.INSTANCE_STATE_UPDATE,
  IPC_CHANNELS.INSTANCE_BATCH_UPDATE,
  IPC_CHANNELS.LOOP_STATE_CHANGED,
  IPC_CHANNELS.AUTOMATION_RUN_CHANGED,
  IPC_CHANNELS.LOOP_ITERATION_COMPLETE,
  IPC_CHANNELS.LOOP_INTERVENTION_APPLIED,
  IPC_CHANNELS.SUPERVISION_HEALTH_CHANGED,
]);

const STATUS_EVENTS = new Set<string>([
  IPC_CHANNELS.COST_USAGE_RECORDED,
  IPC_CHANNELS.QUOTA_UPDATED,
  IPC_CHANNELS.QUOTA_WARNING,
  IPC_CHANNELS.QUOTA_EXHAUSTED,
  IPC_CHANNELS.TODO_LIST_CHANGED,
  IPC_CHANNELS.SETTINGS_CHANGED,
  IPC_CHANNELS.MCP_SERVER_STATUS_CHANGED,
  'cost:budget-warning',
  'cost:budget-exceeded',
]);

const INFRA_EVENTS = new Set<string>([
  IPC_CHANNELS.VCS_STATUS_CHANGED,
  IPC_CHANNELS.VCS_OPERATION_PROGRESS,
  IPC_CHANNELS.WATCHER_FILE_CHANGED,
  IPC_CHANNELS.WATCHER_ERROR,
  IPC_CHANNELS.PLUGINS_LOADED,
  IPC_CHANNELS.PLUGINS_UNLOADED,
  IPC_CHANNELS.PLUGINS_ERROR,
  IPC_CHANNELS.MODELS_CATALOG_UPDATED,
  IPC_CHANNELS.CODEBASE_AUTO_STATUS_CHANGED,
  IPC_CHANNELS.ECOSYSTEM_CHANGED,
  IPC_CHANNELS.MCP_STATE_CHANGED,
  IPC_CHANNELS.MCP_MULTI_PROVIDER_STATE_CHANGED,
]);

export class MainEventBus {
  private readonly transports = new Set<EventTransport>();
  private readonly now: () => number;
  private readonly initialSeq: number;
  private highestIssuedSeq: number;
  private transportSeqs = new WeakMap<EventTransport, number>();

  constructor(options: MainEventBusOptions = {}) {
    this.now = options.now ?? Date.now;
    this.initialSeq = options.initialSeq ?? 0;
    this.highestIssuedSeq = this.initialSeq;
  }

  emit<T>(tier: EventTier, type: string, payload: T, options: EmitOptions = {}): void {
    const event = this.createEvent(tier, type, payload);
    this.dispatch(event, options.rendererArgs);
    if (options.synthesizeLifecycleEvents !== false) {
      this.emitSyntheticLifecycleEvent(event);
    }
  }

  emitRendererEvent(type: string, ...args: unknown[]): void {
    this.emit(resolveEventTier(type), type, normalizeRendererPayload(args), {
      rendererArgs: args,
    });
  }

  addTransport(transport: EventTransport): void {
    this.transports.add(transport);
  }

  removeTransport(transport: EventTransport): void {
    this.transports.delete(transport);
    this.transportSeqs.delete(transport);
  }

  clearTransports(): void {
    this.transports.clear();
    this.transportSeqs = new WeakMap<EventTransport, number>();
  }

  getSnapshotSeq(): number {
    return this.highestIssuedSeq;
  }

  getSnapshotSeqForTransport(transport: EventTransport): number {
    return this.transportSeqs.get(transport) ?? this.initialSeq;
  }

  private createEvent<T>(tier: EventTier, type: string, payload: T): PendingThinClientEvent<T> {
    return {
      ts: this.now(),
      tier,
      type,
      payload,
    };
  }

  private dispatch(event: PendingThinClientEvent, rendererArgs?: readonly unknown[]): void {
    for (const transport of this.transports) {
      if (!transportAcceptsTier(transport, event.tier)) {
        continue;
      }
      try {
        transport.send({ ...event, seq: this.nextSeqForTransport(transport) }, rendererArgs);
      } catch (error) {
        logger.warn('Thin-client event transport failed', {
          type: event.type,
          tier: event.tier,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private nextSeqForTransport(transport: EventTransport): number {
    const current = this.transportSeqs.get(transport) ?? this.initialSeq;
    const next = (current + 1) % U32_MODULO;
    this.transportSeqs.set(transport, next);
    if (isSequenceAfter(next, this.highestIssuedSeq)) {
      this.highestIssuedSeq = next;
    }
    return next;
  }

  private emitSyntheticLifecycleEvent(event: PendingThinClientEvent): void {
    switch (event.type) {
      case IPC_CHANNELS.INSTANCE_STATE_UPDATE:
        this.emitInstancePhaseChanged(event.payload);
        break;
      case IPC_CHANNELS.LOOP_STATE_CHANGED:
        this.emitLoopPhaseChanged(event.payload);
        break;
      case IPC_CHANNELS.AUTOMATION_RUN_CHANGED:
        this.emitAutomationPhaseChanged(event.payload);
        break;
    }
  }

  private emitInstancePhaseChanged(payload: unknown): void {
    const record = asRecord(payload);
    const instanceId = asString(record?.['instanceId']);
    const phaseProjection = projectInstanceStatus(record?.['status']);
    if (!instanceId || !phaseProjection) {
      return;
    }

    const phasePayload: InstancePhaseChangedPayload = {
      instanceId,
      status: phaseProjection.status,
      phase: phaseProjection.phase,
    };
    this.emit('lifecycle', 'instance:phase-changed', phasePayload, {
      rendererArgs: [phasePayload],
      synthesizeLifecycleEvents: false,
    });
  }

  private emitLoopPhaseChanged(payload: unknown): void {
    const record = asRecord(payload);
    const state = asRecord(record?.['state']);
    const phaseProjection = projectLoopStatus(
      state?.['status'] ?? record?.['status'],
      hasOwnRecordKey(state, 'endedAt') ? state['endedAt'] : record?.['endedAt'],
    );
    const loopRunId = asString(record?.['loopRunId'] ?? state?.['id']);
    if (!loopRunId || !phaseProjection) {
      return;
    }

    const phasePayload: LoopPhaseChangedPayload = {
      loopRunId,
      status: phaseProjection.status,
      phase: phaseProjection.phase,
    };
    const chatId = asString(record?.['chatId'] ?? state?.['chatId']);
    if (chatId) {
      phasePayload.chatId = chatId;
    }
    this.emit('lifecycle', 'loop:phase-changed', phasePayload, {
      rendererArgs: [phasePayload],
      synthesizeLifecycleEvents: false,
    });
  }

  private emitAutomationPhaseChanged(payload: unknown): void {
    const record = asRecord(payload);
    const run = asRecord(record?.['run']);
    const phaseProjection = projectAutomationRunStatus(run?.['status'] ?? record?.['status']);
    const runId = asString(record?.['runId'] ?? run?.['id']);
    const automationId = asString(record?.['automationId'] ?? run?.['automationId']);
    if (!runId || !automationId || !phaseProjection) {
      return;
    }

    const phasePayload: AutomationPhaseChangedPayload = {
      runId,
      automationId,
      status: phaseProjection.status,
      phase: phaseProjection.phase,
    };
    this.emit('lifecycle', 'automation:phase-changed', phasePayload, {
      rendererArgs: [phasePayload],
      synthesizeLifecycleEvents: false,
    });
  }
}

let singleton: MainEventBus | null = null;

export function getMainEventBus(): MainEventBus {
  if (!singleton) {
    singleton = new MainEventBus();
  }
  return singleton;
}

export function _resetMainEventBusForTesting(): void {
  singleton = null;
}

export function resolveEventTier(type: string): EventTier {
  if (LIFECYCLE_EVENTS.has(type)) return 'lifecycle';
  if (OUTPUT_EVENTS.has(type)) return 'output';
  if (INTERACTION_EVENTS.has(type)) return 'interaction';
  if (CONTROL_EVENTS.has(type)) return 'control';
  if (STATUS_EVENTS.has(type)) return 'status';
  if (INFRA_EVENTS.has(type)) return 'infra';

  if (type.startsWith('workflow:') || type.startsWith('loop:') || type.startsWith('debate:')) {
    return 'control';
  }
  if (type.startsWith('verification:') || type.startsWith('orchestration:')) {
    return 'control';
  }
  if (type.startsWith('memory:') || type.startsWith('cost:') || type.startsWith('quota:')) {
    return 'status';
  }
  if (type.startsWith('settings:') || type.startsWith('todo:') || type.startsWith('mcp:')) {
    return 'status';
  }
  if (
    type.startsWith('vcs:')
    || type.startsWith('watcher:')
    || type.startsWith('plugins:')
    || type.startsWith('codebase:')
    || type.startsWith('ecosystem:')
    || type.startsWith('rlm:')
    || type.startsWith('kg:')
  ) {
    return 'infra';
  }
  return 'infra';
}

function normalizeRendererPayload(args: readonly unknown[]): unknown {
  if (args.length === 0) return undefined;
  if (args.length === 1) return args[0];
  return [...args];
}

function transportAcceptsTier(transport: EventTransport, tier: EventTier): boolean {
  return transport.tiers === 'all' || transport.tiers.has(tier);
}

function isSequenceAfter(candidate: number, current: number): boolean {
  if (candidate === current) {
    return false;
  }
  return (candidate - current + U32_MODULO) % U32_MODULO < U32_HALF_RANGE;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function hasOwnRecordKey(record: Record<string, unknown> | null, key: string): record is Record<string, unknown> {
  return record !== null && Object.prototype.hasOwnProperty.call(record, key);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function projectInstanceStatus(
  value: unknown
): { status: InstanceStatus; phase: InstancePhaseChangedPayload['phase'] } | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const status = value as InstanceStatus;
  try {
    return { status, phase: instanceStatusToPhase(status) };
  } catch {
    return undefined;
  }
}

function projectLoopStatus(
  value: unknown,
  endedAt?: unknown,
): { status: LoopStatus; phase: LoopPhaseChangedPayload['phase'] } | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const status = value as LoopStatus;
  try {
    if (status === 'provider-limit' && endedAt != null) {
      return { status, phase: 'failed' };
    }
    return { status, phase: loopStatusToPhase(status) };
  } catch {
    return undefined;
  }
}

function projectAutomationRunStatus(
  value: unknown
): { status: AutomationRunStatus; phase: AutomationPhaseChangedPayload['phase'] } | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const status = value as AutomationRunStatus;
  try {
    return { status, phase: automationRunStatusToPhase(status) };
  } catch {
    return undefined;
  }
}
