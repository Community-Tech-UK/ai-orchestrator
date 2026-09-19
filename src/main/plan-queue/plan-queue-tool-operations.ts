/**
 * Maps the Plan Queue MCP tools onto the coordinator. Caller identity is the
 * RPC-authenticated instance id, never a tool argument.
 */

import type { PlanQueueControlPayload, PlanQueueItemDto, PlanQueueRunDto } from '@contracts/schemas/plan-queue';
import type { PlanQueueToolOperations } from '../mcp/plan-queue-tools';
import type { PlanQueueCoordinator } from './plan-queue-coordinator';

function itemSummary(item: PlanQueueItemDto) {
  return {
    itemId: item.id,
    document: item.documentPath,
    state: item.state,
    round: item.round,
    ...(item.question ? { question: item.question } : {}),
    ...(item.parkReason ? { parkReason: item.parkReason } : {}),
    ...(item.branchName ? { branch: item.branchName } : {}),
    ...(item.detail ? { detail: item.detail } : {}),
    ...(item.verdict ? { verdict: item.verdict.verdict, findings: item.verdict.findings } : {}),
  };
}

function runSummary(run: PlanQueueRunDto) {
  return {
    runId: run.id,
    kind: run.kind,
    status: run.status,
    workspace: run.workspaceCwd,
    baseBranch: run.config.baseBranch,
    relaxedSettings: run.relaxedSettings,
    items: run.items.map(itemSummary),
  };
}

function toControlPayload(args: { action: PlanQueueControlPayload['action']; run_id?: string; item_id?: string }): PlanQueueControlPayload {
  switch (args.action) {
    case 'pause':
    case 'resume':
    case 'cancel':
      if (!args.run_id) throw new Error(`${args.action} needs run_id`);
      return { action: args.action, runId: args.run_id };
    default:
      if (!args.item_id) throw new Error(`${args.action} needs item_id`);
      return { action: args.action, itemId: args.item_id };
  }
}

export function createPlanQueueToolOperations(coordinator: () => PlanQueueCoordinator): PlanQueueToolOperations {
  return {
    async start(callerInstanceId, args) {
      const { run, excluded } = await coordinator().startRun({
        parentInstanceId: callerInstanceId,
        kind: args.kind,
        glob: args.glob,
        config: {
          ...(args.worker_slots ? { workerSlots: args.worker_slots } : {}),
          ...(args.verification_slots ? { verificationSlots: args.verification_slots } : {}),
          ...(args.max_rounds ? { maxRounds: args.max_rounds } : {}),
          ...(args.relax_settings !== undefined ? { relaxSettings: args.relax_settings } : {}),
          ...(args.verifier_gates ? { verifierGates: args.verifier_gates } : {}),
          ...(args.post_merge_gate ? { postMergeGate: args.post_merge_gate } : {}),
        },
      });
      return {
        ...runSummary(run),
        excluded,
        message: run.items.length === 0
          ? 'No matching documents were found.'
          : 'The run has started. Workers appear nested under this session. Documents that need James will arrive as a message with questions to ask him; a summary arrives when the run ends. Use plan_queue_status to check progress.',
      };
    },
    status(_callerInstanceId, runId) {
      if (runId) {
        const run = coordinator().getRunDto(runId);
        if (!run) throw new Error(`Plan queue run not found: ${runId}`);
        return runSummary(run);
      }
      return { runs: coordinator().listRunDtos(10).map(runSummary), alerts: coordinator().getAlerts() };
    },
    async answer(callerInstanceId, itemId, optionId) {
      await coordinator().answer(itemId, optionId, callerInstanceId);
      return { recorded: true };
    },
    async control(callerInstanceId, args) {
      await coordinator().control(toControlPayload(args), callerInstanceId);
      return { done: true };
    },
    reportVerdict: (callerInstanceId, args) => coordinator().reportVerdict(callerInstanceId, args),
    reportTriage: (callerInstanceId, args) => coordinator().reportTriage(callerInstanceId, args),
    isQueueInstance: (instanceId) => coordinator().isInitialized() && coordinator().isQueueInstance(instanceId),
  };
}
