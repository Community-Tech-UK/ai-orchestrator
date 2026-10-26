/**
 * Plan Queue MCP tools.
 *
 * `plan_queue_start`, `plan_queue_answer` and `plan_queue_control` are for
 * the session that runs a queue (the "parent"): answer and control are refused
 * from anyone else, and start is hidden from queue-spawned sessions. The one
 * exception is the stranded-run rescue in plan-queue-control-authority.ts:
 * once the parent no longer exists, another non-queue session may adopt or cancel the
 * run or discard a parked item.
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

const DECISION_SCHEMA = {
  description: 'Classify readiness: technical recommendations are answered automatically; human-authority and human-input remain questions. Absent metadata preserves a legacy manual question. This metadata never grants new authority.',
  oneOf: [
    {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['technical'] },
        recommendedOptionId: { type: 'string', minLength: 1, maxLength: 50, description: 'An existing non-skip option ID. The coordinator selects it automatically.' },
        reason: { type: 'string', minLength: 1, maxLength: 4000 },
        evidence: { type: 'string', minLength: 1, maxLength: 8000, description: 'Concrete evidence supporting this routine technical choice, normally source locations.' },
      },
      required: ['kind', 'recommendedOptionId', 'reason', 'evidence'],
      additionalProperties: false,
    },
    ...(['human-authority', 'human-input'] as const).map((kind) => ({
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [kind] },
        reason: { type: 'string', minLength: 1, maxLength: 4000, description: 'The specific authority still required or human fact that available evidence cannot resolve.' },
      },
      required: ['kind', 'reason'],
      additionalProperties: false,
    })),
  ],
};

/** One provider/account choice for `plan_queue_start` (mirrors PlanQueueRouteChoiceArgsSchema). */
const ROUTE_CHOICE_SCHEMA = {
  type: 'object',
  properties: {
    provider: { type: 'string', description: 'CLI id, for example "claude", "codex" or "copilot".' },
    model: { type: 'string', description: 'Optional model id. Omit for the provider\'s default.' },
    account_ids: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Claude, Codex or OpenCode account ids (Settings → Accounts) the session may use, including after a usage-limit switch. Omit for the account pool\'s own choice.' },
    copilot_account_id: { type: 'string', description: 'Copilot account id. Omit to let the Copilot account rules decide.' },
  },
  required: ['provider'],
  additionalProperties: false,
} as const;

/** Name, description and input schema per tool; shared with the stdio forwarder. */
export const PLAN_QUEUE_TOOL_SPECS = {
  plan_queue_start: {
    description:
      'Work through plan or livetest documents in this workspace, one visibly nested worker session per document, each in its own git worktree, judged by an independent verifier on a different provider, and landed on the current branch as one local squash commit per verified document (never pushed). Use it when James asks to "work through the plans" or "run the livetests". This session becomes the parent: evidence-backed technical readiness decisions are selected automatically; questions requiring human authority or facts come back to you, and you receive a summary when the run ends. Returns the discovered documents before any worker starts.',
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
        workers: { type: 'array', maxItems: 10, items: ROUTE_CHOICE_SCHEMA, description: 'Providers, models and accounts the workers may use, in preference order: each new worker session starts on the first with usage left. Used only when James saved no worker list on the Plan Queue page; his list always wins. Omit to use his list, else this session\'s own provider, model and account. Pass only when James asked for specific providers or accounts.' },
        verifiers: { type: 'array', maxItems: 10, items: ROUTE_CHOICE_SCHEMA, description: 'Checkers this run may use, in preference order: each check uses the first that can run with usage left. Used only when James saved no checker list; his list always wins. Omit to use his list, else automatic selection. Pass only when James asked for specific checkers.' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
  plan_queue_status: {
    description: 'Show a Plan Queue run: each document\'s state, verification round, open question, park reason and verdict findings. Without run_id, lists every running or paused run and every finished run with parked documents, plus the ten most recent runs, deduplicated and newest first. The recent window caps only ordinary history.',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string', description: 'Run id returned by plan_queue_start.' } },
      additionalProperties: false,
    },
  },
  plan_queue_answer: {
    description: 'Record an answer to a pending Plan Queue question. Evidence-backed technical recommendations are handled automatically by the coordinator. For human-authority, human-input or legacy unclassified questions, obtain James\'s answer and pass the chosen item_id and option_id. Apply existing standing authorization when investigating readiness; an automatic technical answer never grants new authority. Only the session that started the run may answer.',
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
    description: 'Control a Plan Queue run or item: pause stops its workers, triage and checkers now and saves work on document branches; resume continues with fresh sessions. Cancel ends a run (run_id); set-routing changes its worker/checker providers and accounts for future sessions (run_id and routing, optional move_in_progress); skip an item that has not started, resume a parked item, retry a blocked merge of a verified item, land a parked item without a verifier PASS, or discard a parked item\'s branch (item_id). Land anyway and discard change git state, so do them only when James asked. If the session that started a run no longer exists, any session the queue did not spawn may adopt the run (it then answers its questions and receives its summary), cancel it, or discard a parked item. Adopt when the work should continue; cancel only when James asked.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['pause', 'resume', 'cancel', 'adopt', 'set-routing', 'skip-item', 'resume-item', 'land-anyway', 'retry-landing', 'discard-item'] },
        run_id: { type: 'string', description: 'Required for pause, resume, cancel, adopt and set-routing.' },
        item_id: { type: 'string', description: 'Required for the item actions.' },
        routing: {
          type: 'object', description: "Required for set-routing. Replaces this run's routing for future sessions; workers and verifiers are in preference order, and workers:[] inherits the starting session. Does not change saved defaults. Parent only; an agent checker list cannot replace a protected work Copilot seat.",
          properties: { workers: { type: 'array', items: ROUTE_CHOICE_SCHEMA, maxItems: 10 }, verifiers: { type: 'array', items: ROUTE_CHOICE_SCHEMA, maxItems: 10 } },
          required: ['workers', 'verifiers'], additionalProperties: false,
        },
        move_in_progress: { type: 'boolean', description: 'set-routing only. Stop, checkpoint and restart in-progress sessions using the new choice now. Defaults to false.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  plan_queue_report_triage: {
    description: 'Plan Queue triage agents only: report one disposition per document (ready, needs-answer with classified decision metadata, or skip with a reason). Resolve routine choices and evidence gathering autonomously; the coordinator selects valid technical recommendations automatically. Reserve human-authority for missing approval and human-input for facts unavailable from investigation. Rejected from any other session.',
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
                    description: 'Two to four options with unique IDs. Include skip. A technical recommendation must reference an existing non-skip ID.',
                    items: {
                      type: 'object',
                      properties: { id: { type: 'string' }, label: { type: 'string' } },
                      required: ['id', 'label'],
                      additionalProperties: false,
                    },
                  },
                  decision: DECISION_SCHEMA,
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
