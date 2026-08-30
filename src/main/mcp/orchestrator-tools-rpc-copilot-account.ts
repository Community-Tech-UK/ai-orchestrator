/**
 * RPC dispatch for `aio-mcp copilot-account`. Read-only; see the contracts
 * module for why writes are deliberately absent.
 */

import {
  COPILOT_ACCOUNT_CLI_METHODS,
  CopilotAccountCliDoctorSchema,
  CopilotAccountCliEmptyPayloadSchema,
  CopilotAccountCliProfileListSchema,
  CopilotAccountCliRouteSchema,
  CopilotAccountCliRoutePayloadSchema,
  CopilotAccountCliRuleListSchema,
  type CopilotAccountCliMethod,
  type CopilotAccountCliOperations,
} from './copilot-account-cli-contracts';

export type { CopilotAccountCliOperations } from './copilot-account-cli-contracts';

export function isCopilotAccountCliRpcMethod(method: string): method is CopilotAccountCliMethod {
  return Object.values(COPILOT_ACCOUNT_CLI_METHODS).includes(method as CopilotAccountCliMethod);
}

export async function dispatchCopilotAccountCliRpc(
  method: CopilotAccountCliMethod,
  payload: Record<string, unknown>,
  operations: CopilotAccountCliOperations | null,
): Promise<unknown> {
  if (!operations) {
    throw new Error('Copilot account CLI operations unavailable');
  }
  switch (method) {
    case COPILOT_ACCOUNT_CLI_METHODS.list:
      CopilotAccountCliEmptyPayloadSchema.parse(payload);
      // Parsed on the way OUT as well as in: the schemas are `.strict()`, so an
      // extra field added upstream (a home path, a token) fails here rather
      // than reaching a terminal, a pipe, or a pasted log.
      return CopilotAccountCliProfileListSchema.parse(await operations.list());
    case COPILOT_ACCOUNT_CLI_METHODS.rules:
      CopilotAccountCliEmptyPayloadSchema.parse(payload);
      return CopilotAccountCliRuleListSchema.parse(await operations.rules());
    case COPILOT_ACCOUNT_CLI_METHODS.route: {
      const { workingDirectory, origin } = CopilotAccountCliRoutePayloadSchema.parse(payload);
      return CopilotAccountCliRouteSchema.parse(await operations.route(workingDirectory, origin));
    }
    case COPILOT_ACCOUNT_CLI_METHODS.doctor:
      CopilotAccountCliEmptyPayloadSchema.parse(payload);
      return CopilotAccountCliDoctorSchema.parse(await operations.doctor());
  }
}
