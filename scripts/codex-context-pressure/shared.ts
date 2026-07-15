import { Buffer } from 'node:buffer';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type {
  AnalysisTimelineEvent,
  TokenSnapshot,
} from './types';

export function readTokenSnapshot(value: unknown): TokenSnapshot {
  const record = asRecord(value);
  return {
    totalTokens: numericField(record, 'totalTokens', 'total_tokens'),
    inputTokens: numericField(record, 'inputTokens', 'input_tokens'),
    cachedInputTokens: numericField(record, 'cachedInputTokens', 'cached_input_tokens'),
    outputTokens: numericField(record, 'outputTokens', 'output_tokens'),
    reasoningOutputTokens: numericField(record, 'reasoningOutputTokens', 'reasoning_output_tokens'),
  };
}

export function withUsage(
  base: AnalysisTimelineEvent,
  data: Record<string, unknown>,
  numericKeys: readonly string[],
): AnalysisTimelineEvent {
  return {
    ...withNumbers(base, data, numericKeys),
    last: readTokenSnapshot(data['last']),
    cumulative: readTokenSnapshot(data['cumulative']),
  };
}

export function withNumbers(
  base: AnalysisTimelineEvent,
  data: Record<string, unknown>,
  keys: readonly string[],
): AnalysisTimelineEvent {
  const output = { ...base };
  for (const key of keys) output[key] = finiteNumber(data[key]);
  return output;
}

export function valueByteLength(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (value === undefined || value === null) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 0;
  }
}

export function stringField(
  record: Record<string, unknown> | null,
  primary: string,
  secondary?: string,
): string | null {
  const value = record?.[primary] ?? (secondary ? record?.[secondary] : undefined);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function validNumbers(
  record: Record<string, unknown>,
  required: readonly string[],
  nullable: readonly string[] = [],
): boolean {
  return required.every((key) => finiteNumber(record[key]) !== null)
    && nullable.every((key) => record[key] === null || finiteNumber(record[key]) !== null);
}

export function validUsage(record: Record<string, unknown>): boolean {
  return validSnapshot(record['last']) && validSnapshot(record['cumulative']);
}

function validSnapshot(value: unknown): boolean {
  const snapshot = asRecord(value);
  return snapshot !== null && validNumbers(snapshot, [], [
    'totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens',
  ]);
}

export function numericField(
  record: Record<string, unknown> | null,
  camelCase: string,
  snakeCase: string,
): number | null {
  return finiteNumber(record?.[camelCase] ?? record?.[snakeCase]);
}

export function copyNumeric(
  output: AnalysisTimelineEvent,
  input: Record<string, unknown>,
  inputKey: string,
  outputKey: string,
): void {
  output[outputKey] = finiteNumber(input[inputKey]);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

export function zeroCounts<T extends string>(values: readonly T[]): Record<T, number> {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>;
}

export function yesNo(value: boolean): 'yes' | 'no' {
  return value ? 'yes' : 'no';
}

export function toJsonLines(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join('\n') + (values.length > 0 ? '\n' : '');
}

export async function forEachLine(path: string, visitor: (line: string) => void): Promise<void> {
  const reader = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of reader) visitor(line);
}

export function compareTimelineEvents(
  left: AnalysisTimelineEvent,
  right: AnalysisTimelineEvent,
): number {
  const leftAt = left.at ?? Number.MAX_SAFE_INTEGER;
  const rightAt = right.at ?? Number.MAX_SAFE_INTEGER;
  if (leftAt !== rightAt) return leftAt - rightAt;
  const sourceOrder = { diagnostic: 0, 'provider-capture': 1, rollout: 2 } as const;
  if (left.source !== right.source) return sourceOrder[left.source] - sourceOrder[right.source];
  return left.sequence - right.sequence;
}

export function timestampNumber(value: unknown): number | null {
  const numeric = finiteNumber(value);
  if (numeric !== null) return numeric;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
