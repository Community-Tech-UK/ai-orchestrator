import type { ResumeAttemptResult } from '../base-cli-adapter';
import type { CodexCliConfig } from '../codex-adapter-config';
import type { ResumeCursor } from '../../../session/session-continuity';
import { getLogger } from '../../../logging/logger';
import type { AppServerClient } from './app-server-client';
import { isRecoverableThreadResumeError } from './exec-error-classifier';
import { resumeThreadWithRetry } from './thread-resume-retry';
import { startThreadWithRetry } from './thread-start-retry';
import { SERVICE_NAME } from './app-server-types';
import type { CodexAskForApproval } from './app-server-types';
import type { CodexSessionScanner } from './session-scanner';

const logger = getLogger('CodexCliAdapter');

export interface CodexAppServerInitializationResult {
  client: AppServerClient;
  resumeAttempt: ResumeAttemptResult;
  resumeCursor: ResumeCursor | null;
  threadId: string | null;
}

export interface CodexAppServerInitializationOptions {
  client: AppServerClient;
  config: CodexCliConfig;
  cwd: string;
  isCurrent: () => boolean;
  onFailedAttempt: (attempt: ResumeAttemptResult) => void;
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  sessionId: string | null;
  sessionScanner: CodexSessionScanner;
  shouldResume: boolean;
}

/**
 * Preserve Harness's fail-closed command/file behavior while allowing MCP
 * approval elicitations to reach the interactive app-server client.
 */
export function resolveCodexAppServerApprovalPolicy(
  config: Pick<CodexCliConfig, 'approvalMode'>,
): CodexAskForApproval {
  if (config.approvalMode === 'full-auto') return 'never';
  return {
    granular: {
      sandbox_approval: false,
      rules: false,
      skill_approval: false,
      request_permissions: false,
      mcp_elicitations: true,
    },
  };
}

