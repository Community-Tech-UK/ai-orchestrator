import { REDACTED_SENTINEL } from '../../../../shared/types/mcp-dtos.types';

export function parseOptionalStringArray(label: string, value: string): string[] | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error(`${label} must be a JSON array of strings.`);
  }
  return parsed;
}

export function parseOptionalStringRecord(
  label: string,
  value: string,
  skipRedacted: boolean,
  ): Record<string, string> | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry !== 'string') {
      throw new Error(`${label} values must be strings.`);
    }
    if (skipRedacted && entry === REDACTED_SENTINEL) {
      continue;
    }
    record[key] = entry;
  }
  return Object.keys(record).length > 0 ? record : undefined;
}
