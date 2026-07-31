import { z } from 'zod';
import {
  LocalAiDiscoveredEndpointsSchema,
  LocalAiProbeResultsSchema,
  LocalAiTargetCreateRequestSchema,
  LocalAiTargetSchema,
} from '../../shared/validation/local-ai-guard.schemas';
import type { LocalAiTargetConfig } from '../../shared/types/local-ai-guard.types';

export const LOCAL_AI_CLI_METHODS = {
  list: 'orchestrator_tools.local_ai.list',
  discover: 'orchestrator_tools.local_ai.discover',
  validate: 'orchestrator_tools.local_ai.validate',
  enrol: 'orchestrator_tools.local_ai.enrol',
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
}