/** Resolves or creates a Codex thread without mutating adapter state. */
export async function initializeCodexAppServer(
  options: CodexAppServerInitializationOptions,
): Promise<CodexAppServerInitializationResult | null> {
  const {
    client,
    config,
    cwd,
    isCurrent,
    onFailedAttempt,
    sandbox,
    sessionId,
    sessionScanner,
    shouldResume,
  } = options;
  const approvalPolicy = resolveCodexAppServerApprovalPolicy(config);
  const requestedResumeSessionId = shouldResume ? sessionId ?? undefined : undefined;
  const resumeRequested = shouldResume;
  const hasSpecificResumeTarget = Boolean(requestedResumeSessionId);
  let threadId: string | null = null;
  let resumeSource: ResumeCursor['scanSource'] | null = null;
  let resumeAttempt: ResumeAttemptResult = resumeRequested
    ? {
        source: 'none',
        confirmed: false,
        requestedSessionId: requestedResumeSessionId,
        reason: 'Native resume not attempted yet',
      }
    : {
        source: 'none',
        confirmed: true,
        reason: 'Fresh thread requested',
      };

  try {
    if (shouldResume && requestedResumeSessionId) {
      try {
        const resumeResult = await resumeThreadWithRetry(client, {
          threadId: requestedResumeSessionId,
          cwd,
          model: config.model || null,
          approvalPolicy,
          sandbox,
        });
        const resumedThreadId = resumeResult.threadId || resumeResult.thread?.id || null;
        if (resumedThreadId === requestedResumeSessionId) {
          threadId = resumedThreadId;
          resumeSource = 'native';
          resumeAttempt = {
            source: 'native',
            confirmed: true,
            requestedSessionId: requestedResumeSessionId,
            actualSessionId: threadId,
          };
          logger.info('App-server thread resumed from persisted cursor', { threadId });
        } else {
          resumeAttempt = {
            source: 'native',
            confirmed: false,
            requestedSessionId: requestedResumeSessionId,
            actualSessionId: resumedThreadId ?? undefined,
            reason: resumedThreadId
              ? 'Codex resumed a different thread than requested'
              : 'Codex returned no thread id for resume',
          };
          logger.warn('Persisted cursor resume returned an unexpected thread id, falling back to fresh thread', {
            requestedSessionId: requestedResumeSessionId,
            actualSessionId: resumedThreadId,
          });
        }
      } catch (error) {
        if (!isRecoverableThreadResumeError(error)) throw error;
        logger.warn('Persisted cursor resume failed (recoverable), falling back to fresh thread', {
          error: String(error),
        });
        resumeAttempt = {
          source: 'native',
          confirmed: false,
          requestedSessionId: requestedResumeSessionId,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }

    if (!threadId && shouldResume && !hasSpecificResumeTarget) {
      try {
        const listResult = await client.request('thread/list', {
          cwd,
          limit: 5,
          sortKey: 'updated_at',
          sortDirection: 'desc',
        });
        const candidate = listResult.data?.[0];
        if (candidate?.id) {
          try {
            const resumeResult = await resumeThreadWithRetry(client, {
              threadId: candidate.id,
              cwd,
              model: config.model || null,
              approvalPolicy,
              sandbox,
            });
            threadId = resumeResult.threadId || resumeResult.thread?.id || null;
            resumeSource = 'thread-list';
            resumeAttempt = {
              source: 'native',
              confirmed: Boolean(threadId),
              requestedSessionId: candidate.id,
              actualSessionId: threadId ?? undefined,
            };
            logger.info('App-server thread resumed from thread/list', {
              threadId,
              candidateId: candidate.id,
            });
          } catch (error) {
            if (!isRecoverableThreadResumeError(error)) throw error;
            logger.warn('thread/list candidate resume failed (recoverable), falling through to JSONL scan', {
              candidateId: candidate.id,
              error: String(error),
            });
          }
        }
      } catch (error) {
        logger.debug('thread/list unavailable or failed, falling through to JSONL scan', {
          error: String(error),
        });
      }
    }

    if (!threadId && shouldResume && !hasSpecificResumeTarget) {
      const scanResult = await sessionScanner.findSessionForWorkspace(cwd);
      if (scanResult) {
        try {
          const resumeResult = await resumeThreadWithRetry(client, {
            threadId: scanResult.threadId,
            cwd,
            model: config.model || null,
            approvalPolicy,
            sandbox,
          });
          threadId = resumeResult.threadId || resumeResult.thread?.id || null;
          resumeSource = 'jsonl-scan';
          resumeAttempt = {
            source: 'jsonl-scan',
            confirmed: Boolean(threadId),
            requestedSessionId: scanResult.threadId,
            actualSessionId: threadId ?? undefined,
          };
          logger.info('App-server thread resumed from JSONL scan', {
            threadId,
            scannedFile: scanResult.sessionFilePath,
          });
        } catch (error) {
          if (!isRecoverableThreadResumeError(error)) throw error;
          logger.warn('JSONL scan resume failed (recoverable), falling back to fresh start', {
            error: String(error),
          });
          resumeAttempt = {
            source: 'jsonl-scan',
            confirmed: false,
            requestedSessionId: scanResult.threadId,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      } else {
        logger.info('No matching Codex session found on filesystem for workspace', { cwd });
        resumeAttempt = {
          source: 'jsonl-scan',
          confirmed: false,
          requestedSessionId: sessionId ?? undefined,
          reason: 'No matching Codex session found on filesystem for workspace',
        };
      }
    }

    if (!threadId) {
      const startResult = await startThreadWithRetry(client, {
        cwd,
        model: config.model || null,
        approvalPolicy,
        sandbox,
        serviceName: SERVICE_NAME,
        ephemeral: config.ephemeral ?? false,
        serviceTier: config.fastMode ? 'priority' : null,
      });
      threadId = startResult.threadId || startResult.thread?.id || null;
      resumeSource = null;
      resumeAttempt = resumeRequested
        ? {
            source: 'fresh-fallback',
            confirmed: false,
            requestedSessionId: requestedResumeSessionId,
            actualSessionId: threadId ?? undefined,
            reason: 'Started a fresh Codex thread after native resume was unavailable',
          }
        : {
            source: 'none',
            confirmed: true,
            actualSessionId: threadId ?? undefined,
            reason: 'Started a fresh Codex thread',
          };
      logger.info('App-server thread started fresh', { threadId });
    }

    if (!isCurrent()) {
      logger.warn('App-server init completed after being abandoned — discarding late client', {
        threadId,
      });
      try { await client.close(); } catch { /* best-effort cleanup */ }
      return null;
    }

    return {
      client,
      threadId,
      resumeAttempt,
      resumeCursor: threadId
        ? {
            provider: 'openai',
            threadId,
            workspacePath: cwd,
            capturedAt: Date.now(),
            scanSource: resumeSource ?? 'native',
          }
        : null,
    };
  } catch (error) {
    if (isCurrent()) onFailedAttempt(resumeAttempt);
    try { await client.close(); } catch { /* best-effort cleanup */ }
    throw error;
  }
}
