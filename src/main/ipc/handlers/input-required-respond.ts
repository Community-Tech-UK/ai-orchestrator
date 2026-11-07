/**
 * `INPUT_REQUIRED_RESPOND`: the person's reply to a question or approval a CLI
 * raised. Moved out of `instance-handlers.ts` (which is at its size ceiling)
 * when it learned to leave a receipt for the reply.
 *
 * The receipt rule: the request is held "in flight" before anything is sent, and
 * the outcome is committed only after the reply was really applied. An adapter's
 * echo of the same reply is then recognised as ours instead of being reported
 * as an answer from somewhere else, and a reply that failed leaves no receipt.
 * What gets committed is what this function itself did (the decision it
 * recorded, the rule it saved), never text a window supplied about an approval.
 */

import { validateIpcPayload } from '@contracts/schemas/common';
import { InputRequiredResponsePayloadSchema } from '@contracts/schemas/instance';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import type { InstanceManager } from '../../instance/instance-manager';
import type { InFlightReply } from '../../instance/input-request-receipts';
import { getLogger } from '../../logging/logger';
import { getPauseCoordinator } from '../../pause/pause-coordinator';
import { getRemoteObserverServer } from '../../remote/observer-server';
import { getSelfPermissionGranter } from '../../security/self-permission-granter';
import { permissionDenyNote } from '../../../shared/permissions/permission-deny-note';

const logger = getLogger('InstanceHandlers');

