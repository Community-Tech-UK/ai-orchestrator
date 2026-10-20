import type { Instance } from '../../shared/types/instance.types';
import { CLAUDE_MODELS } from '../../shared/types/provider.types';
import { normalizeOpenCodeAdditionalDirectories } from '../../shared/utils/opencode-additional-directories';
import { isProjectRailHiddenSession } from '../../shared/utils/project-rail-hidden-session';
import { hasFreshInitialSubmission } from '../instance/lifecycle/initial-submission-capture';
import { retainedPromptsMissingFrom } from '../instance/prompt-retention';
import { automationProvenanceFromMetadata } from './continuity-automation-provenance';
import { outputMessagesToContinuityEntries } from './continuity-message-projection';
import { normalizeConversationHistory, normalizeStateForContinuity } from './session-continuity-state';
import { normalizeRecoveryNodePlacement } from './session-recovery-node-placement';
import { normalizeRecoveryExecutionLocation } from './session-recovery-execution-location';
import type { ContinuityConfig, SessionState } from './session-continuity.types';

/** Capture explicit new-session provenance; buffer length can only disqualify it. */
export function instanceToContinuityState(instance: Instance, config: Pick<ContinuityConfig, 'persistSessionContent' | 'redactToolOutputs'>): SessionState {
  const persistContent = config.persistSessionContent;
  const automation = automationProvenanceFromMetadata(instance.metadata);

  const state: SessionState = {
    instanceId: instance.id,
    sessionId: instance.sessionId,
    historyThreadId: instance.historyThreadId,
    parentId: instance.parentId ?? null,
    ...(isProjectRailHiddenSession(instance.metadata) ? { hideFromProjectRail: true } : {}),
    ...(automation ? { automation } : {}),
    nativeResumeFailedAt: null,
    displayName: instance.displayName,
    isRenamed: instance.isRenamed,
    agentId: instance.agentId,
    modelId: instance.currentModel || CLAUDE_MODELS.OPUS_1M,
    provider: instance.provider,
    workingDirectory: instance.workingDirectory,
    executionLocation: normalizeRecoveryExecutionLocation(instance.executionLocation),
    nodePlacement: normalizeRecoveryNodePlacement(instance.nodePlacement),
    conversationHistoryOriginKnown: persistContent && instance.provider === 'opencode' && instance.status === 'initializing'
      && instance.providerSessionPersisted === false && (instance.outputBuffer.length === 0 || hasFreshInitialSubmission(instance))
      && !instance.retainedPrompts?.length,
    conversationHistoryComplete: false,
    conversationHistoryTurnStarted: false,
    additionalDirectories: normalizeOpenCodeAdditionalDirectories(instance.additionalDirectories, instance.provider),
    systemPrompt: undefined,
    temperature: undefined,
    maxTokens: undefined,
    conversationHistory: persistContent
      // Prompts a trim already evicted are still part of the conversation.
      // Without them a hibernate/wake round trip loses the original request
      // for good — the live buffer is all this ever captured.
      ? normalizeConversationHistory(outputMessagesToContinuityEntries([
          ...retainedPromptsMissingFrom(instance.retainedPrompts, instance.outputBuffer),
          ...instance.outputBuffer,
        ]), config.redactToolOutputs)
      : [],
    contextUsage: {
      used: instance.contextUsage.used,
      total: instance.contextUsage.total,
      costEstimate: instance.contextUsage.costEstimate,
      // LT-018: carry the "these numbers are real" flag across hibernate/wake.
      occupancyReported: instance.contextUsage.occupancyReported,
      // LT-034: and the "these numbers are spend, not occupancy" flag, or the
      // woken session renders a fabricated window percentage.
      occupancyIsAggregate: instance.contextUsage.occupancyIsAggregate
    },
    pendingTasks: [],
    environmentVariables: {},
    activeFiles: [],
    gitBranch: undefined,
    customInstructions: undefined,
    skillsLoaded: [],
    hooksActive: [],
    // Copied EXPLICITLY, like every other field here. This function is the
    // reason the profile is a first-class field rather than a `metadata`
    // entry: `instance.metadata` is not copied, so a profile stamped there
    // would be silently dropped on hibernate and the woken session could
    // resume under a different GitHub account.
    copilotAccountProfileId: instance.copilotAccountProfileId,
    copilotRoutingSource: instance.copilotRoutingSource,
    copilotRoutingRuleId: instance.copilotRoutingRuleId,
    // Provider account pools: copied explicitly for the same reason.
    accountProfileId: instance.accountProfileId,
    accountRoutingSource: instance.accountRoutingSource,
    accountSwitches: instance.accountSwitches,
    accountRouteOrigin: instance.accountRouteOrigin,
    allowedAccountProfileIds: instance.allowedAccountProfileIds,
  };

  return normalizeStateForContinuity(state, config.redactToolOutputs);
}
