/**
 * Maps the Plan Queue MCP tools onto the coordinator. Caller identity is the
 * RPC-authenticated instance id, never a tool argument.
 */

import { DEFAULT_PLAN_QUEUE_ACCOUNT_RULES, type PlanQueueControlArgs, type PlanQueueControlPayload, type PlanQueueItemDto, type PlanQueueRunDto } from '@contracts/schemas/plan-queue';
import type { PlanQueueToolOperations } from '../mcp/plan-queue-tools';
import { getSettingsManager } from '../core/config/settings-manager';
import type { PlanQueueCoordinator } from './plan-queue-coordinator';
import { describeAccountRules, copilotLabel, poolLabel } from './plan-queue-account-rules';
import { describeRouting, routeChoiceFromArgs } from './plan-queue-routing';

/** James's account rules as one line, labelled by account name; null when none are set. */
function accountRulesLine(): string | null {
  const settings = getSettingsManager().getAll();
  return describeAccountRules(settings.planQueueAccountRules ?? DEFAULT_PLAN_QUEUE_ACCOUNT_RULES, (ref) => (ref.provider === 'copilot'
    ? copilotLabel(settings.copilotAccountProfiles ?? [], ref.accountId)
    : poolLabel(settings.providerAccountProfiles ?? [], ref.provider, ref.accountId)));
}

/** "workers, checkers and the step-up worker". */
function setAsideRoles(roles: readonly ('workers' | 'checkers' | 'step-up')[]): string {
  const names = roles.map((role) => (role === 'step-up' ? 'the step-up worker' : role));
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join('');
}

function itemSummary(item: PlanQueueItemDto) {
  return {
    itemId: item.id,
    document: item.documentPath,
    state: item.state,
    round: item.round,
    ...(item.question ? { question: item.question } : {}),
    ...(item.parkReason ? { parkReason: item.parkReason } : {}),
    ...(item.branchName ? { branch: item.branchName } : {}),
    ...(item.steppedUpAt ? { handedToStepUpAt: new Date(item.steppedUpAt).toISOString() } : {}),
    ...(item.detail ? { detail: item.detail } : {}),
    ...(item.verdict ? { verdict: item.verdict.verdict, findings: item.verdict.findings } : {}),
  };
}

function runSummary(run: PlanQueueRunDto) {
  const accountRules = accountRulesLine();
  return {
    runId: run.id,
    parentInstanceId: run.parentInstanceId,
    kind: run.kind,
    status: run.status,
    workspace: run.workspaceCwd,
    baseBranch: run.config.baseBranch,
    ...(run.config.routing ? { routing: describeRouting(run.config.routing) } : {}),
    ...(accountRules ? { accountRules } : {}),
    relaxedSettings: run.relaxedSettings,
    items: run.items.map(itemSummary),
  };
}

function toControlPayload(args: PlanQueueControlArgs): PlanQueueControlPayload {
  switch (args.action) {
    case 'handover':
      return { action: 'handover', runId: args.run_id, targetInstanceId: args.target_instance_id };
    case 'set-routing':
      return { action: 'set-routing', runId: args.run_id, routing: {
        workers: args.routing.workers.map(routeChoiceFromArgs),
        verifiers: args.routing.verifiers.map(routeChoiceFromArgs),
        ...(args.routing.step_up ? { stepUp: routeChoiceFromArgs(args.routing.step_up) } : {}),
      }, ...(args.move_in_progress !== undefined ? { moveInProgress: args.move_in_progress } : {}) };
    case 'pause':
    case 'resume':
    case 'cancel':
    case 'adopt':
    case 'request-handover':
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
      const { run, excluded, routingSetAside, accountNotes } = await coordinator().startRun({
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
        routing: {
          ...(args.workers ? { workers: args.workers.map(routeChoiceFromArgs) } : {}),
          ...(args.verifiers ? { verifiers: args.verifiers.map(routeChoiceFromArgs) } : {}),
          ...(args.step_up ? { stepUp: routeChoiceFromArgs(args.step_up) } : {}),
        },
      });
      return {
        ...runSummary(run),
        excluded,
        message: (run.items.length === 0
          ? 'No matching documents were found.'
          : 'The run has started. Workers appear nested under this session. Documents that need James will arrive as a message with questions to ask him; a summary arrives when the run ends. Use plan_queue_status to check progress.')
          + (excluded.length ? ' Some documents belong to another active run. If its session no longer exists, adopt that run instead of starting again.' : '')
          + (routingSetAside.length ? ` James's saved Plan Queue choice for ${setAsideRoles(routingSetAside)} was used instead of the one you passed.` : '')
          + accountNotes.map((note) => ` ${note}`).join(''),
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
