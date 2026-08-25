import type { AuxiliaryLlmSlot } from '../../../../shared/types/auxiliary-llm.types';
import type {
  LocalAiFallbackPolicy,
  LocalAiTargetConfig,
} from '../../../../shared/types/local-ai-guard.types';

export interface LocalAiTargetSetupForm {
  expectedModels: string[];
  expectedModelRules: LocalAiTargetConfig['expectedModels'];
  canaryModel: string;
  endpointIntervalSeconds: number;
  canaryIntervalMinutes: number;
  canaryTimeoutSeconds: number;
  freshnessSeconds: number;
  warningLatencyMs: number;
  routingRoles: AuxiliaryLlmSlot[];
  fallbackPolicy: LocalAiFallbackPolicy;
  slotFallbackPolicies: LocalAiTargetConfig['slotFallbackPolicies'];
  confirmAboveInputTokens?: number;
  dailyFallbackBudgetUsd?: number;
  incidentFallbackBudgetUsd?: number;
  automaticRepair: boolean;
  maxAttempts: number;
  cooldownMinutes: number;
}

export interface LocalAiRoleOption {
  value: AuxiliaryLlmSlot;
  label: string;
}

export const LOCAL_AI_ROLE_OPTIONS: readonly LocalAiRoleOption[] = [
  { value: 'compression', label: 'Compression' },
  { value: 'memoryDistillation', label: 'Memory distillation' },
  { value: 'webExtract', label: 'Web extraction' },
  { value: 'titleGeneration', label: 'Title generation' },
  { value: 'routingClassification', label: 'Routing classification' },
  { value: 'approvalScoring', label: 'Approval scoring' },
  { value: 'approvalAdjudication', label: 'Approval adjudication' },
  { value: 'loopScoring', label: 'Loop scoring' },
  { value: 'retrievalHypothesis', label: 'Retrieval hypothesis' },
  { value: 'branchScoring', label: 'Branch scoring' },
  { value: 'subQueryExecution', label: 'Sub-query execution' },
  { value: 'verifyOutputSummary', label: 'Output verification' },
];

export const DEFAULT_LOCAL_AI_TARGET_SETUP_FORM: LocalAiTargetSetupForm = {
  expectedModels: [],
  expectedModelRules: [],
  canaryModel: '',
  endpointIntervalSeconds: 60,
  canaryIntervalMinutes: 10,
  canaryTimeoutSeconds: 120,
  freshnessSeconds: 120,
  warningLatencyMs: 60_000,
  routingRoles: LOCAL_AI_ROLE_OPTIONS.map((option) => option.value),
  fallbackPolicy: 'notify-and-allow',
  slotFallbackPolicies: {},
  automaticRepair: false,
  maxAttempts: 2,
  cooldownMinutes: 5,
};
