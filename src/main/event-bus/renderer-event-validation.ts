import { IPC_CHANNELS } from '@contracts/channels';
import {
  ChannelErrorEventSchema,
  ChannelResponseEventSchema,
  ChannelStatusEventSchema,
  InboundChannelMessageEventSchema,
} from '../../shared/validation/channel-schemas';
import {
  AutomationChangedEventSchema,
  AutomationRunChangedEventSchema,
} from '@contracts/schemas/automation';
import { CampaignStateChangedEventSchema } from '@contracts/schemas/campaign';
import { DocReviewChangedEventSchema } from '@contracts/schemas/doc-review';
import {
  CodebaseAutoStatusChangedEventSchema,
  CodebaseIndexProgressEventSchema,
  CodebaseWatcherChangesEventSchema,
  VcsOperationProgressEventSchema,
  VcsStatusChangedEventSchema,
  WatcherErrorEventSchema,
  WatcherFileChangedEventSchema,
} from '@contracts/schemas/file-operations';
import { ContextEvidenceStateChangedSchema } from '@contracts/schemas/context-evidence';
import {
  ConvoImportCompleteEventSchema,
  KgFactAddedEventSchema,
  KgFactInvalidatedEventSchema,
  WakeContextGeneratedEventSchema,
  WakeHintAddedEventSchema,
} from '@contracts/schemas/knowledge';
import {
  ContextWarningEventSchema,
  CrossModelReviewAllUnavailableEventSchema,
  CrossModelReviewDiscardedEventSchema,
  CrossModelReviewResultEventSchema,
  CrossModelReviewReviewerRateLimitClearedEventSchema,
  CrossModelReviewReviewerRateLimitedEventSchema,
  CrossModelReviewReviewerUnavailableEventSchema,
  CrossModelReviewStartedEventSchema,
  InstanceBatchUpdateEventPayloadSchema,
  InstanceCompactStatusEventSchema,
  InstanceCreatedEventPayloadSchema,
  InstanceDoomLoopEventSchema,
  InstanceFastToggledEventPayloadSchema,
  InstanceInputRequiredEventSchema,
  InstanceQueueInitialPromptPayloadSchema,
  InstanceRemovedEventPayloadSchema,
  InstanceStateUpdateEventPayloadSchema,
  InstanceYoloToggledEventPayloadSchema,
} from '@contracts/schemas/instance';
import {
  LoopActivityEventSchema,
  LoopBranchSelectEventSchema,
  LoopCancelledEventSchema,
  LoopCapReachedEventSchema,
  LoopClaimedDoneButFailedEventSchema,
  LoopCompletedEventSchema,
  LoopCompletedNeedsReviewEventSchema,
  LoopContextCompactedEventSchema,
  LoopErrorEventSchema,
  LoopFailedEventSchema,
  LoopFollowUpDrainedEventSchema,
  LoopFreshEyesReviewBlockedEventSchema,
  LoopFreshEyesReviewFailedEventSchema,
  LoopFreshEyesReviewPassedEventSchema,
  LoopFreshEyesReviewStartedEventSchema,
  LoopInterventionAppliedEventSchema,
  LoopIterationCompleteEventSchema,
  LoopIterationStartedEventSchema,
  LoopLedgerLintEventSchema,
  LoopMoreWorkDeclaredEventSchema,
  LoopNotesCuratedEventSchema,
  LoopOutstandingChangedEventSchema,
  LoopPausedNoProgressEventSchema,
  LoopPlanRegeneratedEventSchema,
  LoopProviderLimitEventSchema,
  LoopStartedEventSchema,
  LoopStateChangedEventSchema,
  LoopSteeringDowngradedEventSchema,
  LoopTerminalIntentRecordedEventSchema,
  LoopTerminalIntentRejectedEventSchema,
} from '@contracts/schemas/loop-events';
import {
  OrchestrationActivityEventSchema,
  ReactionEventSchema,
  UserActionRequestEventSchema,
  VerificationAgentCancelledEventSchema,
  VerificationCancelledEventSchema,
  VerificationStartedEventSchema,
  VerificationWarningEventSchema,
} from '@contracts/schemas/orchestration';
import {
  McpMultiProviderStateChangedEventSchema,
  McpServerStatusChangedEventSchema,
  McpStateChangedEventSchema,
} from '@contracts/schemas/mcp-multi-provider';
import { PauseStateSchema } from '@contracts/schemas/pause';
import {
  ModelsCatalogUpdatedEventSchema,
  ModelsLocalInventoryUpdatedEventSchema,
  PluginErrorEventSchema,
  PluginLifecycleEventSchema,
} from '@contracts/schemas/provider';
import {
  CostBudgetAlertEventSchema,
  CostEntryEventSchema,
  RlmQueryCompleteEventSchema,
  RlmSectionAddedEventSchema,
  RlmSectionRemovedEventSchema,
  RlmStoreUpdatedEventSchema,
  TodoListChangedEventSchema,
} from '@contracts/schemas/session';
import {
  RemoteConfigErrorEventSchema,
  RemoteConfigUpdatedEventSchema,
  SettingsChangedEventSchema,
} from '@contracts/schemas/settings';
import {
  CliUpdatePillStateEventSchema,
  EmptyRendererEventSchema,
  MemoryAlertEventSchema,
  MemoryStatsEventSchema,
  NotificationDeltaEventSchema,
  StartupCapabilityReportEventSchema,
  UpdateStatusEventSchema,
} from '@contracts/schemas/observability';
import { PromptHistoryDeltaPayloadSchema } from '@contracts/schemas/prompt-history';
import {
  ProviderQuotaAlertEventSchema,
  ProviderQuotaPacingAlertEventSchema,
  ProviderQuotaSnapshotEventSchema,
} from '@contracts/schemas/quota';
import { ProviderRuntimeEventEnvelopeSchema } from '@contracts/schemas/provider-runtime-events';
import {
  RemoteFsEventSchema,
  RemoteNodeEventSchema,
  RemoteNodeRosterChangedEventSchema,
  TerminalExitEventSchema,
  TerminalOutputEventSchema,
  TerminalSpawnedEventSchema,
} from '@contracts/schemas/remote-node';
import { RlmMaintenanceProgressEventSchema } from '@contracts/schemas/rlm-maintenance';
import { VoiceLocalSttEventSchema } from '@contracts/schemas/voice';
import {
  VerificationAgentCompleteEventSchema,
  VerificationAgentErrorEventSchema,
  VerificationAgentStartEventSchema,
  VerificationAgentStreamEventSchema,
  VerificationCompleteEventSchema,
  VerificationConsensusUpdateEventSchema,
  VerificationErrorEventSchema,
  VerificationRoundProgressEventSchema,
  VerificationVerdictReadyPayloadSchema,
} from '@contracts/schemas/verification';
import type { ZodType } from 'zod';
import { getLogger } from '../logging/logger';

