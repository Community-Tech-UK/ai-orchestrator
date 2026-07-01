import { redactForSink } from '../diagnostics/redaction';

export interface SanitizedLogError {
  name: string;
  message: string;
  stack?: string;
}

export function truncateLogString(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`;
}

export function redactLogString(value: string, maxLength: number): string {
  const truncated = truncateLogString(value, maxLength);
  try {
    const redacted = redactForSink(truncated);
    return typeof redacted === 'string' ? redacted : truncated;
  } catch {
    return truncated;
  }
}

export function sanitizeLogError(
  error: Error,
  messageMaxLength: number,
  stackMaxLength: number,
): SanitizedLogError {
  return {
    name: redactLogString(error.name, messageMaxLength),
    message: redactLogString(error.message, messageMaxLength),
    stack: error.stack ? redactLogString(error.stack, stackMaxLength) : undefined,
  };
}
