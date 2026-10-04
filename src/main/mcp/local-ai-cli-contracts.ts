import { z } from 'zod';
import {
  LocalAiDiscoveredEndpointsSchema,
  LocalAiIncidentAcknowledgeRequestSchema,
  LocalAiIncidentSchema,
  LocalAiProbeResultsSchema,
  LocalAiPublicEffectivenessSummarySchema,
  LocalAiRecheckRequestSchema,
  LocalAiSummaryRequestSchema,
  LocalAiTargetCreateRequestSchema,
  LocalAiTargetLifecycleRequestSchema,
  LocalAiTargetSchema,
  LocalAiTargetUpdateRequestSchema,
} from '../../shared/validation/local-ai-guard.schemas';
import type {
  LocalAiTargetConfig,
  LocalAiTargetLifecycle,
  LocalAiTargetPatch,
} from '../../shared/types/local-ai-guard.types';
import {
  LocalAiCliStatusSchema,
  LocalAiCliTargetStatusSchema,
} from '../local-ai-guard/local-ai-management-operations';

export const LOCAL_AI_CLI_METHODS = {
  list: 'orchestrator_tools.local_ai.list',
  discover: 'orchestrator_tools.local_ai.discover',
  validate: 'orchestrator_tools.local_ai.validate',
  enrol: 'orchestrator_tools.local_ai.enrol',
  setLifecycle: 'orchestrator_tools.local_ai.set_lifecycle',
  status: 'orchestrator_tools.local_ai.status',
  recheck: 'orchestrator_tools.local_ai.recheck',
  rename: 'orchestrator_tools.local_ai.rename',
  update: 'orchestrator_tools.local_ai.update',
  summary: 'orchestrator_tools.local_ai.summary',
  acknowledge: 'orchestrator_tools.local_ai.acknowledge',
} as const;

export const LocalAiCliEmptyPayloadSchema = z.object({}).strict();
export const LocalAiCliConfigPayloadSchema = LocalAiTargetCreateRequestSchema;
export const LocalAiCliEnrolPayloadSchema =
  LocalAiTargetCreateRequestSchema.superRefine((payload, context) => {
    if (payload.config.lifecycle !== 'enrolled') {
      context.addIssue({
        code: 'custom',
        path: ['config', 'lifecycle'],
        message: 'Local AI enrolment requires the enrolled lifecycle',
      });
    }
  });
export const LocalAiCliSetLifecyclePayloadSchema = LocalAiTargetLifecycleRequestSchema;
export const LocalAiCliSetLifecycleResultSchema = LocalAiTargetSchema;
export const LocalAiCliStatusResultSchema = LocalAiCliStatusSchema;
export const LocalAiCliRecheckPayloadSchema = LocalAiRecheckRequestSchema;
export const LocalAiCliRecheckResultSchema = LocalAiCliTargetStatusSchema;
export const LocalAiCliRenamePayloadSchema = z.object({
  targetId: z.string().trim().min(1).max(256),
  label: z.string().trim().min(1).max(256),
}).strict();
export const LocalAiCliUpdatePayloadSchema = LocalAiTargetUpdateRequestSchema;
export const LocalAiCliTargetResultSchema = LocalAiTargetSchema;
export const LocalAiCliSummaryPayloadSchema = LocalAiSummaryRequestSchema;
export const LocalAiCliSummaryResultSchema = LocalAiPublicEffectivenessSummarySchema;
export const LocalAiCliAcknowledgePayloadSchema = LocalAiIncidentAcknowledgeRequestSchema;
export const LocalAiCliAcknowledgeResultSchema = LocalAiIncidentSchema;
export const LocalAiCliTargetListResultSchema = z.array(LocalAiTargetSchema).max(1_000);
export const LocalAiCliDiscoveryResultSchema = LocalAiDiscoveredEndpointsSchema;
export const LocalAiCliValidationResultSchema = LocalAiProbeResultsSchema;
export const LocalAiCliEnrolResultSchema = z.object({
  target: LocalAiTargetSchema,
  validation: LocalAiProbeResultsSchema,
}).strict();

export interface LocalAiCliOperations {
  list(): unknown | Promise<unknown>;
  discover(): unknown | Promise<unknown>;
  validate(config: LocalAiTargetConfig): unknown | Promise<unknown>;
  create(config: LocalAiTargetConfig): unknown | Promise<unknown>;
  setLifecycle(
    targetId: string,
    lifecycle: Exclude<LocalAiTargetLifecycle, 'unmanaged'>,
    pausedUntil?: number,
  ): unknown | Promise<unknown>;
  status(): unknown | Promise<unknown>;
  recheck(targetId: string, kind: 'lightweight' | 'functional'): unknown | Promise<unknown>;
  rename(targetId: string, label: string): unknown | Promise<unknown>;
  update(targetId: string, patch: LocalAiTargetPatch): unknown | Promise<unknown>;
  summary(window: '24h' | '7d' | '30d'): unknown | Promise<unknown>;
  acknowledgeIncident(incidentId: string): unknown | Promise<unknown>;
}
