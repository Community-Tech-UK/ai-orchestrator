/**
 * Phone model entry point. Wire DTOs are re-exported from the dependency-free
 * contracts module; phone-only persisted/view types remain local.
 */

import type { MobileReasoningEffort as ContractReasoningEffort } from '@contracts/types/mobile-gateway';

export type {
  MobileAttachmentDto,
  MobileAttentionLevel,
  MobileAutomationDto,
  MobileAutomationRunRequest,
  MobileAutomationRunResponse,
  MobileAutomationScheduleDto,
  MobileCancelledInputDto,
  MobileClientEvent,
  MobileCreateInstanceRequest,
  MobileHistorySessionDto,
  MobileInputRequest,
  MobileInputResponse,
  MobileSteerRequest,
  MobileSteerResponse,
  MobileInstanceDto,
  MobileMessageDto,
  MobileMessagesResumeDto,
  MobileModelCatalog,
  MobileModelDto,
  MobilePairRequest,
  MobilePairResponse,
  MobilePauseDto,
  MobileQuotaStateDto,
  MobileQuotaProviderDto,
  MobileQuotaWindowDto,
  MobileProjectDto,
  MobilePromptDto,
  MobilePromptOptionDto,
  MobileQueuedMessageDto,
  MobileReasoningEffort,
  MobileRecentDirDto,
  MobileRespondRequest,
  MobileServerEvent,
  MobileSessionPlan,
  MobileSnapshot,
  MobileUserActionRequestType,
} from '@contracts/types/mobile-gateway';

export interface MobileReasoningOption {
  id: 'default' | ContractReasoningEffort;
  label: string;
  description: string;
  isDefault?: boolean;
}

/** A paired host as stored on the phone. */
export interface PairedHost {
  id: string;
  name: string;
  host: string;
  port: number;
  token: string;
  secure?: boolean;
  addedAt: number;
}

/** Connection payload encoded in the desktop pairing QR / connection code. */
export interface PairingPayload {
  v: number;
  host: string;
  port: number;
  pairingToken: string;
  secure?: boolean;
}