export async function respondToInputRequired(instanceManager: InstanceManager, payload: unknown): Promise<IpcResponse> {
  let reply: InFlightReply | undefined;
  try {
    // Validate payload at IPC boundary
    const validatedPayload = validateIpcPayload(
      InputRequiredResponsePayloadSchema,
      payload,
      'INPUT_REQUIRED_RESPOND'
    );

    if (getPauseCoordinator().isPaused()) {
      return {
        success: false,
        error: {
          code: 'ORCHESTRATOR_PAUSED',
          message: 'Input response refused while orchestrator is paused',
          timestamp: Date.now(),
        },
      };
    }

    // Route deferred permission responses to the resume flow instead of stdin
    if (validatedPayload.metadata?.['type'] === 'deferred_permission') {
      const action = validatedPayload.decisionAction;

      // The reply must name a request this instance is still waiting on. A
      // cancelled, already-answered or fabricated requestId must never reach the
      // resume flow, where it could authorize an unrelated held tool call. The
      // renderer drops the card on this code (it handles INPUT_REQUIRED_NOT_PENDING
      // as "stale, not failed").
      if (!instanceManager.isPendingInputRequiredPermission(validatedPayload.instanceId, validatedPayload.requestId)) {
        return {
          success: false,
          error: {
            code: 'INPUT_REQUIRED_NOT_PENDING',
            message: 'No pending permission request is waiting for this response.',
            timestamp: Date.now(),
          },
        };
      }

      // Fail-safe: 'modify' without updatedInput must never silently degrade to
      // a plain allow of the original input.  The schema cross-refine catches
      // this at validation time, but guard again here defensively.
      if (action === 'modify' && !validatedPayload.updatedInput) {
        return {
          success: false,
          error: {
            code: 'MODIFY_WITHOUT_UPDATED_INPUT',
            message: "decisionAction 'modify' requires a non-empty updatedInput object",
            timestamp: Date.now(),
          },
        };
      }

      // WARN: 'modify' depends on the installed Claude CLI honouring updatedInput
      // in its PreToolUse hook reply.  If the CLI version does not support it,
      // the tool will run with the ORIGINAL (unmodified) input.  This is a known
      // correctness/safety gap until live-CLI support is confirmed.
      if (action === 'modify') {
        logger.warn('Deferred permission modify decision — CLI support unverified', {
          instanceId: validatedPayload.instanceId,
          requestId: validatedPayload.requestId,
          updatedInputKeys: Object.keys(validatedPayload.updatedInput!),
        });
      }

      const approved = action !== 'deny';
      const updatedInput = action === 'modify' ? validatedPayload.updatedInput : undefined;
      const enableYolo = approved && validatedPayload.metadata?.['enableYolo'] === true;
      reply = instanceManager.getRequestReceipts().beginReply(validatedPayload.instanceId, validatedPayload.requestId);
      await instanceManager.resumeAfterDeferredPermission(
        validatedPayload.instanceId, approved, updatedInput,
        { requestId: validatedPayload.requestId, ...(enableYolo ? { yoloMode: true } : {}),
          ...(!approved ? { denyNote: permissionDenyNote(validatedPayload) } : {}) },
      );

      if (validatedPayload.decisionAction && validatedPayload.decisionScope) {
        // Map 'modify' to 'allow' for PermissionManager — it only knows allow/deny.
        const recordAction: 'allow' | 'deny' =
          validatedPayload.decisionAction === 'deny' ? 'deny' : 'allow';
        instanceManager.recordInputRequiredPermissionDecision({
          instanceId: validatedPayload.instanceId,
          requestId: validatedPayload.requestId,
          action: recordAction,
          scope: validatedPayload.decisionScope,
        });
      } else {
        instanceManager.clearPendingInputRequiredPermission(
          validatedPayload.instanceId,
          validatedPayload.requestId
        );
      }
      getRemoteObserverServer().clearPrompt(validatedPayload.requestId);
      if (reply.commit({
        response: validatedPayload.response,
        decision: action ? { action, scope: validatedPayload.decisionScope } : undefined,
        enabledYolo: enableYolo,
      }) === false) throw Object.assign(new Error("That request has already closed."), { code: "INPUT_REQUIRED_NOT_PENDING" });

      return {
        success: true,
        data: {
          requestId: validatedPayload.requestId,
          responded: true,
          resumed: true,
          ...(enableYolo ? { yoloMode: true } : {}),
        }
      };
    }

    // Self-healing permission grant for tool_result permission denials.
    // When the user selects "Always allow" for a `permission_denial` prompt
    // (e.g. Claude was blocked from writing ~/.claude/settings.json by the
    // CLI's own internal guard), write the matching rule to the user's
    // Claude settings file and respawn the instance so the CLI picks it up.
    // See: src/main/security/self-permission-granter.ts
    if (
      validatedPayload.metadata?.['type'] === 'permission_denial' &&
      validatedPayload.decisionAction === 'allow' &&
      validatedPayload.decisionScope === 'always'
    ) {
      reply = instanceManager.getRequestReceipts().beginReply(validatedPayload.instanceId, validatedPayload.requestId);
      const meta = validatedPayload.metadata;
      const toolNameRaw = meta['tool_name'];
      const actionRaw = meta['action'];
      const fullPathRaw = meta['full_path'];
      const displayPathRaw = meta['path'];

      const grantResult = getSelfPermissionGranter().grant({
        toolName: typeof toolNameRaw === 'string' ? toolNameRaw : undefined,
        action: typeof actionRaw === 'string' ? actionRaw : undefined,
        path:
          typeof fullPathRaw === 'string'
            ? fullPathRaw
            : typeof displayPathRaw === 'string'
              ? displayPathRaw
              : undefined,
        // User answer #2: default grant scope is "just this file".
        scopeTree: false,
        instanceId: validatedPayload.instanceId,
        requestId: validatedPayload.requestId,
      });

      if (grantResult.ok) {
        const suffix = grantResult.alreadyExisted ? ' (already present)' : '';
        instanceManager.emitSystemMessage(
          validatedPayload.instanceId,
          `Permission rule ${grantResult.rulePattern} added to ${grantResult.settingsFile}${suffix}. Restarting session so Claude CLI picks up the new rule — please retry your request after the session reconnects.`,
          {
            selfPermissionGrant: true,
            rulePattern: grantResult.rulePattern,
            settingsFile: grantResult.settingsFile,
            alreadyExisted: grantResult.alreadyExisted,
          },
        );
      } else {
        logger.warn('Self-permission grant failed', {
          instanceId: validatedPayload.instanceId,
          requestId: validatedPayload.requestId,
          code: grantResult.code,
          message: grantResult.message,
        });
        instanceManager.emitSystemMessage(
          validatedPayload.instanceId,
          `Failed to grant permission: ${grantResult.message}${grantResult.settingsFile ? ` (settings file: ${grantResult.settingsFile})` : ''}`,
          {
            selfPermissionGrantError: true,
            code: grantResult.code,
          },
        );
      }

      if (grantResult.ok) {
        // Keep our PermissionManager in sync with what was written to
        // Claude's settings.json. Record before clearing so the pending
        // request still exists in InstanceManager.
        instanceManager.recordInputRequiredPermissionDecision({
          instanceId: validatedPayload.instanceId,
          requestId: validatedPayload.requestId,
          action: 'allow',
          scope: 'always',
        });
      } else {
        // Nothing was allowed. Keep the request open so the person can retry the failed write.
        reply.abort();
        return {
          success: false,
          error: { code: 'PERMISSION_GRANT_FAILED', message: 'The permission rule could not be saved. Try again.', timestamp: Date.now() },
        };
      }
      getRemoteObserverServer().clearPrompt(validatedPayload.requestId);
      // The answer is complete once the rule is written; the restart below only picks it up.
      if (reply.commit({
        response: validatedPayload.response,
        decision: { action: 'allow', scope: 'always' },
        grant: grantResult.ok ? 'saved' : 'failed',
      }) === false) throw Object.assign(new Error("That request has already closed."), { code: "INPUT_REQUIRED_NOT_PENDING" });

      // Only respawn when the grant actually landed — otherwise we'd just
      // restart the session without fixing anything.
      let respawned = false;
      if (grantResult.ok) {
        try {
          await instanceManager.respawnAfterUnexpectedExit(validatedPayload.instanceId);
          respawned = true;
        } catch (respawnErr) {
          logger.warn('Respawn after self-permission grant failed', {
            instanceId: validatedPayload.instanceId,
            requestId: validatedPayload.requestId,
            error: respawnErr instanceof Error ? respawnErr.message : String(respawnErr),
          });
          instanceManager.emitSystemMessage(
            validatedPayload.instanceId,
            `Permission rule was saved but the session could not be restarted automatically. Please restart the instance manually.`,
            { selfPermissionRespawnError: true },
          );
        }
      }

      return {
        success: true,
        data: {
          requestId: validatedPayload.requestId,
          responded: true,
          granted: grantResult.ok,
          rulePattern: grantResult.ok ? grantResult.rulePattern : undefined,
          alreadyExisted: grantResult.ok ? grantResult.alreadyExisted : undefined,
          respawned,
        },
      };
    }

    // Standard input_required flow — send the response to the CLI via stdin
    reply = instanceManager.getRequestReceipts().beginReply(validatedPayload.instanceId, validatedPayload.requestId);
    await instanceManager.sendInputResponse(
      validatedPayload.instanceId,
      validatedPayload.response,
      validatedPayload.permissionKey
    );

    // If the renderer attached a permission decision, persist it via PermissionManager.
    if (validatedPayload.decisionAction && validatedPayload.decisionScope) {
      // Map 'modify' to 'allow' for PermissionManager — it only knows allow/deny.
      const stdRecordAction: 'allow' | 'deny' =
        validatedPayload.decisionAction === 'deny' ? 'deny' : 'allow';
      instanceManager.recordInputRequiredPermissionDecision({
        instanceId: validatedPayload.instanceId,
        requestId: validatedPayload.requestId,
        action: stdRecordAction,
        scope: validatedPayload.decisionScope,
      });
    } else {
      instanceManager.clearPendingInputRequiredPermission(
        validatedPayload.instanceId,
        validatedPayload.requestId
      );
    }
    getRemoteObserverServer().clearPrompt(validatedPayload.requestId);
    if (reply.commit({
      response: validatedPayload.response,
      decision: validatedPayload.decisionAction && validatedPayload.decisionScope
        ? { action: validatedPayload.decisionAction, scope: validatedPayload.decisionScope }
        : undefined,
      receipt: validatedPayload.receipt,
    }) === false) throw Object.assign(new Error("That request has already closed."), { code: "INPUT_REQUIRED_NOT_PENDING" });

    return {
      success: true,
      data: { requestId: validatedPayload.requestId, responded: true }
    };
  } catch (error) {
    reply?.abort();
    // A request that timed out or was auto-answered before this reply is
    // stale, not failed: the renderer drops the card instead of erroring.
    const notPending = (error as { code?: unknown }).code === 'INPUT_REQUIRED_NOT_PENDING';
    return {
      success: false,
      error: {
        code: notPending ? 'INPUT_REQUIRED_NOT_PENDING' : 'INPUT_REQUIRED_RESPOND_FAILED',
        message: (error as Error).message,
        timestamp: Date.now()
      }
    };
  }
}