const logger = getLogger('RendererEventValidation');

const RENDERER_EVENT_SCHEMAS = new Map<string, ZodType>([
  [IPC_CHANNELS.PROVIDER_RUNTIME_EVENT, ProviderRuntimeEventEnvelopeSchema],
  [IPC_CHANNELS.DOC_REVIEW_CHANGED, DocReviewChangedEventSchema],
  [IPC_CHANNELS.VOICE_LOCAL_STT_EVENT, VoiceLocalSttEventSchema],
  [IPC_CHANNELS.REMOTE_NODE_NODES_CHANGED, RemoteNodeRosterChangedEventSchema],
  [IPC_CHANNELS.INSTANCE_CREATED, InstanceCreatedEventPayloadSchema],
  [IPC_CHANNELS.INSTANCE_REMOVED, InstanceRemovedEventPayloadSchema],
  [IPC_CHANNELS.INSTANCE_STATE_UPDATE, InstanceStateUpdateEventPayloadSchema],
  [IPC_CHANNELS.INSTANCE_BATCH_UPDATE, InstanceBatchUpdateEventPayloadSchema],
  [IPC_CHANNELS.INSTANCE_YOLO_TOGGLED, InstanceYoloToggledEventPayloadSchema],
  [IPC_CHANNELS.INSTANCE_FAST_TOGGLED, InstanceFastToggledEventPayloadSchema],
  [IPC_CHANNELS.INSTANCE_QUEUE_INITIAL_PROMPT, InstanceQueueInitialPromptPayloadSchema],
  [IPC_CHANNELS.PROMPT_HISTORY_DELTA, PromptHistoryDeltaPayloadSchema],
  [IPC_CHANNELS.PAUSE_STATE_CHANGED, PauseStateSchema],
  [IPC_CHANNELS.CONTEXT_EVIDENCE_STATE_CHANGED, ContextEvidenceStateChangedSchema],
  [IPC_CHANNELS.VERIFICATION_AGENT_START, VerificationAgentStartEventSchema],
  [IPC_CHANNELS.VERIFICATION_AGENT_STREAM, VerificationAgentStreamEventSchema],
  [IPC_CHANNELS.VERIFICATION_AGENT_COMPLETE, VerificationAgentCompleteEventSchema],
  [IPC_CHANNELS.VERIFICATION_AGENT_ERROR, VerificationAgentErrorEventSchema],
  [IPC_CHANNELS.VERIFICATION_ROUND_PROGRESS, VerificationRoundProgressEventSchema],
  [IPC_CHANNELS.VERIFICATION_CONSENSUS_UPDATE, VerificationConsensusUpdateEventSchema],
  [IPC_CHANNELS.VERIFICATION_COMPLETE, VerificationCompleteEventSchema],
  [IPC_CHANNELS.VERIFICATION_ERROR, VerificationErrorEventSchema],
  [IPC_CHANNELS.VERIFICATION_VERDICT_READY, VerificationVerdictReadyPayloadSchema],
  [IPC_CHANNELS.AUTOMATION_CHANGED, AutomationChangedEventSchema],
  [IPC_CHANNELS.AUTOMATION_RUN_CHANGED, AutomationRunChangedEventSchema],
  [IPC_CHANNELS.MEMORY_STATS_UPDATE, MemoryStatsEventSchema],
  [IPC_CHANNELS.MEMORY_WARNING, MemoryAlertEventSchema],
  [IPC_CHANNELS.MEMORY_CRITICAL, MemoryAlertEventSchema],
  [IPC_CHANNELS.RLM_STORE_UPDATED, RlmStoreUpdatedEventSchema],
  [IPC_CHANNELS.RLM_SECTION_ADDED, RlmSectionAddedEventSchema],
  [IPC_CHANNELS.RLM_SECTION_REMOVED, RlmSectionRemovedEventSchema],
  [IPC_CHANNELS.RLM_QUERY_COMPLETE, RlmQueryCompleteEventSchema],
  [IPC_CHANNELS.TERMINAL_OUTPUT, TerminalOutputEventSchema],
  [IPC_CHANNELS.TERMINAL_EXIT, TerminalExitEventSchema],
  [IPC_CHANNELS.TERMINAL_SPAWNED, TerminalSpawnedEventSchema],
  [IPC_CHANNELS.QUOTA_UPDATED, ProviderQuotaSnapshotEventSchema],
  [IPC_CHANNELS.QUOTA_WARNING, ProviderQuotaAlertEventSchema],
  [IPC_CHANNELS.QUOTA_PACING_WARNING, ProviderQuotaPacingAlertEventSchema],
  [IPC_CHANNELS.QUOTA_EXHAUSTED, ProviderQuotaAlertEventSchema],
  [IPC_CHANNELS.COST_USAGE_RECORDED, CostEntryEventSchema],
  ['cost:budget-warning', CostBudgetAlertEventSchema],
  ['cost:budget-exceeded', CostBudgetAlertEventSchema],
  [IPC_CHANNELS.CODEBASE_INDEX_PROGRESS, CodebaseIndexProgressEventSchema],
  [IPC_CHANNELS.CODEBASE_WATCHER_CHANGES, CodebaseWatcherChangesEventSchema],
  [IPC_CHANNELS.CODEBASE_AUTO_STATUS_CHANGED, CodebaseAutoStatusChangedEventSchema],
  [IPC_CHANNELS.APP_STARTUP_CAPABILITIES, StartupCapabilityReportEventSchema],
  [IPC_CHANNELS.CLI_UPDATE_PILL_DELTA, CliUpdatePillStateEventSchema],
  [IPC_CHANNELS.UPDATE_STATUS_CHANGED, UpdateStatusEventSchema],
  [IPC_CHANNELS.MENU_NEW_INSTANCE, EmptyRendererEventSchema],
  [IPC_CHANNELS.MENU_OPEN_SETTINGS, EmptyRendererEventSchema],
  [IPC_CHANNELS.SETTINGS_CHANGED, SettingsChangedEventSchema],
  [IPC_CHANNELS.TODO_LIST_CHANGED, TodoListChangedEventSchema],
  [IPC_CHANNELS.NOTIFICATION_DELTA, NotificationDeltaEventSchema],
  [IPC_CHANNELS.RLM_STORAGE_MAINTENANCE_PROGRESS, RlmMaintenanceProgressEventSchema],
  [IPC_CHANNELS.WATCHER_FILE_CHANGED, WatcherFileChangedEventSchema],
  [IPC_CHANNELS.WATCHER_ERROR, WatcherErrorEventSchema],
  [IPC_CHANNELS.CONTEXT_WARNING, ContextWarningEventSchema],
  [IPC_CHANNELS.INSTANCE_COMPACT_STATUS, InstanceCompactStatusEventSchema],
  [IPC_CHANNELS.PLUGINS_LOADED, PluginLifecycleEventSchema],
  [IPC_CHANNELS.PLUGINS_UNLOADED, PluginLifecycleEventSchema],
  [IPC_CHANNELS.PLUGINS_ERROR, PluginErrorEventSchema],
  [IPC_CHANNELS.MODELS_CATALOG_UPDATED, ModelsCatalogUpdatedEventSchema],
  [IPC_CHANNELS.MODELS_LOCAL_MODEL_INVENTORY_UPDATED, ModelsLocalInventoryUpdatedEventSchema],
  ['remote-config:updated', RemoteConfigUpdatedEventSchema],
  ['remote-config:error', RemoteConfigErrorEventSchema],
  [IPC_CHANNELS.REMOTE_NODE_EVENT, RemoteNodeEventSchema],
  [IPC_CHANNELS.REMOTE_FS_EVENT, RemoteFsEventSchema],
  [IPC_CHANNELS.CAMPAIGN_STATE_CHANGED, CampaignStateChangedEventSchema],
  [IPC_CHANNELS.CHANNEL_STATUS_CHANGED, ChannelStatusEventSchema],
  [IPC_CHANNELS.CHANNEL_MESSAGE_RECEIVED, InboundChannelMessageEventSchema],
  [IPC_CHANNELS.CHANNEL_RESPONSE_SENT, ChannelResponseEventSchema],
  [IPC_CHANNELS.CHANNEL_ERROR, ChannelErrorEventSchema],
  [IPC_CHANNELS.KG_EVENT_FACT_ADDED, KgFactAddedEventSchema],
  [IPC_CHANNELS.KG_EVENT_FACT_INVALIDATED, KgFactInvalidatedEventSchema],
  [IPC_CHANNELS.CONVO_EVENT_IMPORT_COMPLETE, ConvoImportCompleteEventSchema],
  [IPC_CHANNELS.WAKE_EVENT_HINT_ADDED, WakeHintAddedEventSchema],
  [IPC_CHANNELS.WAKE_EVENT_CONTEXT_GENERATED, WakeContextGeneratedEventSchema],
  [IPC_CHANNELS.LOOP_STARTED, LoopStartedEventSchema],
  [IPC_CHANNELS.LOOP_STATE_CHANGED, LoopStateChangedEventSchema],
  [IPC_CHANNELS.LOOP_ITERATION_STARTED, LoopIterationStartedEventSchema],
  [IPC_CHANNELS.LOOP_ACTIVITY, LoopActivityEventSchema],
  [IPC_CHANNELS.LOOP_ITERATION_COMPLETE, LoopIterationCompleteEventSchema],
  [IPC_CHANNELS.LOOP_PAUSED_NO_PROGRESS, LoopPausedNoProgressEventSchema],
  [IPC_CHANNELS.LOOP_CLAIMED_DONE_BUT_FAILED, LoopClaimedDoneButFailedEventSchema],
  [IPC_CHANNELS.LOOP_TERMINAL_INTENT_RECORDED, LoopTerminalIntentRecordedEventSchema],
  [IPC_CHANNELS.LOOP_TERMINAL_INTENT_REJECTED, LoopTerminalIntentRejectedEventSchema],
  [IPC_CHANNELS.LOOP_FRESH_EYES_REVIEW_STARTED, LoopFreshEyesReviewStartedEventSchema],
  [IPC_CHANNELS.LOOP_FRESH_EYES_REVIEW_PASSED, LoopFreshEyesReviewPassedEventSchema],
  [IPC_CHANNELS.LOOP_FRESH_EYES_REVIEW_FAILED, LoopFreshEyesReviewFailedEventSchema],
  [IPC_CHANNELS.LOOP_FRESH_EYES_REVIEW_BLOCKED, LoopFreshEyesReviewBlockedEventSchema],
  [IPC_CHANNELS.LOOP_INTERVENTION_APPLIED, LoopInterventionAppliedEventSchema],
  [IPC_CHANNELS.LOOP_COMPLETED, LoopCompletedEventSchema],
  [IPC_CHANNELS.LOOP_COMPLETED_NEEDS_REVIEW, LoopCompletedNeedsReviewEventSchema],
  [IPC_CHANNELS.LOOP_NOTES_CURATED, LoopNotesCuratedEventSchema],
  [IPC_CHANNELS.LOOP_CONTEXT_COMPACTED, LoopContextCompactedEventSchema],
  [IPC_CHANNELS.LOOP_BRANCH_SELECT, LoopBranchSelectEventSchema],
  [IPC_CHANNELS.LOOP_PLAN_REGENERATED, LoopPlanRegeneratedEventSchema],
  [IPC_CHANNELS.LOOP_LEDGER_LINT, LoopLedgerLintEventSchema],
  [IPC_CHANNELS.LOOP_STEERING_DOWNGRADED, LoopSteeringDowngradedEventSchema],
  [IPC_CHANNELS.LOOP_FOLLOW_UP_DRAINED, LoopFollowUpDrainedEventSchema],
  [IPC_CHANNELS.LOOP_MORE_WORK_DECLARED, LoopMoreWorkDeclaredEventSchema],
  [IPC_CHANNELS.LOOP_FAILED, LoopFailedEventSchema],
  [IPC_CHANNELS.LOOP_CAP_REACHED, LoopCapReachedEventSchema],
  [IPC_CHANNELS.LOOP_PROVIDER_LIMIT, LoopProviderLimitEventSchema],
  [IPC_CHANNELS.LOOP_CANCELLED, LoopCancelledEventSchema],
  [IPC_CHANNELS.LOOP_ERROR, LoopErrorEventSchema],
  [IPC_CHANNELS.LOOP_OUTSTANDING_CHANGED, LoopOutstandingChangedEventSchema],
  ['verification:started', VerificationStartedEventSchema],
  ['verification:cancelled', VerificationCancelledEventSchema],
  ['verification:agent-cancelled', VerificationAgentCancelledEventSchema],
  ['verification:warning', VerificationWarningEventSchema],
  [IPC_CHANNELS.REACTION_EVENT, ReactionEventSchema],
  [IPC_CHANNELS.REACTION_ESCALATED, ReactionEventSchema],
  [IPC_CHANNELS.ORCHESTRATION_ACTIVITY, OrchestrationActivityEventSchema],
  [IPC_CHANNELS.USER_ACTION_REQUEST, UserActionRequestEventSchema],
  [IPC_CHANNELS.CROSS_MODEL_REVIEW_STARTED, CrossModelReviewStartedEventSchema],
  [IPC_CHANNELS.CROSS_MODEL_REVIEW_RESULT, CrossModelReviewResultEventSchema],
  [IPC_CHANNELS.CROSS_MODEL_REVIEW_DISCARDED, CrossModelReviewDiscardedEventSchema],
  [IPC_CHANNELS.CROSS_MODEL_REVIEW_ALL_UNAVAILABLE, CrossModelReviewAllUnavailableEventSchema],
  [IPC_CHANNELS.CROSS_MODEL_REVIEW_REVIEWER_UNAVAILABLE, CrossModelReviewReviewerUnavailableEventSchema],
  [IPC_CHANNELS.CROSS_MODEL_REVIEW_REVIEWER_RATE_LIMITED, CrossModelReviewReviewerRateLimitedEventSchema],
  [IPC_CHANNELS.CROSS_MODEL_REVIEW_REVIEWER_RATE_LIMIT_CLEARED, CrossModelReviewReviewerRateLimitClearedEventSchema],
  ['instance:doom-loop', InstanceDoomLoopEventSchema],
  [IPC_CHANNELS.INPUT_REQUIRED, InstanceInputRequiredEventSchema],
  [IPC_CHANNELS.MCP_MULTI_PROVIDER_STATE_CHANGED, McpMultiProviderStateChangedEventSchema],
  [IPC_CHANNELS.MCP_SERVER_STATUS_CHANGED, McpServerStatusChangedEventSchema],
  [IPC_CHANNELS.MCP_STATE_CHANGED, McpStateChangedEventSchema],
  [IPC_CHANNELS.VCS_STATUS_CHANGED, VcsStatusChangedEventSchema],
  [IPC_CHANNELS.VCS_OPERATION_PROGRESS, VcsOperationProgressEventSchema],
]);

interface RendererEventSender {
  send(channel: string, ...args: unknown[]): void;
}

export function isRendererEventSchemaRegistered(channel: string): boolean {
  return RENDERER_EVENT_SCHEMAS.has(channel);
}

export function validateRendererEventPayload(channel: string, payload: unknown): boolean {
  const schema = RENDERER_EVENT_SCHEMAS.get(channel);
  if (!schema) {
    return true;
  }

  const result = schema.safeParse(payload);
  if (result.success) {
    return true;
  }

  logger.warn('Blocked invalid renderer event payload', {
    channel,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  });
  return false;
}

export function sendValidatedRendererEvent(
  sender: RendererEventSender,
  channel: string,
  payload: unknown,
): boolean {
  if (!validateRendererEventPayload(channel, payload)) {
    return false;
  }
  sender.send(channel, payload);
  return true;
}
