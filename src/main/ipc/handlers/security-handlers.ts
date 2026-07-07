/**
 * Security IPC Handlers
 * Handles secret detection, redaction, bash validation, and env filtering
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS, type IpcResponse } from '../../../shared/types/ipc.types';
import {
  BashValidatePayloadSchema,
  PermissionPatternPayloadSchema,
  PermissionGetAuditLogPayloadSchema,
  PermissionRecordBatchDecisionPayloadSchema,
  PermissionRecordDecisionPayloadSchema,
  SecurityCheckEnvVarPayloadSchema,
  SecurityCheckFilePayloadSchema,
  SecurityDetectSecretsPayloadSchema,
  SecurityGetAuditLogPayloadSchema,
  SecurityRedactContentPayloadSchema,
  SecuritySetPermissionPresetPayloadSchema,
} from '@contracts/schemas/security';
import {
  detectSecretsInContent,
  detectSecretsInEnvContent,
  isSecretFile,
  getFileSensitivity
} from '../../security/secret-detector';
import {
  redactEnvContent,
  redactAllSecrets,
  getSecretAuditLog
} from '../../security/secret-redaction';
import {
  getSafeEnv,
  shouldAllowEnvVar,
  DEFAULT_ENV_FILTER_CONFIG
} from '../../security/env-filter';
import { getBashValidationPipeline } from '../../security/bash-validation';
import { PermissionDecisionStore } from '../../security/permission-decision-store';
import { getPermissionManager } from '../../security/permission-manager';
import { getToolPermissionChecker } from '../../security/tool-permission-checker';
import { getRLMDatabase } from '../../persistence/rlm-database';
import { validatedHandler } from '../validated-handler';

export function registerSecurityHandlers(): void {
  // ============================================
  // Secret Detection & Redaction Handlers
  // ============================================

  // Detect secrets in content
  ipcMain.handle(
    IPC_CHANNELS.SECURITY_DETECT_SECRETS,
    validatedHandler(
      'SECURITY_DETECT_SECRETS',
      SecurityDetectSecretsPayloadSchema,
      async (payload) => {
        let secrets;
        if (payload.contentType === 'env') {
          secrets = detectSecretsInEnvContent(payload.content);
        } else if (payload.contentType === 'text') {
          secrets = detectSecretsInContent(payload.content);
        } else {
          // Auto-detect: if content looks like .env format, use env parser
          const looksLikeEnv = payload.content
            .split('\n')
            .some((line) => /^[A-Z_][A-Z0-9_]*=/.test(line.trim()));
          secrets = looksLikeEnv
            ? detectSecretsInEnvContent(payload.content)
            : detectSecretsInContent(payload.content);
        }
        return { success: true, data: secrets };
      }
    )
  );

  // Redact secrets in content
  ipcMain.handle(
    IPC_CHANNELS.SECURITY_REDACT_CONTENT,
    validatedHandler(
      'SECURITY_REDACT_CONTENT',
      SecurityRedactContentPayloadSchema,
      async (payload) => {
        let redacted;
        if (payload.contentType === 'env') {
          redacted = redactEnvContent(payload.content, payload.options);
        } else {
          redacted = redactAllSecrets(payload.content, payload.options);
        }
        return { success: true, data: { redacted } };
      }
    )
  );

  // Check if a file path is sensitive
  ipcMain.handle(
    IPC_CHANNELS.SECURITY_CHECK_FILE,
    validatedHandler(
      'SECURITY_CHECK_FILE',
      SecurityCheckFilePayloadSchema,
      async (payload) => {
        return {
          success: true,
          data: {
            isSecretFile: isSecretFile(payload.filePath),
            sensitivity: getFileSensitivity(payload.filePath)
          }
        };
      }
    )
  );

  // Get secret access audit log
  ipcMain.handle(
    IPC_CHANNELS.SECURITY_GET_AUDIT_LOG,
    validatedHandler(
      'SECURITY_GET_AUDIT_LOG',
      SecurityGetAuditLogPayloadSchema,
      async (payload) => {
        const auditLog = getSecretAuditLog();
        const records = payload.instanceId
          ? auditLog.getRecordsByInstance(payload.instanceId, payload.limit)
          : auditLog.getRecords(payload.limit);
        return { success: true, data: records };
      }
    )
  );

  // Clear audit log (no payload)
  ipcMain.handle(
    IPC_CHANNELS.SECURITY_CLEAR_AUDIT_LOG,
    async (): Promise<IpcResponse> => {
      try {
        const auditLog = getSecretAuditLog();
        auditLog.clear();
        return { success: true, data: { cleared: true } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SECURITY_CLEAR_AUDIT_LOG_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // Environment Variable Filtering Handlers
  // ============================================

  // Get safe environment variables (no payload)
  ipcMain.handle(
    IPC_CHANNELS.SECURITY_GET_SAFE_ENV,
    async (): Promise<IpcResponse> => {
      try {
        const safeEnv = getSafeEnv();
        return { success: true, data: safeEnv };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SECURITY_GET_SAFE_ENV_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Check if a single env var should be allowed
  ipcMain.handle(
    IPC_CHANNELS.SECURITY_CHECK_ENV_VAR,
    validatedHandler(
      'SECURITY_CHECK_ENV_VAR',
      SecurityCheckEnvVarPayloadSchema,
      async (payload) => {
        const result = shouldAllowEnvVar(payload.name, payload.value);
        return { success: true, data: result };
      }
    )
  );

  // Get env filter config (no payload)
  ipcMain.handle(
    IPC_CHANNELS.SECURITY_GET_ENV_FILTER_CONFIG,
    async (): Promise<IpcResponse> => {
      try {
        // Serialize config (convert RegExp to strings)
        const config = {
          ...DEFAULT_ENV_FILTER_CONFIG,
          blockPatterns: DEFAULT_ENV_FILTER_CONFIG.blockPatterns.map(
            (p) => p.source
          ),
          allowPatterns: DEFAULT_ENV_FILTER_CONFIG.allowPatterns.map(
            (p) => p.source
          )
        };
        return { success: true, data: config };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SECURITY_GET_ENV_FILTER_CONFIG_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SECURITY_GET_PERMISSION_CONFIG,
    async (): Promise<IpcResponse> => {
      try {
        const manager = getPermissionManager();
        return {
          success: true,
          data: {
            config: manager.getConfig(),
            stats: manager.getStats(),
          },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SECURITY_GET_PERMISSION_CONFIG_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SECURITY_SET_PERMISSION_PRESET,
    validatedHandler(
      'SECURITY_SET_PERMISSION_PRESET',
      SecuritySetPermissionPresetPayloadSchema,
      async (payload) => {
        const manager = getPermissionManager();
        manager.configure({ defaultAction: payload.preset });
        return {
          success: true,
          data: {
            preset: payload.preset,
            config: manager.getConfig(),
            stats: manager.getStats(),
          },
        };
      }
    )
  );

  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_GET_PENDING_BATCH,
    async (): Promise<IpcResponse> => {
      try {
        const manager = getPermissionManager();
        const requests = manager.getPendingBatches().flatMap((batch) => batch.requests);
        return { success: true, data: { requests } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PERMISSION_GET_PENDING_BATCH_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_RECORD_BATCH_DECISION,
    validatedHandler(
      'PERMISSION_RECORD_BATCH_DECISION',
      PermissionRecordBatchDecisionPayloadSchema,
      async (payload) => {
        const count = getPermissionManager().recordBatchDecisionForPending(
          payload.action,
          payload.scope,
        );
        return { success: true, data: { recorded: count } };
      }
    )
  );

  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_RECORD_DECISION,
    validatedHandler(
      'PERMISSION_RECORD_DECISION',
      PermissionRecordDecisionPayloadSchema,
      async (payload) => {
        const recorded = getPermissionManager().recordDecisionByRequestId(
          payload.requestId,
          payload.action,
          payload.scope,
        );
        return { success: true, data: { recorded } };
      }
    )
  );

  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_GET_LEARNED_PATTERNS,
    async (): Promise<IpcResponse> => {
      try {
        return { success: true, data: getPermissionManager().getLearnedPatterns() };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PERMISSION_GET_LEARNED_PATTERNS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_APPROVE_PATTERN,
    validatedHandler(
      'PERMISSION_APPROVE_PATTERN',
      PermissionPatternPayloadSchema,
      async (payload) => ({
        success: true,
        data: { approved: getPermissionManager().approveLearnedPattern(payload.patternId) },
      })
    )
  );

  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_REJECT_PATTERN,
    validatedHandler(
      'PERMISSION_REJECT_PATTERN',
      PermissionPatternPayloadSchema,
      async (payload) => ({
        success: true,
        data: { rejected: getPermissionManager().rejectLearnedPattern(payload.patternId) },
      })
    )
  );

  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_GET_STATS,
    async (): Promise<IpcResponse> => {
      try {
        const manager = getPermissionManager();
        return {
          success: true,
          data: {
            ...manager.getStats(),
            ...manager.getLearningStats(),
          },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PERMISSION_GET_STATS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_GET_AUDIT_LOG,
    validatedHandler(
      'PERMISSION_GET_AUDIT_LOG',
      PermissionGetAuditLogPayloadSchema,
      async (payload) => {
        const limit = payload.limit ?? 50;
        const decisionStore = new PermissionDecisionStore(getRLMDatabase().getRawDb());
        const decisions = payload.instanceId
          ? decisionStore.getByInstance(payload.instanceId).slice(0, limit)
          : decisionStore.getRecent(limit);
        const checker = getToolPermissionChecker();
        const denials = payload.instanceId
          ? checker.getDenialsForInstance(payload.instanceId).slice(-limit).reverse()
          : [...checker.getDenials()].slice(-limit).reverse();
        return { success: true, data: { decisions, denials } };
      }
    )
  );

  // ============================================
  // Bash Validation Handlers
  // ============================================

  const bashValidator = getBashValidationPipeline();

  // Validate a bash command
  ipcMain.handle(
    IPC_CHANNELS.BASH_VALIDATE,
    validatedHandler(
      'BASH_VALIDATE',
      BashValidatePayloadSchema,
      async (payload) => {
        const result = bashValidator.validate(payload.command);
        return { success: true, data: result };
      }
    )
  );
}
