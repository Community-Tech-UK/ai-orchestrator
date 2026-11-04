import { textDiagnostic } from '../../../logging/source-diagnostics';

/** Native JSON counters are unchecked; project diagnostics without changing the event. */
export function copilotUsageDiagnostic(value: unknown): number | Record<string, unknown> | undefined {
  if (value === undefined || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (typeof value === 'string') return { valueKind: 'string', ...textDiagnostic(value) };
  return { valueKind: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value };
}

/** Preserve useful native IDs; malformed JSON kinds must not retain source in logs. */
export function copilotSessionIdDiagnostic(value: unknown): string | { valueKind: string } | undefined {
  if (value === undefined || typeof value === 'string') return value;
  return { valueKind: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value };
}
