import { getLogger } from '../../logging/logger';
import { getInstanceCreateIdempotencyCache } from '../../ipc/handlers/instance-create-idempotency';
import type { Instance, InstanceCreateConfig, OutputMessage } from '../../../shared/types/instance.types';
import { isOccupancyPressureReading } from '../../../shared/utils/context-occupancy';
import { buildPlanSeed } from './build-plan-seed';
import { extractPlanText } from './extract-plan-text';

const logger = getLogger('PlanBuildHandoff');

export interface PlanBuildPreview {
  planText: string;
  truncated: boolean;
  source: 'plan-mode' | 'assistant';
  /**
   * The planning session's real context occupancy, or `null` when it is not
   * known. Providers that publish a running spend total in `used` (aggregate)
   * and sessions that never reported occupancy have no honest number, so the
   * dialog omits it rather than show 0 or cumulative spend.
   */
  planningContextTokens: number | null;
  planTokensEstimate: number;
  provider: string;
  model: string | undefined;
  reasoningEffort: Instance['reasoningEffort'] | null;
  canStart: boolean;
  reason?: string;
}

export interface PlanBuildStartInput {
  sourceId: string;
  requestId?: string;
  planText?: string;
  model?: string;
  idempotencyKey?: string;
}

export interface PlanBuildStartResult {
  ok: boolean;
  newInstanceId?: string;
  reason?: string;
}

export interface PlanBuildHandoffDeps {
  getInstance(instanceId: string): Instance | undefined;
  createInstance(config: InstanceCreateConfig): Promise<Instance>;
  dismissUserAction?(requestId: string): void;
  approvePlan?(instanceId: string, planText: string): Promise<Instance | void> | Instance | void;
  emitSystemNotice(instance: Instance, content: string): void;
}

export class PlanBuildHandoff {
  constructor(private readonly deps: PlanBuildHandoffDeps) {}

  preview(sourceId: string): PlanBuildPreview {
    const source = this.deps.getInstance(sourceId);
    if (!source) {
      return {
        planText: '', truncated: false, source: 'assistant', planningContextTokens: null,
        planTokensEstimate: 0, provider: 'claude', model: undefined, reasoningEffort: null, canStart: false,
        reason: 'This session no longer exists.',
      };
    }
    const isPlanSession = source.agentId === 'plan' || source.planMode?.enabled === true;
    const extracted = extractPlanText({
      messages: source.outputBuffer,
      planModeContent: source.planMode?.planContent,
    });
    const planText = extracted.text;
    return {
      planText,
      truncated: extracted.truncated,
      source: extracted.source,
      planningContextTokens: isOccupancyPressureReading(source.contextUsage) ? source.contextUsage.used : null,
      planTokensEstimate: Math.ceil(planText.length / 4),
      provider: source.provider,
      model: source.currentModel,
      reasoningEffort: source.reasoningEffort ?? null,
      canStart: isPlanSession && planText.trim().length > 0,
      reason: !isPlanSession
        ? 'This session is not a planning session.'
        : planText.trim().length === 0
          ? 'There is no plan text to carry over yet.'
          : undefined,
    };
  }

  async start(input: PlanBuildStartInput): Promise<PlanBuildStartResult> {
    const source = this.deps.getInstance(input.sourceId);
    if (!source) return { ok: false, reason: 'This session no longer exists.' };
    if (source.agentId !== 'plan' && source.planMode?.enabled !== true) {
      return { ok: false, reason: 'This session is not a planning session.' };
    }
    if (input.planText !== undefined && input.planText.length > 60_000) {
      return { ok: false, reason: 'The plan is over 60,000 characters.' };
    }
    const preview = this.preview(input.sourceId);
    const planText = input.planText?.trim() ?? preview.planText;
    if (!planText.trim()) return { ok: false, reason: 'There is no plan text to carry over.' };

    const run = async (): Promise<PlanBuildStartResult> => {
      const title = planText.split('\n')[0].trim().slice(0, 60) || 'this plan';
      const seed = buildPlanSeed({ planText, sessionName: source.displayName });
      // A local model can carry a CLI provider alias. Preserve its actual
      // runtime for Same as planning; a different model is an explicit CLI pick.
      const localTarget = source.modelRuntimeTarget?.kind === 'local-model' ? source.modelRuntimeTarget : undefined;
      const keepLocalRuntime = localTarget && (input.model === undefined || input.model === localTarget.modelId);
      const created = await this.deps.createInstance({
        workingDirectory: source.workingDirectory,
        agentId: 'build',
        provider: source.provider,
        modelOverride: input.model ?? source.currentModel,
        ...(keepLocalRuntime ? { modelRuntimeTarget: localTarget } : {}),
        reasoningEffort: source.reasoningEffort ?? null,
        yoloMode: source.yoloMode,
        accountProfileId: source.accountProfileId,
        copilotAccountProfileId: source.copilotAccountProfileId,
        ...(source.executionLocation?.type === 'remote'
          ? { forceNodeId: source.executionLocation.nodeId, nodePlacement: source.nodePlacement }
          : {}),
        displayName: `Build: ${title}`,
        isRenamed: true,
        parentId: null,
        initialPrompt: seed,
        initialUserMessageSource: 'current-submission',
        initialOutputBuffer: [createUserMessage(seed)],
        metadata: {
          plannedFrom: {
            instanceId: source.id,
            historyThreadId: source.historyThreadId,
            displayName: source.displayName,
          },
        },
      });
      if (input.requestId) {
        try {
          this.deps.dismissUserAction?.(input.requestId);
        } catch (error) {
          logger.warn('Could not dismiss the planning request', {
            requestId: input.requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (source.planMode?.enabled && source.planMode.state === 'planning') {
        try {
          await this.deps.approvePlan?.(source.id, planText);
        } catch (error) {
          logger.warn('Could not approve plan mode after handoff', {
            sourceId: source.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.deps.emitSystemNotice(
        source,
        `Plan taken to a new session 'Build: ${title}'. This session stays open for more planning.`,
      );
      return { ok: true, newInstanceId: created.id };
    };

    if (!input.idempotencyKey) return run();
    const response = await getInstanceCreateIdempotencyCache().run(
      `plan-handoff:${input.idempotencyKey}`,
      async () => ({ success: true, data: await run() }),
    );
    return response.data as PlanBuildStartResult;
  }
}

function createUserMessage(content: string): OutputMessage {
  return { id: `plan-seed-${Date.now()}`, timestamp: Date.now(), type: 'user', content } as OutputMessage;
}
