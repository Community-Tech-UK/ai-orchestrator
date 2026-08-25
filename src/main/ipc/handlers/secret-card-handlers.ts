/**
 * IPC surface for the Workspace Secret Card.
 *
 * ============================ SECURITY CONTRACT ============================
 * This module is the ONLY place a user-typed credential crosses the IPC boundary,
 * and it exists as its own file so that the guarantee is structural rather than
 * conditional.
 *
 * HARD CONSTRAINTS — do not relax these without re-reading the spec:
 *
 *   1. This module MUST NOT import `instance-communication`, call
 *      `sendInputResponse`, or touch any CLI adapter. There must be no code path
 *      from here to `adapter.sendRaw`, because that is what puts a value into the
 *      agent's context.
 *   2. This module MUST NOT log the submitted payload. Log `{ name, workspaceId,
 *      valueLength }` and nothing else. Note that `sendInputResponse` logs a
 *      `responsePreview` (instance-communication.constants.ts:53) — that is exactly
 *      the sink being avoided.
 *   3. The value MUST NOT be returned to the renderer, echoed into conversation
 *      history, or included in an error message.
 *
 * The agent learns only that the secret now exists, via an opaque
 * `secret://<name>` reference emitted on the ordinary response path — safe,
 * because it carries no credential material.
 *
 * Spec: docs/plans/2026-08-23-workspace-secret-card_spec_planned.md (§4, §5.3).
 * ===========================================================================
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import {
  SecretCardAuditPayloadSchema,
  SecretCardDeclinePayloadSchema,
  SecretCardForgetPayloadSchema,
  SecretCardListPayloadSchema,
  SecretCardSubmitPayloadSchema,
} from '@contracts/schemas/security';
import { getLogger } from '../../logging/logger';
import {
  SafeStorageUnavailableError,
  getWorkspaceSecretStore,
  normaliseName,
  type WorkspaceSecretStore,
} from '../../secrets/workspace-secret-store';
import { isUnscopedWorkspace, toSecretWorkspaceId } from '../../secrets/secret-workspace-key';
import { validatedHandler, type IpcResponse } from '../validated-handler';

const logger = getLogger('SecretCardHandlers');

export interface RegisterSecretCardHandlersDeps {
  ensureTrustedSender?: (event: IpcMainInvokeEvent, channel: string) => IpcResponse | null;
  store?: WorkspaceSecretStore;
  /** Resolves an instance's working directory. Injected for tests. */
  getWorkingDirectory?: (instanceId: string) => string | undefined;
  /**
   * Delivers the opaque reference back to the agent. Injected rather than imported
   * so this module has no direct dependency on the adapter layer — constraint 1.
   */
  notifyAgent?: (instanceId: string, message: string) => Promise<void>;
}

function failure(code: string, message: string): IpcResponse {
  return { success: false, error: { code, message, timestamp: Date.now() } };
}

export function registerSecretCardHandlers(deps: RegisterSecretCardHandlersDeps = {}): void {
  const store = deps.store ?? getWorkspaceSecretStore();
  const options = (errorCode: string) => ({
    ensureTrustedSender: deps.ensureTrustedSender,
    errorCode,
  });

  const workspaceFor = (instanceId: string): string | undefined => {
    const cwd = deps.getWorkingDirectory?.(instanceId);
    return cwd ? toSecretWorkspaceId(cwd) : undefined;
  };

  ipcMain.handle(
    IPC_CHANNELS.SECRET_CARD_SUBMIT,
    validatedHandler(
      IPC_CHANNELS.SECRET_CARD_SUBMIT,
      SecretCardSubmitPayloadSchema,
      async (payload): Promise<IpcResponse> => {
        const workspaceId = workspaceFor(payload.instanceId);
        if (!workspaceId) {
          return failure('SECRET_CARD_UNKNOWN_INSTANCE', 'That session is no longer available.');
        }
        if (isUnscopedWorkspace(workspaceId)) {
          return failure(
            'SECRET_CARD_UNSCOPED_WORKSPACE',
            'This session has no working directory, so it has no workspace to store a secret in.',
          );
        }

        let name: string;
        try {
          name = normaliseName(payload.name);
        } catch {
          return failure('SECRET_CARD_INVALID_NAME', 'That secret name is not usable.');
        }

        try {
          store.put({
            workspaceId,
            name,
            label: payload.label,
            purpose: payload.purpose,
            value: payload.value,
            instanceId: payload.instanceId,
          });
        } catch (error) {
          if (error instanceof SafeStorageUnavailableError) {
            return failure(
              'SECRET_CARD_ENCRYPTION_UNAVAILABLE',
              'This Mac cannot encrypt secrets right now, so nothing was saved.',
            );
          }
          // The caught error is deliberately NOT passed to the logger. A driver-level
          // failure can quote the offending bound parameter, which here is the
          // credential itself. Name and workspace are enough to diagnose.
          logger.error('Failed to store workspace secret', undefined, { workspaceId, name });
          return failure('SECRET_CARD_STORE_FAILED', 'The secret could not be saved.');
        }

        // Constraint 2: name/workspace/length only. Never the value.
        logger.info('Secret card submitted', {
          workspaceId,
          name,
          valueLength: payload.value.length,
        });

        await deps.notifyAgent?.(
          payload.instanceId,
          `The requested credential is stored. Refer to it as secret://${name} — its value is not available to you.`,
        );

        return { success: true, data: { name, reference: `secret://${name}` } };
      },
      options('SECRET_CARD_SUBMIT_FAILED'),
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.SECRET_CARD_DECLINE,
    validatedHandler(
      IPC_CHANNELS.SECRET_CARD_DECLINE,
      SecretCardDeclinePayloadSchema,
      async (payload): Promise<IpcResponse> => {
        const workspaceId = workspaceFor(payload.instanceId);
        if (workspaceId && !isUnscopedWorkspace(workspaceId)) {
          store.recordDeclined(workspaceId, payload.name, payload.instanceId);
        }

        await deps.notifyAgent?.(
          payload.instanceId,
          payload.reason
            ? `The credential request was declined: ${payload.reason}`
            : 'The credential request was declined. Continue without it or suggest another approach.',
        );

        return { success: true, data: { declined: true } };
      },
      options('SECRET_CARD_DECLINE_FAILED'),
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.SECRET_CARD_LIST,
    validatedHandler(
      IPC_CHANNELS.SECRET_CARD_LIST,
      SecretCardListPayloadSchema,
      async (payload): Promise<IpcResponse> => ({
        success: true,
        data: store.list(toSecretWorkspaceId(payload.workingDirectory)),
      }),
      options('SECRET_CARD_LIST_FAILED'),
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.SECRET_CARD_FORGET,
    validatedHandler(
      IPC_CHANNELS.SECRET_CARD_FORGET,
      SecretCardForgetPayloadSchema,
      async (payload): Promise<IpcResponse> => ({
        success: true,
        data: { forgotten: store.forget(toSecretWorkspaceId(payload.workingDirectory), payload.name) },
      }),
      options('SECRET_CARD_FORGET_FAILED'),
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.SECRET_CARD_AUDIT,
    validatedHandler(
      IPC_CHANNELS.SECRET_CARD_AUDIT,
      SecretCardAuditPayloadSchema,
      async (payload): Promise<IpcResponse> => ({
        success: true,
        data: store.auditTrail(toSecretWorkspaceId(payload.workingDirectory), payload.limit),
      }),
      options('SECRET_CARD_AUDIT_FAILED'),
    ),
  );
}
