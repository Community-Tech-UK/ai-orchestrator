/**
 * Maps the Plan Queue MCP tools onto the coordinator. Caller identity is the
 * RPC-authenticated instance id, never a tool argument.
 */

import { DEFAULT_PLAN_QUEUE_ACCOUNT_RULES, type PlanQueueControlArgs, type PlanQueueControlPayload, type PlanQueueItemDto, type PlanQueueRunDto } from '@contracts/schemas/plan-queue';
import type { PlanQueueToolOperations } from '../mcp/plan-queue-tools';
import { getSettingsManager } from '../core/config/settings-manager';
import { getLogger } from '../logging/logger';
import type { PlanQueueCoordinator } from './plan-queue-coordinator';
import { describeAccountRules, copilotLabel, poolLabel } from './plan-queue-account-rules';
import { describeRouting, routeChoiceFromArgs } from './plan-queue-routing';
import { recordWorkerReport } from './plan-queue-worker-report';
import { describeRunEvidence, PLAN_QUEUE_EVIDENCE_EVENT_LIMIT } from './plan-queue-run-evidence';
import { describeQueueHealth } from '../../shared/utils/plan-queue-health-lines';
import { planQueueRunCanMove } from '../../shared/utils/plan-queue-run-movable';

const logger = getLogger('PlanQueueToolOperations');

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
    ...(item.discardedAt ? { discardedAt: item.discardedAt } : {}),
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
      const { run, excluded, routingSetAside, accountNotes, checklistSetAside } = await coordinator().startRun({
        parentInstanceId: callerInstanceId,
        kind: args.kind,
        glob: args.glob,
        config: {
          ...(args.worker_slots ? { workerSlots: args.worker_slots } : {}),
          ...(args.verification_slots ? { verificationSlots: args.verification_slots } : {}),
          ...(args.check_batch_size !== undefined ? { checkBatchSize: args.check_batch_size } : {}),
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
          : 'The run has started. Workers appear nested under this session. ' + (getSettingsManager().get('planQueueQuestionsDestination') === 'parent-chat'
            ? 'Documents that need James will arrive as a message with questions to ask him'
            : 'Documents that need James wait on the Plan Queue page for him to answer; plan_queue_status lists them')
            + '; a summary arrives when the run ends. Use plan_queue_status to check progress.')
          + (excluded.length ? ' Some documents belong to another active run. If its session no longer exists, adopt that run instead of starting again.' : '')
          + (routingSetAside.length ? ` James's saved Plan Queue choice for ${setAsideRoles(routingSetAside)} was used instead of the one you passed.` : '')
          + (checklistSetAside ? ' James\'s saved checklist for this folder was used instead of the verifier_gates and post_merge_gate you passed.' : '')
          + accountNotes.map((note) => ` ${note}`).join(''),
      };
    },
    status(_callerInstanceId, runId, evidence) {
      if (evidence && !runId) throw new Error('evidence needs run_id');
      if (runId) {
        const run = coordinator().getRunDto(runId);
        if (!run) throw new Error(`Plan queue run not found: ${runId}`);
        if (!evidence) return runSummary(run);
        const events = coordinator().listRunEvents(runId, PLAN_QUEUE_EVIDENCE_EVENT_LIMIT + 1);
        return { ...runSummary(run), evidence: describeRunEvidence(run, events, Date.now()) };
      }
      // Nine short lines for the whole queue, in the same words as the Plan Queue page; not repeated per run.
      const health = describeQueueHealth(coordinator().getQueueHealth());
      return { runs: coordinator().listRunDtos(10).map(runSummary), alerts: coordinator().getAlerts(),
        queueHealth: { heading: health.heading, ...(health.notice ? { notice: health.notice } : {}),
          ...Object.fromEntries(health.lines.map(line => [line.label, line.value])) } };
    },
    async answer(callerInstanceId, itemId, optionId) {
      await coordinator().answer(itemId, optionId, callerInstanceId);
      return { recorded: true };
    },
    async control(callerInstanceId, args) {
      await coordinator().control(toControlPayload(args), callerInstanceId);
      return { done: true };
    },
    // One page update per run, and a job that fails does not stop the rest.
    discardItems: (callerInstanceId, itemIds) => coordinator().quietly(async () => {
      const discarded: string[] = [];
      const leftInPlace: { itemId: string; what: string[] }[] = [];
      const failed: { itemId: string; error: string }[] = [];
      for (const itemId of itemIds) {
        try {
          await coordinator().control({ action: 'discard-item', itemId }, callerInstanceId);
          discarded.push(itemId);
          const { branchName, worktreePath } = coordinator().getItem(itemId);
          const what = [branchName, worktreePath].filter((left) => left !== null);
          if (what.length > 0) leftInPlace.push({ itemId, what });
        } catch (error) {
          failed.push({ itemId, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return { discarded, leftInPlace, failed };
    }),
    setAside: (callerInstanceId, offset) => coordinator().setAsideAgents.review(callerInstanceId, offset),
    clearSetAside: (callerInstanceId) => coordinator().setAsideAgents.clear(callerInstanceId),
    reportVerdict: (callerInstanceId, args) => coordinator().reportVerdict(callerInstanceId, args),
    reportTriage: (callerInstanceId, args) => coordinator().reportTriage(callerInstanceId, args),
    reportReady: (callerInstanceId, args) => recordWorkerReport(coordinator(), callerInstanceId, args),
    async moveRun(callerInstanceId, runId, targetInstanceId) {
      const queue = coordinator();
      // Neither may own a run (see startRun and requireSession), so neither may take or give one.
      if (queue.isQueueInstance(callerInstanceId) || queue.setAsideAgents.folderOf(callerInstanceId) !== undefined) {
        throw new Error('Plan Queue workers, checkers, triage and Set aside agents cannot move a run.');
      }
      const run = queue.getRunDto(runId);
      if (!run) throw new Error(`Plan queue run not found: ${runId}`);
      if (!planQueueRunCanMove(run)) throw new Error(`Plan Queue run ${runId} has finished and holds no set-aside work; there is nothing to move.`);
      // No caller: the move carries James's authority, like the panel. The MCP handover stays owner-only.
      await queue.control({ action: 'handover', runId, targetInstanceId }, undefined);
      logger.info('Plan queue run moved through aio-mcp', { runId, requestedBy: callerInstanceId, ownerInstanceId: targetInstanceId });
      return { ownerInstanceId: targetInstanceId };
    },
    isQueueInstance: (instanceId) => coordinator().isInitialized() && coordinator().isQueueInstance(instanceId),
  };
}
