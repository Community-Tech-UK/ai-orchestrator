import { randomUUID } from 'crypto';
import type { z } from 'zod';
import {
  OperatorNodeInputJsonSchema,
  OperatorNodeOutputJsonSchema,
  OperatorPlanJsonSchema,
  OperatorResultJsonSchema,
  OperatorRunBudgetSchema,
  OperatorRunEventPayloadSchema,
  OperatorRunUsageSchema,
} from '@contracts/schemas/operator';
import type {
  OperatorInstanceLinkRecoveryState,
  OperatorInstanceLinkRecord,
  OperatorNodeType,
  OperatorRunBudget,
  OperatorRunEventKind,
  OperatorRunEventRecord,
  OperatorRunGraph,
  OperatorRunNodeRecord,
  OperatorRunRecord,
  OperatorRunStatus,
  OperatorRunUsage,
} from '../../shared/types/operator.types';
import type { SqliteDriver } from '../db/sqlite-driver';
import { getLogger } from '../logging/logger';
import { getOperatorEventBus } from './operator-event-bus';

const logger = getLogger('OperatorRunStore');

const DEFAULT_BUDGET: OperatorRunBudget = {
  maxNodes: 50,
  maxRetries: 3,
  maxWallClockMs: 2 * 60 * 60 * 1000,
  maxConcurrentNodes: 3,
};

const DEFAULT_USAGE: OperatorRunUsage = {
  nodesStarted: 0,
  nodesCompleted: 0,
  retriesUsed: 0,
  wallClockMs: 0,
};

interface RunRow {
  id: string;
  thread_id: string;
  source_message_id: string;
  title: string;
  status: OperatorRunStatus;
  autonomy_mode: 'full';
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  goal: string;
  budget_json: string;
  usage_json: string;
  plan_json: string;
  result_json: string | null;
  error: string | null;
}

interface NodeRow {
  id: string;
  run_id: string;
  parent_node_id: string | null;
  type: OperatorNodeType;
  status: OperatorRunStatus;
  target_project_id: string | null;
  target_path: string | null;
  title: string;
  input_json: string;
  output_json: string | null;
  external_ref_kind: OperatorRunNodeRecord['externalRefKind'];
  external_ref_id: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  error: string | null;
}

interface EventRow {
  id: string;
  run_id: string;
  node_id: string | null;
  kind: OperatorRunEventKind;
  payload_json: string;
  created_at: number;
}

interface InstanceLinkRow {
  instance_id: string;
  run_id: string;
  node_id: string;
  created_at: number;
  last_seen_at: number;
  recovery_state: OperatorInstanceLinkRecoveryState;
}

export interface OperatorRunCreateInput {
  threadId: string;
  sourceMessageId: string;
  title: string;
  goal: string;
  budget?: Partial<OperatorRunBudget>;
  planJson?: Record<string, unknown>;
}

export interface OperatorNodeCreateInput {
  runId: string;
  parentNodeId?: string | null;
  type: OperatorNodeType;
  targetProjectId?: string | null;
  targetPath?: string | null;
  title: string;
  inputJson?: Record<string, unknown>;
  externalRefKind?: OperatorRunNodeRecord['externalRefKind'];
  externalRefId?: string | null;
}

export interface OperatorRunUpdateInput {
  status?: OperatorRunStatus;
  usageJson?: Partial<OperatorRunUsage>;
  planJson?: Record<string, unknown>;
  resultJson?: Record<string, unknown> | null;
  completedAt?: number | null;
  error?: string | null;
}

export interface OperatorNodeUpdateInput {
  status?: OperatorRunStatus;
  outputJson?: Record<string, unknown> | null;
  externalRefKind?: OperatorRunNodeRecord['externalRefKind'];
  externalRefId?: string | null;
  completedAt?: number | null;
  error?: string | null;
}

export interface OperatorRunEventInput {
  runId: string;
  nodeId?: string | null;
  kind: OperatorRunEventKind;
  payload: Record<string, unknown>;
}

export interface OperatorInstanceLinkUpsertInput {
  instanceId: string;
  runId: string;
  nodeId: string;
  recoveryState?: OperatorInstanceLinkRecoveryState;
}

export interface OperatorStalledNodeQuery {
  now: number;
  thresholds: Partial<Record<OperatorNodeType, number>>;
}

