/**
 * Plan Queue MCP tools.
 *
 * `plan_queue_start`, `plan_queue_answer` and `plan_queue_control` are for
 * the session that runs a queue (the "parent"): answer and control are refused
 * from anyone else, and start is hidden from queue-spawned sessions.
 * `plan_queue_status` is read-only and open to every session, including the
 * queue's own. `plan_queue_report_triage` and `plan_queue_report_verdict` are
 * for the instances the queue spawns, and are accepted only from the instance
 * the coordinator registered for that role — a worker can never report its own
 * verdict. The coordinator is reached through injected operations (wired in
 * orchestrator-tools-step.ts), so this module stays free of main-process
 * singletons and is safe to load in the aio-mcp forwarder.
 */

import {
  PlanQueueAnswerArgsSchema,
  PlanQueueControlArgsSchema,
  PlanQueueReportTriageArgsSchema,
  PlanQueueReportVerdictArgsSchema,
  PlanQueueStartArgsSchema,
  PlanQueueStatusArgsSchema,
  type PlanQueueControlArgs,
  type PlanQueueReportTriageArgs,
  type PlanQueueReportVerdictArgs,
  type PlanQueueStartArgs,
} from '@contracts/schemas/plan-queue';
import type { McpServerToolDefinition } from './mcp-server-tools';

export interface PlanQueueToolOperations {
  start(callerInstanceId: string, args: PlanQueueStartArgs): Promise<unknown>;
  status(callerInstanceId: string, runId?: string): unknown;
  answer(callerInstanceId: string, itemId: string, optionId: string): Promise<unknown>;
  control(callerInstanceId: string, args: PlanQueueControlArgs): Promise<unknown>;
  reportVerdict(callerInstanceId: string, args: PlanQueueReportVerdictArgs): unknown;
  reportTriage(callerInstanceId: string, args: PlanQueueReportTriageArgs): unknown;
  /** True for workers, verifiers and triage agents the queue spawned. */
  isQueueInstance(instanceId: string): boolean;
}

export interface PlanQueueToolContext {
  instanceId?: string | null;
  planQueueTools?: PlanQueueToolOperations | null;
}

const FINDING_ITEMS = {
  type: 'object',
  properties: {
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    summary: { type: 'string', description: 'One sentence stating the defect.' },
    confidence: { type: 'integer', minimum: 0, maximum: 100, description: 'How sure you are that this is a real defect.' },
    file: { type: 'string', description: 'Evidence location, normally file:line.' },
    evidence: { type: 'string', description: 'What shows the defect is real.' },
  },
  required: ['severity', 'summary', 'confidence'],
  additionalProperties: false,
};

