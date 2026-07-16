/**
 * WS8 (loop-convergence plan) — import a scoped repository plan as a safe
 * sequential Campaign.
 *
 * WS7 classifies multi-workstream plans as campaign material; this module
 * BUILDS that campaign: one loop node per extracted workstream, in document
 * order, strictly sequential (`maxParallel: 1`, completed-only edges,
 * pause-campaign on needs-review, no isolation — nodes intentionally share the
 * checkout one at a time), each node bounded by the WS6 finite defaults and
 * carrying the caller's verify authority. A final `integration-gate` node runs
 * the canonical verification checklist and is the ONLY node allowed to rename
 * the plan `_completed.md`.
 *
 * Pure module — no I/O, no clocks: the caller supplies the plan text and a
 * timestamp. Import NEVER auto-starts: the preview (nodes, per-node caps,
 * aggregate worst-case estimate, policy, gate) goes to the user first, and the
 * source digest lets Campaign start reject a stale preview.
 */

import { createHash } from 'node:crypto';
import type { CampaignEdge, CampaignNode, CampaignSpec } from '../../shared/types/campaign.types';
import type { LoopProvider } from '../../shared/types/loop.types';
import {
  DEFAULT_LOOP_MAX_COST_CENTS,
  LOOP_DEFAULT_MAX_TURNS_PER_ITERATION,
  defaultLoopConfig,
} from '../../shared/types/loop.types';
import { assessLoopScope, type LoopScopeAssessment } from './loop-scope-assessment';

export interface CampaignPlanImportBaseLoop {
  /** Verify command copied into every node — the WS6 verification authority.
   *  Required: workstream nodes are implementation loops. */
  verifyCommand: string;
  provider?: LoopProvider;
  /** Per-node estimated cost cap in cents. Defaults to the WS6 $30 default. */
  maxCostCents?: number;
  /** Per-node turn cap. Defaults to the WS6 30-turn default. */
  maxTurnsPerIteration?: number;
}

export interface CampaignPlanImportInput {
  workspaceCwd: string;
  /** Workspace-relative plan path (becomes `sourceRef`). */
  planFile: string;
  planText: string;
  baseLoop: CampaignPlanImportBaseLoop;
  /** Caller-supplied timestamp (pure module — no clocks). */
  now: number;
}

export interface CampaignPlanImportResult {
  spec: CampaignSpec;
  /** sha256 hex of the plan text — start-time staleness check anchor. */
  sourceDigest: string;
  /** Worst-case estimate: node count × per-node cap. NOT an invoice or a
   *  guaranteed charge — sequential nodes usually stop far earlier. */
  aggregateMaxCostCents: number;
  assessment: LoopScopeAssessment;
}

export const INTEGRATION_GATE_NODE_ID = 'integration-gate';

/** sha256 hex digest of plan text (shared by preview and start-time check). */
export function computePlanSourceDigest(planText: string): string {
  return createHash('sha256').update(planText, 'utf8').digest('hex');
}

/**
 * Build a sequential Campaign from a multi-workstream plan.
 * Throws when the plan has no extractable workstreams or the base loop lacks
 * a verify command (nodes would be rejected by the WS6 authority policy).
 */
export function buildCampaignFromPlan(input: CampaignPlanImportInput): CampaignPlanImportResult {
  const verifyCommand = input.baseLoop.verifyCommand.trim();
  if (!verifyCommand) {
    throw new Error(
      'Campaign import needs a verify command: every workstream node is an '
      + 'implementation loop and must carry a verification authority (WS6).',
    );
  }
  const assessment = assessLoopScope(input.planText);
  if (assessment.workstreams.length === 0) {
    throw new Error(
      'No workstreams could be extracted from the plan (expected headings like '
      + '"## WS1 — Title" or "## Workstream 1 — Title").',
    );
  }

  const sourceDigest = computePlanSourceDigest(input.planText);
  const maxCostCents = input.baseLoop.maxCostCents ?? DEFAULT_LOOP_MAX_COST_CENTS ?? 3_000;
  const maxTurns = input.baseLoop.maxTurnsPerIteration ?? LOOP_DEFAULT_MAX_TURNS_PER_ITERATION;
  // CampaignLoopConfig requires full caps when present — take the shared
  // defaults and override only the per-node estimate cap.
  const defaultCaps = defaultLoopConfig(input.workspaceCwd, 'campaign-node').caps;
  const baseConfig = {
    workspaceCwd: input.workspaceCwd,
    ...(input.baseLoop.provider ? { provider: input.baseLoop.provider } : {}),
    maxTurnsPerIteration: maxTurns,
    caps: { ...defaultCaps, maxCostCents },
  };

  // One node per workstream, document order, stable slug ids (`ws1`, `ws2`…).
  const nodes: CampaignNode[] = assessment.workstreams.map((workstream) => ({
    id: workstream.id.toLowerCase(),
    label: workstream.title ? `${workstream.id} — ${workstream.title}` : workstream.id,
    dependsOn: [],
    loopConfig: {
      ...baseConfig,
      initialPrompt:
        `Read the full plan at ${input.planFile} for context, then implement ONLY `
        + `workstream ${workstream.id}${workstream.title ? ` (${workstream.title})` : ''} `
        + `(plan lines ${workstream.startLine}-${workstream.endLine}) and its acceptance `
        + `checks. Update only that workstream's checklist items in the plan. Run the `
        + `workstream's verification commands. STOP when ${workstream.id} is complete — `
        + `do not begin the next workstream; a separate campaign node owns it.`,
      completion: {
        verifyCommand,
        // Workstream nodes never rename the plan — only the final gate may.
        requireCompletedFileRename: false,
      },
    },
  }));

  // Final integration gate: canonical verification, completeness check,
  // livetest split, and the ONLY plan rename authority.
  nodes.push({
    id: INTEGRATION_GATE_NODE_ID,
    label: 'Integration gate — verify, livetest split, plan completion',
    dependsOn: [],
    loopConfig: {
      ...baseConfig,
      planFile: input.planFile,
      initialPrompt:
        `All workstreams of ${input.planFile} were implemented by earlier campaign nodes. `
        + `Run the repository's canonical verification checklist (typechecks, lint, LOC gate, `
        + `full test suite) and fix what it surfaces. Confirm EVERY workstream checklist item `
        + `in the plan is resolved (checked or explicitly deferred with a reason). Move any `
        + `check that genuinely requires a rebuilt/restarted app, a human, or an external `
        + `service into a companion _livetest.md file per the repo's Live-Test Deferral rules. `
        + `Only then rename the plan to _completed.md — this node is the only one allowed to.`,
      completion: {
        verifyCommand,
        requireCompletedFileRename: true,
      },
    },
  });

  // Strict sequential chain, gated on upstream `completed`.
  const edges: CampaignEdge[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    nodes[i + 1].dependsOn = [nodes[i].id];
    edges.push({ from: nodes[i].id, to: nodes[i + 1].id, when: { type: 'is', status: 'completed' } });
  }

  const spec: CampaignSpec = {
    id: `plan-${sourceDigest.slice(0, 8)}-${input.now}`,
    title: `Plan campaign: ${input.planFile}`,
    nodes,
    edges,
    policy: {
      onNodeNeedsReview: 'pause-campaign',
      maxParallel: 1,
      // No isolation: nodes intentionally share the same checkout sequentially.
    },
    createdAt: input.now,
    sourceRef: input.planFile,
    sourceDigest,
  };

  return {
    spec,
    sourceDigest,
    aggregateMaxCostCents: nodes.length * maxCostCents,
    assessment,
  };
}
