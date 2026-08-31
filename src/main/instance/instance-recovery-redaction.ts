import type { Instance, OutputMessage } from '../../shared/types/instance.types';

export const RECOVERY_IDENTITY_REDACTION = '[recovery identity omitted]';
const IDENTITY_FIELD = /(?:session|cursor|thread)(?:id|key|ref)?$|^(?:recoverykey|sourceinstanceid|originalinstanceid)$/i;
const extraRecoverySensitiveValues = new WeakMap<object, ReadonlySet<string>>();
const pendingRecoveryAdapterExits = new WeakMap<object, {
  code: number | null;
  signal: string | null;
}>();

export function isCrashRecoveryInstance(instance: Pick<Instance, 'metadata'> | undefined): boolean {
  return instance?.metadata?.['reason'] === 'crash-recovery';
}

function addSensitiveValue(values: Set<string>, value: string | undefined): void {
  const trimmed = value?.trim();
  if (!trimmed) return;
  values.add(trimmed);
  const lastSeparator = trimmed.lastIndexOf(':');
  if (lastSeparator >= 0 && lastSeparator + 1 < trimmed.length) {
    values.add(trimmed.slice(lastSeparator + 1));
  }
}

export function setExtraRecoverySensitiveValues(
  instance: object,
  values: Iterable<string>,
): void {
  const expanded = new Set<string>();
  for (const value of values) addSensitiveValue(expanded, value);
  extraRecoverySensitiveValues.set(instance, expanded);
}

export function clearExtraRecoverySensitiveValues(instance: object): void {
  extraRecoverySensitiveValues.delete(instance);
}

export function markPendingRecoveryAdapterExit(
  instance: object,
  code: number | null,
  signal: string | null,
): void {
  pendingRecoveryAdapterExits.set(instance, { code, signal });
}

export function getPendingRecoveryAdapterExit(instance: object): {
  code: number | null;
  signal: string | null;
} | undefined {
  return pendingRecoveryAdapterExits.get(instance);
}

export function clearPendingRecoveryAdapterExit(instance: object): void {
  pendingRecoveryAdapterExits.delete(instance);
}

export function getRecoverySensitiveValues(
  instance: Pick<Instance, 'sessionId' | 'providerSessionId' | 'historyThreadId'>,
): Set<string> {
  const values = new Set<string>();
  for (const value of [instance.sessionId, instance.providerSessionId, instance.historyThreadId]) {
    addSensitiveValue(values, value);
  }
  for (const value of extraRecoverySensitiveValues.get(instance) ?? []) {
    addSensitiveValue(values, value);
  }
  return values;
}

export function redactRecoveryIdentityValue(
  value: unknown,
  sensitiveValues: ReadonlySet<string>,
  fieldName?: string,
): unknown {
  return redactRecoveryIdentityValueInner(value, sensitiveValues, fieldName, new WeakSet<object>());
}

function redactRecoveryIdentityValueInner(
  value: unknown,
  sensitiveValues: ReadonlySet<string>,
  fieldName: string | undefined,
  seen: WeakSet<object>,
): unknown {
  const normalizedField = fieldName?.replaceAll(/[-_]/g, '');
  if (normalizedField?.toLowerCase() === 'recoverysession') return value;
  if (normalizedField && IDENTITY_FIELD.test(normalizedField)) return RECOVERY_IDENTITY_REDACTION;
  if (typeof value === 'string') {
    let redacted = value;
    for (const sensitiveValue of sensitiveValues) {
      if (sensitiveValue) redacted = redacted.replaceAll(sensitiveValue, RECOVERY_IDENTITY_REDACTION);
    }
    return redacted;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactRecoveryIdentityValueInner(
      entry,
      sensitiveValues,
      undefined,
      seen,
    ));
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      redactRecoveryIdentityValueInner(entry, sensitiveValues, key, seen),
    ]));
  }
  return value;
}

export function recoverySessionDiagnostic(
  instance: Pick<Instance, 'metadata'> | undefined,
  field: string,
  value: string | undefined,
): Record<string, unknown> {
  return isCrashRecoveryInstance(instance)
    ? { recoverySession: true }
    : { [field]: value };
}

export function redactRecoveryOutputMessage(instance: Instance, message: OutputMessage): OutputMessage {
  if (!isCrashRecoveryInstance(instance)) return message;
  return redactRecoveryIdentityValue(
    message,
    getRecoverySensitiveValues(instance),
  ) as OutputMessage;
}

export function redactRecoveryText(instance: Instance | undefined, value: string): string {
  if (!instance || !isCrashRecoveryInstance(instance)) return value;
  return redactRecoveryIdentityValue(
    value,
    getRecoverySensitiveValues(instance),
  ) as string;
}

export function redactRecoveryError(
  instance: Instance | undefined,
  error: unknown,
  fallback = 'Recovery runtime operation failed',
): Error {
  if (!instance || !isCrashRecoveryInstance(instance)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  return redactRecoveryErrorWithValues(
    error,
    getRecoverySensitiveValues(instance),
    fallback,
    new WeakSet<object>(),
  );
}

function redactRecoveryErrorWithValues(
  error: unknown,
  sensitiveValues: ReadonlySet<string>,
  fallback: string,
  seen: WeakSet<object>,
): Error {
  if (!(error instanceof Error)) {
    const rawMessage = String(error || fallback);
    return new Error(redactRecoveryIdentityValue(
      rawMessage,
      sensitiveValues,
    ) as string || fallback);
  }
  if (seen.has(error)) return new Error(fallback);
  seen.add(error);

  const safe = new Error(redactRecoveryIdentityValue(
    error.message || fallback,
    sensitiveValues,
  ) as string || fallback);
  safe.name = redactRecoveryIdentityValue(
    error.name || 'Error',
    sensitiveValues,
  ) as string;
  if (typeof error.stack === 'string') {
    safe.stack = redactRecoveryIdentityValue(
      error.stack,
      sensitiveValues,
    ) as string;
  }

  const raw = error as Error & Record<string, unknown>;
  if (raw['code'] !== undefined) {
    (safe as Error & Record<string, unknown>)['code'] = redactRecoveryIdentityValue(
      raw['code'],
      sensitiveValues,
      'code',
    );
  }
  if (raw['cause'] !== undefined) {
    (safe as Error & { cause?: unknown }).cause = raw['cause'] instanceof Error
      ? redactRecoveryErrorWithValues(raw['cause'], sensitiveValues, fallback, seen)
      : redactRecoveryIdentityValue(raw['cause'], sensitiveValues, 'cause');
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'name'
        || key === 'message'
        || key === 'stack'
        || key === 'code'
        || key === 'cause') continue;
    (safe as Error & Record<string, unknown>)[key] = redactRecoveryIdentityValue(
      value,
      sensitiveValues,
      key,
    );
  }
  return safe;
}

export function createInvalidSessionNotice(
  instance: Instance,
  id: string,
  timestamp: number,
): OutputMessage {
  return redactRecoveryOutputMessage(instance, {
    id,
    timestamp,
    type: 'system',
    content:
      'This session could not be resumed — the provider no longer has it. ' +
      'Continuing starts a fresh session; use "Replay from history" to restore prior context.',
    metadata: {
      notice: {
        kind: 'invalid-session',
        ...recoverySessionDiagnostic(
          instance, 'sessionId', instance.providerSessionId ?? instance.sessionId,
        ),
        provider: instance.provider,
      },
    },
  });
}
