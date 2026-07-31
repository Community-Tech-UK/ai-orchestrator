import type { LocalAiTargetConfig } from '../../shared/types/local-ai-guard.types';
import {
  LOCAL_AI_CLI_METHODS,
  LocalAiCliConfigPayloadSchema,
  LocalAiCliDiscoveryResultSchema,
  LocalAiCliEmptyPayloadSchema,
  LocalAiCliEnrolPayloadSchema,
  LocalAiCliEnrolResultSchema,
  type LocalAiCliOperations,
  LocalAiCliTargetListResultSchema,
  LocalAiCliValidationResultSchema,
} from './local-ai-cli-contracts';
export type { LocalAiCliOperations } from './local-ai-cli-contracts';

export function isLocalAiCliRpcMethod(
  method: string,
): method is typeof LOCAL_AI_CLI_METHODS[keyof typeof LOCAL_AI_CLI_METHODS] {
  return Object.values(LOCAL_AI_CLI_METHODS).includes(
    method as typeof LOCAL_AI_CLI_METHODS[keyof typeof LOCAL_AI_CLI_METHODS],
  );
}

export async function dispatchLocalAiCliRpc(
  method: typeof LOCAL_AI_CLI_METHODS[keyof typeof LOCAL_AI_CLI_METHODS],
  payload: Record<string, unknown>,
  operations: LocalAiCliOperations | null,
): Promise<unknown> {
  if (!operations) {
    throw new Error('Local AI Guard CLI operations unavailable');
  }
  switch (method) {
    case LOCAL_AI_CLI_METHODS.list:
      LocalAiCliEmptyPayloadSchema.parse(payload);
      return LocalAiCliTargetListResultSchema.parse(await operations.list());
    case LOCAL_AI_CLI_METHODS.discover:
      LocalAiCliEmptyPayloadSchema.parse(payload);
      return LocalAiCliDiscoveryResultSchema.parse(await operations.discover());
    case LOCAL_AI_CLI_METHODS.validate: {
      const { config } = LocalAiCliConfigPayloadSchema.parse(payload);
      return LocalAiCliValidationResultSchema.parse(await operations.validate(config));
    }
    case LOCAL_AI_CLI_METHODS.enrol:
      return enrolTarget(payload, operations);
  }
}

async function enrolTarget(
  payload: Record<string, unknown>,
  operations: LocalAiCliOperations,
): Promise<unknown> {
  const { config } = LocalAiCliEnrolPayloadSchema.parse(payload);
  await rejectDuplicateTarget(operations, config);
  const validation = LocalAiCliValidationResultSchema.parse(
    await operations.validate(config),
  );
  if (
    validation.length === 0
    || validation.some((result) => result.required && !result.ok)
  ) {
    throw new Error('Local AI target validation failed; target was not enrolled');
  }
  await rejectDuplicateTarget(operations, config);
  const target = await operations.create(config);
  return LocalAiCliEnrolResultSchema.parse({ target, validation });
}

async function rejectDuplicateTarget(
  operations: LocalAiCliOperations,
  config: LocalAiTargetConfig,
): Promise<void> {
  const targets = LocalAiCliTargetListResultSchema.parse(await operations.list());
  const duplicate = targets.find((target) =>
    target.location.type === config.location.type
    && (
      target.location.type === 'coordinator'
      || (
        config.location.type === 'worker'
        && target.location.nodeId === config.location.nodeId
      )
    )
    && target.provider === config.provider
    && target.endpointId === config.endpointId
    && target.baseUrl === config.baseUrl);
  if (duplicate) {
    throw new Error(`Local AI endpoint is already enrolled as ${duplicate.id}`);
  }
}
