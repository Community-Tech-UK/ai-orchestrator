/**
 * Mobile Gateway types exposed from the desktop source tree.
 *
 * Phone-facing wire DTOs live in the dependency-free contracts module. Host
 * persistence and settings types remain here because they are not part of the
 * phone contract.
 */

export type {
  MobileApnsTokenRequest,
  MobileAttachmentDto,
  MobileAttentionLevel,
  MobileAutomationDto,
  MobileAutomationRunRequest,
  MobileAutomationRunResponse,
  MobileAutomationScheduleDto,
  MobileBrowserActionClass,
  MobileBrowserApprovalRespondRequest,
  MobileBrowserApprovalRespondResponse,
  MobileCancelledInputDto,
  MobileClientEvent,
  MobileCreateInstanceRequest,
  MobileDocReviewDecisionRequest,
  MobileDocReviewDecisionResponse,
  MobileDocReviewDetailDto,
  MobileDocReviewItemDecisionDto,
  MobileDocReviewItemDto,
  MobileDocReviewOptionDto,
  MobileDocReviewStatus,
  MobileDocReviewSummaryDto,
  MobileHistoryContinueResponse,
  MobileHistorySessionDto,
  MobileInputRequest,
  MobileInputResponse,
  MobileSteerRequest,
  MobileSteerResponse,
  MobileInstanceDto,
  MobileLoopControlResponse,
  MobileLoopDetailDto,
  MobileLoopIterationDto,
  MobileLoopOutstandingItemDto,
  MobileLoopRunDto,
  MobileLoopStage,
  MobileLoopStatus,
  MobileLoopVerdict,
  MobileMessageDto,
  MobileMessagesResumeDto,
  MobileModelCatalog,
  MobileModelDto,
  MobilePairRequest,
  MobilePairResponse,
  MobilePauseDto,
  MobilePlanQueueAnswerRequest,
  MobilePlanQueueControlRequest,
  MobilePlanQueueDiffstatDto,
  MobilePlanQueueItemDto,
  MobilePlanQueueItemState,
  MobilePlanQueueOptionDto,
  MobilePlanQueueQuestionDto,
  MobilePlanQueueRunDto,
  MobilePlanQueueRunStatus,
  MobileQuotaStateDto,
  MobileQuotaAccountDto,
  MobileQuotaProviderDto,
  MobileQuotaWindowDto,
  MobileProjectDto,
  MobilePromptDto,
  MobilePromptOptionDto,
  MobileQueuedMessageDto,
  MobileReasoningEffort,
  MobileRecentDirDto,
  MobileRenameRequest,
  MobileRespondRequest,
  MobileServerEvent,
  MobileSessionPlan,
  MobileSnapshot,
  MobileUserActionRequestType,
  MobileWakeResponse,
} from '@contracts/types/mobile-gateway';

export {
  MOBILE_LOOP_STATUSES,
  MOBILE_PLAN_QUEUE_ITEM_STATES,
  MOBILE_PLAN_QUEUE_RUN_STATUSES,
} from '@contracts/types/mobile-gateway';

/**
 * The person who owns this Mac. Their phone gets all of Harness except other
 * people's sessions. Phones paired before profiles existed carry no profile id
 * and belong to them.
 */
export const MOBILE_OWNER_PROFILE_ID = 'owner';

/** Another person who uses the phone app with only their own sessions. */
export interface MobileMemberProfile {
  profileId: string;
  name: string;
  createdAt: number;
}

/** A paired phone, as persisted by the gateway. The bearer `token` is secret. */
export interface MobileDevice {
  deviceId: string;
  /** Absent on phones paired before profiles existed, which means the owner. */
  profileId?: string;
  label: string;
  token: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  tokenTtlMs?: number;
  apnsToken?: string;
}

/** Device view safe to surface in the desktop UI (no bearer token). */
export interface MobileDeviceSummary {
  deviceId: string;
  profileId: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  hasApnsToken: boolean;
}

/** One-time credential encoded into the pairing QR. */
export interface MobilePairingCredential {
  pairingToken: string;
  /** Whose phone the pairing creates. */
  profileId: string;
  createdAt: number;
  expiresAt: number;
}

/** Status of the gateway, surfaced to the desktop Settings mobile tab. */
export interface MobileGatewayStatus {
  running: boolean;
  host?: string;
  port?: number;
  tailscaleIp: string | null;
  secure?: boolean;
  tlsHostname?: string | null;
  tailnetUrl?: string;
  startedAt?: number;
  connectedClientCount: number;
  pairedDeviceCount: number;
  pushConfigured: boolean;
}

/** APNs credentials used by the desktop gateway's direct push sender. */
export interface MobileApnsConfig {
  keyP8: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  production: boolean;
}
