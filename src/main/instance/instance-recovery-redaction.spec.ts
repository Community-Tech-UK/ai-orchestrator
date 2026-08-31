import { describe, expect, it } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import {
  RECOVERY_IDENTITY_REDACTION,
  redactRecoveryError,
} from './instance-recovery-redaction';

interface DiagnosticError extends Error {
  code?: string;
  cause?: unknown;
  metadata?: Record<string, unknown>;
  details?: Record<string, unknown>;
}

function makeRecoveryInstance(replacementAlias: string, sourceAlias: string): Instance {
  return {
    id: 'replacement-instance',
    sessionId: replacementAlias,
    providerSessionId: replacementAlias,
    historyThreadId: sourceAlias,
    metadata: { reason: 'crash-recovery', continuityRevival: true },
  } as unknown as Instance;
}

function makeDiagnosticError(replacementAlias: string, sourceAlias: string): DiagnosticError {
  const cause = Object.assign(new Error(`nested cause for ${sourceAlias}`), {
    code: `CAUSE_${replacementAlias}`,
    metadata: { recoveryCursor: sourceAlias },
  });
  cause.name = `Cause_${replacementAlias}`;
  const error = Object.assign(new Error(`provider failed for ${replacementAlias}`), {
    code: `PROVIDER_${sourceAlias}`,
    cause,
    metadata: { sessionRef: replacementAlias, source: sourceAlias },
    details: { nested: { threadId: sourceAlias } },
  }) as DiagnosticError;
  error.name = `Provider_${sourceAlias}`;
  return error;
}

describe('recovery error redaction', () => {
  it('redacts replacement and source aliases from every supported Error surface', () => {
    const replacementAlias = 'replacement-session-alias-placeholder';
    const sourceAlias = 'source-history-alias-placeholder';
    const instance = makeRecoveryInstance(replacementAlias, sourceAlias);
    const safe = redactRecoveryError(
      instance,
      makeDiagnosticError(replacementAlias, sourceAlias),
    ) as DiagnosticError;

    const cause = safe.cause as DiagnosticError | undefined;
    const observable = JSON.stringify({
      name: safe.name,
      message: safe.message,
      stack: safe.stack,
      code: safe.code,
      metadata: safe.metadata,
      details: safe.details,
      cause: cause && {
        name: cause.name,
        message: cause.message,
        stack: cause.stack,
        code: cause.code,
        metadata: cause.metadata,
      },
    });

    expect(observable).not.toContain(replacementAlias);
    expect(observable).not.toContain(sourceAlias);
    expect(observable).toContain(RECOVERY_IDENTITY_REDACTION);
    expect(safe.name).not.toBe(`Provider_${sourceAlias}`);
    expect(safe.code).not.toBe(`PROVIDER_${sourceAlias}`);
    expect(cause?.name).not.toBe(`Cause_${replacementAlias}`);
    expect(cause?.code).not.toBe(`CAUSE_${replacementAlias}`);
  });

  it('returns an ordinary non-recovery Error unchanged', () => {
    const replacementAlias = 'ordinary-session-alias-placeholder';
    const sourceAlias = 'ordinary-history-alias-placeholder';
    const instance = makeRecoveryInstance(replacementAlias, sourceAlias);
    instance.metadata = { reason: 'ordinary-session' };
    const error = makeDiagnosticError(replacementAlias, sourceAlias);

    const result = redactRecoveryError(instance, error);

    expect(result).toBe(error);
    expect((result as DiagnosticError).name).toBe(`Provider_${sourceAlias}`);
    expect((result as DiagnosticError).code).toBe(`PROVIDER_${sourceAlias}`);
    expect((result as DiagnosticError).cause).toBe(error.cause);
    expect((result as DiagnosticError).metadata).toBe(error.metadata);
  });
});