/** Name, description and input schema per tool; shared with the stdio forwarder. */
export const PLAN_QUEUE_TOOL_SPECS = {
  plan_queue_start: {
    description:
      'Work through plan or livetest documents in this workspace, one visibly nested worker session per document, each in its own git worktree, judged by an independent verifier on a different provider, and landed on the current branch as one local squash commit per verified document (never pushed). Use it when James asks to "work through the plans" or "run the livetests". This session becomes the parent: documents that need James\'s decision come back to you as questions to ask him, and you receive a summary when the run ends. Returns the discovered documents before any worker starts.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['plans', 'livetests'], description: '"plans" for *_plan.md documents, "livetests" for *_livetest.md documents.' },
        glob: { type: 'string', description: 'Optional repo-relative filter, for example "docs/plans/2026-09-*". Defaults to every matching document under docs/.' },
        worker_slots: { type: 'integer', minimum: 1, maximum: 8, description: 'Documents worked at once. Default 3 for plans, 1 for livetests.' },
        verification_slots: { type: 'integer', minimum: 1, maximum: 4, description: 'Verifications at once across all runs. Default 2 for plans.' },
        max_rounds: { type: 'integer', minimum: 1, maximum: 10, description: 'Verification rounds before an item is parked. Default 3.' },
        relax_settings: { type: 'boolean', description: 'Temporarily relax computerUseAutonomyLevel and providersExcludedFromAutomation for this run only. Only when James asked for it.' },
        verifier_gates: { type: 'array', items: { type: 'string' }, description: 'Commands every verifier must run and report. Defaults to this app\'s canonical checklist; pass the target repository\'s own commands for any other repository, or [] to let the verifier use the repository\'s documented checks.' },
        post_merge_gate: { type: 'array', items: { type: 'string' }, description: 'Commands the coordinator runs after merging a moved base branch into an item. Defaults to the two TypeScript checks; pass [] for a repository without them.' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
  plan_queue_status: {
    description: 'Show a Plan Queue run: each document\'s state, verification round, open question, park reason and verdict findings. Without run_id, lists recent runs.',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string', description: 'Run id returned by plan_queue_start.' } },
      additionalProperties: false,
    },
  },
  plan_queue_answer: {
    description: 'Record James\'s answer to a Plan Queue question. Ask James first (with your structured-question tool if you have one), then pass the item_id and the option_id he chose. Only the session that started the run may answer.',
    inputSchema: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: 'The item the question belongs to.' },
        option_id: { type: 'string', description: 'The id of the option James chose.' },
      },
      required: ['item_id', 'option_id'],
      additionalProperties: false,
    },
  },
  plan_queue_control: {
    description: 'Control a Plan Queue run or item: pause, resume or cancel a run (run_id); skip an item that has not started, resume a parked item, land a parked item without a verifier PASS, or discard a parked item\'s branch (item_id). Land anyway and discard change git state, so do them only when James asked.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['pause', 'resume', 'cancel', 'skip-item', 'resume-item', 'land-anyway', 'discard-item'] },
        run_id: { type: 'string', description: 'Required for pause, resume and cancel.' },
        item_id: { type: 'string', description: 'Required for the item actions.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  plan_queue_report_triage: {
    description: 'Plan Queue triage agents only: report one disposition per document (ready, needs-answer with a question for James, or skip with a reason). Rejected from any other session.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        records: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              documentPath: { type: 'string', description: 'Absolute path of the document.' },
              disposition: { type: 'string', enum: ['ready', 'needs-answer', 'skip'] },
              reason: { type: 'string', description: 'Required for skip.' },
              question: {
                type: 'object',
                description: 'Required for needs-answer.',
                properties: {
                  question: { type: 'string' },
                  options: {
                    type: 'array',
                    minItems: 2,
                    maxItems: 4,
                    items: {
                      type: 'object',
                      properties: { id: { type: 'string' }, label: { type: 'string' } },
                      required: ['id', 'label'],
                      additionalProperties: false,
                    },
                  },
                },
                required: ['question', 'options'],
                additionalProperties: false,
              },
            },
            required: ['documentPath', 'disposition'],
            additionalProperties: false,
          },
        },
      },
      required: ['run_id', 'records'],
      additionalProperties: false,
    },
  },
  plan_queue_report_verdict: {
    description: 'Plan Queue verifiers only: report the verdict on the item you were asked to verify. Rejected from any other session, including the item\'s own worker.',
    inputSchema: {
      type: 'object',
      properties: {
        item_id: { type: 'string' },
        verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
        findings: { type: 'array', items: FINDING_ITEMS },
        gates_run: {
          type: 'array',
          items: {
            type: 'object',
            properties: { command: { type: 'string' }, exitCode: { type: 'integer' } },
            required: ['command', 'exitCode'],
            additionalProperties: false,
          },
        },
        document_complete: { type: 'boolean', description: 'Whether the document may be renamed to its _completed name. False for a livetest with checks still open.' },
        need_james: {
          type: 'array',
          description: 'Livetests only: every check left as needing James, classified.',
          items: {
            type: 'object',
            properties: {
              check: { type: 'string' },
              classification: { type: 'string', enum: ['real', 'policy-gated', 'stale'] },
              reason: { type: 'string' },
            },
            required: ['check', 'classification', 'reason'],
            additionalProperties: false,
          },
        },
      },
      required: ['item_id', 'verdict'],
      additionalProperties: false,
    },
  },
} as const satisfies Record<string, { description: string; inputSchema: Record<string, unknown> }>;

export type PlanQueueToolName = keyof typeof PLAN_QUEUE_TOOL_SPECS;
export const PLAN_QUEUE_TOOL_NAMES = Object.keys(PLAN_QUEUE_TOOL_SPECS) as PlanQueueToolName[];

const RPC_PREFIX = 'orchestrator_tools.';

export function isPlanQueueRpcMethod(method: string): boolean {
  return method.startsWith(RPC_PREFIX) && (PLAN_QUEUE_TOOL_NAMES as string[]).includes(method.slice(RPC_PREFIX.length));
}

type Handler = (callerInstanceId: string, ops: PlanQueueToolOperations, args: unknown) => Promise<unknown> | unknown;

const HANDLERS: Record<PlanQueueToolName, Handler> = {
  plan_queue_start: (caller, ops, args) => ops.start(caller, PlanQueueStartArgsSchema.parse(args)),
  plan_queue_status: (caller, ops, args) => ops.status(caller, PlanQueueStatusArgsSchema.parse(args ?? {}).run_id),
  plan_queue_answer: (caller, ops, args) => {
    const parsed = PlanQueueAnswerArgsSchema.parse(args);
    return ops.answer(caller, parsed.item_id, parsed.option_id);
  },
  plan_queue_control: (caller, ops, args) => ops.control(caller, PlanQueueControlArgsSchema.parse(args)),
  plan_queue_report_triage: (caller, ops, args) => ops.reportTriage(caller, PlanQueueReportTriageArgsSchema.parse(args)),
  plan_queue_report_verdict: (caller, ops, args) => ops.reportVerdict(caller, PlanQueueReportVerdictArgsSchema.parse(args)),
};

/** Tools a queue-spawned instance must not see: no queue inside a queue. */
const PARENT_ONLY: ReadonlySet<PlanQueueToolName> = new Set<PlanQueueToolName>(['plan_queue_start']);

export function createPlanQueueToolDefinitions(context: PlanQueueToolContext): McpServerToolDefinition[] {
  const ops = context.planQueueTools;
  const callerId = context.instanceId;
  if (!ops || !callerId) return [];
  const queueSpawned = ops.isQueueInstance(callerId);
  return PLAN_QUEUE_TOOL_NAMES
    .filter((name) => !(queueSpawned && PARENT_ONLY.has(name)))
    .map((name) => ({
      name,
      description: PLAN_QUEUE_TOOL_SPECS[name].description,
      inputSchema: PLAN_QUEUE_TOOL_SPECS[name].inputSchema,
      handler: async (args: unknown) => HANDLERS[name](callerId, ops, args),
    }));
}