export interface OperatorStalledNodeCandidate {
  run: OperatorRunRecord;
  node: OperatorRunNodeRecord;
  lastProgressAt: number;
  stallMs: number;
  thresholdMs: number;
}

export class OperatorRunStore {
  constructor(private readonly db: SqliteDriver) {}

  createRun(input: OperatorRunCreateInput): OperatorRunRecord {
    const now = Date.now();
    const id = randomUUID();
    const budget = validateStructuredJson('budget', OperatorRunBudgetSchema, { ...DEFAULT_BUDGET, ...(input.budget ?? {}) });
    const usage = validateStructuredJson('usageJson', OperatorRunUsageSchema, { ...DEFAULT_USAGE });
    const planJson = validateStructuredJson(
      'planJson',
      OperatorPlanJsonSchema,
      input.planJson === undefined ? {} : input.planJson,
    );
    this.db.prepare(`
      INSERT INTO operator_runs (
        id, thread_id, source_message_id, title, status, autonomy_mode,
        created_at, updated_at, completed_at, goal, budget_json, usage_json,
        plan_json, result_json, error
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.threadId,
      input.sourceMessageId,
      input.title,
      'queued',
      'full',
      now,
      now,
      null,
      input.goal,
      stringifyObject(budget),
      stringifyObject(usage),
      stringifyObject(planJson),
      null,
      null,
    );
    return this.getRun(id)!;
  }

  createNode(input: OperatorNodeCreateInput): OperatorRunNodeRecord {
    const now = Date.now();
    const id = randomUUID();
    const inputJson = validateStructuredJson(
      'inputJson',
      OperatorNodeInputJsonSchema,
      input.inputJson === undefined ? {} : input.inputJson,
    );
    this.db.prepare(`
      INSERT INTO operator_run_nodes (
        id, run_id, parent_node_id, type, status, target_project_id,
        target_path, title, input_json, output_json, external_ref_kind,
        external_ref_id, created_at, updated_at, completed_at, error
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.runId,
      input.parentNodeId ?? null,
      input.type,
      'queued',
      input.targetProjectId ?? null,
      input.targetPath ?? null,
      input.title,
      stringifyObject(inputJson),
      null,
      input.externalRefKind ?? null,
      input.externalRefId ?? null,
      now,
      now,
      null,
      null,
    );
    return this.getNode(id)!;
  }

  updateRun(runId: string, update: OperatorRunUpdateInput): OperatorRunRecord {
    const existing = this.getRun(runId);
    if (!existing) {
      throw new Error(`Operator run not found: ${runId}`);
    }
    const usageJson = update.usageJson
      ? validateStructuredJson('usageJson', OperatorRunUsageSchema, { ...existing.usageJson, ...update.usageJson })
      : existing.usageJson;
    const planJson = update.planJson === undefined
      ? existing.planJson
      : validateStructuredJson('planJson', OperatorPlanJsonSchema, update.planJson);
    const resultJson = update.resultJson === undefined || update.resultJson === null
      ? update.resultJson
      : validateStructuredJson('resultJson', OperatorResultJsonSchema, update.resultJson);
    this.db.prepare(`
      UPDATE operator_runs
      SET status = ?, updated_at = ?, completed_at = ?, usage_json = ?,
          plan_json = ?, result_json = ?, error = ?
      WHERE id = ?
    `).run(
      update.status ?? existing.status,
      Date.now(),
      update.completedAt !== undefined ? update.completedAt : existing.completedAt,
      stringifyObject(usageJson),
      stringifyObject(planJson),
      update.resultJson === undefined ? nullableStringify(existing.resultJson) : nullableStringify(resultJson),
      update.error !== undefined ? update.error : existing.error,
      runId,
    );
    return this.getRun(runId)!;
  }

  updateNode(nodeId: string, update: OperatorNodeUpdateInput): OperatorRunNodeRecord {
    const existing = this.getNode(nodeId);
    if (!existing) {
      throw new Error(`Operator run node not found: ${nodeId}`);
    }
    const outputJson = update.outputJson === undefined || update.outputJson === null
      ? update.outputJson
      : validateStructuredJson('outputJson', OperatorNodeOutputJsonSchema, update.outputJson);
    this.db.prepare(`
      UPDATE operator_run_nodes
      SET status = ?, updated_at = ?, output_json = ?, external_ref_kind = ?,
          external_ref_id = ?, completed_at = ?, error = ?
      WHERE id = ?
    `).run(
      update.status ?? existing.status,
      Date.now(),
      update.outputJson === undefined ? nullableStringify(existing.outputJson) : nullableStringify(outputJson),
      update.externalRefKind !== undefined ? update.externalRefKind : existing.externalRefKind,
      update.externalRefId !== undefined ? update.externalRefId : existing.externalRefId,
      update.completedAt !== undefined ? update.completedAt : existing.completedAt,
      update.error !== undefined ? update.error : existing.error,
      nodeId,
    );
    return this.getNode(nodeId)!;
  }

  appendEvent(input: OperatorRunEventInput): OperatorRunEventRecord {
    const id = randomUUID();
    const createdAt = Date.now();
    const eventPayload = validateStructuredJson(`${input.kind} event payload`, OperatorRunEventPayloadSchema, {
      kind: input.kind,
      payload: input.payload,
    });
    this.db.prepare(`
      INSERT INTO operator_run_events (
        id, run_id, node_id, kind, payload_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.runId,
      input.nodeId ?? null,
      input.kind,
      stringifyObject(eventPayload.payload),
      createdAt,
    );
    const event = this.getEvent(id)!;
    getOperatorEventBus().publish(event);
    return event;
  }

  getRun(id: string): OperatorRunRecord | null {
    const row = this.db.prepare('SELECT * FROM operator_runs WHERE id = ?').get<RunRow>(id);
    return row ? runRowToRecord(row) : null;
  }

  getNode(id: string): OperatorRunNodeRecord | null {
    const row = this.db.prepare('SELECT * FROM operator_run_nodes WHERE id = ?').get<NodeRow>(id);
    return row ? nodeRowToRecord(row) : null;
  }

  getEvent(id: string): OperatorRunEventRecord | null {
    const row = this.db.prepare('SELECT * FROM operator_run_events WHERE id = ?').get<EventRow>(id);
    return row ? eventRowToRecord(row) : null;
  }

  getRunGraph(runId: string): OperatorRunGraph | null {
    const run = this.getRun(runId);
    if (!run) return null;
    const nodes = this.db.prepare(`
      SELECT * FROM operator_run_nodes
      WHERE run_id = ?
      ORDER BY created_at ASC, rowid ASC
    `).all<NodeRow>(runId).map(nodeRowToRecord);
    const events = this.db.prepare(`
      SELECT * FROM operator_run_events
      WHERE run_id = ?
      ORDER BY created_at ASC, rowid ASC
    `).all<EventRow>(runId).map(eventRowToRecord);
    return { run, nodes, events };
  }

  listRuns(query: { threadId?: string; status?: OperatorRunStatus; limit?: number } = {}): OperatorRunRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.threadId) {
      where.push('thread_id = ?');
      params.push(query.threadId);
    }
    if (query.status) {
      where.push('status = ?');
      params.push(query.status);
    }
    const limit = Math.max(1, Math.min(query.limit ?? 100, 500));
    const rows = this.db.prepare(`
      SELECT * FROM operator_runs
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC
      LIMIT ?
    `).all<RunRow>(...params, limit);
    return rows.map(runRowToRecord);
  }

  listStalledNodes(query: OperatorStalledNodeQuery): OperatorStalledNodeCandidate[] {
    const rows = this.db.prepare(`
      SELECT * FROM operator_run_nodes
      WHERE status IN ('running', 'waiting')
      ORDER BY updated_at ASC
    `).all<NodeRow>();
    const candidates: OperatorStalledNodeCandidate[] = [];

    for (const row of rows) {
      const node = nodeRowToRecord(row);
      const thresholdMs = query.thresholds[node.type];
      if (thresholdMs === undefined) continue;

      const run = this.getRun(node.runId);
      if (!run || (run.status !== 'running' && run.status !== 'waiting')) continue;

      const lastProgressAt = this.getLastNodeProgressAt(node.runId, node.id) ?? node.updatedAt;
      const stallMs = query.now - lastProgressAt;
      if (stallMs <= thresholdMs) continue;

      candidates.push({
        run,
        node,
        lastProgressAt,
        stallMs,
        thresholdMs,
      });
    }

    return candidates;
  }

  upsertInstanceLink(input: OperatorInstanceLinkUpsertInput): OperatorInstanceLinkRecord {
    const now = Date.now();
    const recoveryState = input.recoveryState ?? 'active';
    this.db.prepare(`
      INSERT INTO operator_instance_links (
        instance_id, run_id, node_id, created_at, last_seen_at, recovery_state
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(instance_id) DO UPDATE SET
        run_id = excluded.run_id,
        node_id = excluded.node_id,
        last_seen_at = excluded.last_seen_at,
        recovery_state = excluded.recovery_state
    `).run(
      input.instanceId,
      input.runId,
      input.nodeId,
      now,
      now,
      recoveryState,
    );
    return this.getInstanceLink(input.instanceId)!;
  }

  touchInstanceLink(
    instanceId: string,
    recoveryState: OperatorInstanceLinkRecoveryState = 'active',
  ): OperatorInstanceLinkRecord | null {
    const existing = this.getInstanceLink(instanceId);
    if (!existing) return null;
    this.db.prepare(`
      UPDATE operator_instance_links
      SET last_seen_at = ?, recovery_state = ?
      WHERE instance_id = ?
    `).run(Date.now(), recoveryState, instanceId);
    return this.getInstanceLink(instanceId);
  }

  getInstanceLink(instanceId: string): OperatorInstanceLinkRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM operator_instance_links
      WHERE instance_id = ?
    `).get<InstanceLinkRow>(instanceId);
    return row ? instanceLinkRowToRecord(row) : null;
  }

  listInstanceLinksForRun(runId: string): OperatorInstanceLinkRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM operator_instance_links
      WHERE run_id = ?
      ORDER BY created_at ASC
    `).all<InstanceLinkRow>(runId);
    return rows.map(instanceLinkRowToRecord);
  }

  private getLastNodeProgressAt(runId: string, nodeId: string): number | null {
    const row = this.db.prepare(`
      SELECT MAX(created_at) AS last_progress_at
      FROM operator_run_events
      WHERE run_id = ?
        AND node_id = ?
        AND kind IN ('progress', 'shell-command', 'instance-spawn', 'verification-result')
    `).get<{ last_progress_at: number | null }>(runId, nodeId);
    return row?.last_progress_at ?? null;
  }
}

export function defaultOperatorRunBudget(): OperatorRunBudget {
  return { ...DEFAULT_BUDGET };
}

function runRowToRecord(row: RunRow): OperatorRunRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    sourceMessageId: row.source_message_id,
    title: row.title,
    status: row.status,
    autonomyMode: row.autonomy_mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    goal: row.goal,
    budget: parseObject<OperatorRunBudget>(row.budget_json, DEFAULT_BUDGET),
    usageJson: parseObject<OperatorRunUsage>(row.usage_json, DEFAULT_USAGE),
    planJson: parseObject(row.plan_json, {}),
    resultJson: row.result_json ? parseObject(row.result_json, {}) : null,
    error: row.error,
  };
}

function nodeRowToRecord(row: NodeRow): OperatorRunNodeRecord {
  return {
    id: row.id,
    runId: row.run_id,
    parentNodeId: row.parent_node_id,
    type: row.type,
    status: row.status,
    targetProjectId: row.target_project_id,
    targetPath: row.target_path,
    title: row.title,
    inputJson: parseObject(row.input_json, {}),
    outputJson: row.output_json ? parseObject(row.output_json, {}) : null,
    externalRefKind: row.external_ref_kind,
    externalRefId: row.external_ref_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    error: row.error,
  };
}

function eventRowToRecord(row: EventRow): OperatorRunEventRecord {
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    kind: row.kind,
    payload: parseObject(row.payload_json, {}),
    createdAt: row.created_at,
  };
}

function instanceLinkRowToRecord(row: InstanceLinkRow): OperatorInstanceLinkRecord {
  return {
    instanceId: row.instance_id,
    runId: row.run_id,
    nodeId: row.node_id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    recoveryState: row.recovery_state,
  };
}

function stringifyObject(value: unknown): string {
  return JSON.stringify(value);
}

function nullableStringify(value: unknown | null): string | null {
  return value ? JSON.stringify(value) : null;
}

function parseObject<T>(value: string, fallback: T): T {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as T
      : fallback;
  } catch (error) {
    logger.warn('Corrupt operator run JSON encountered', {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}

function validateStructuredJson<T extends z.ZodTypeAny>(
  label: string,
  schema: T,
  value: unknown,
): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  throw new Error(`Invalid operator ${label}: ${result.error.issues.map((issue) => issue.message).join('; ')}`);
}
