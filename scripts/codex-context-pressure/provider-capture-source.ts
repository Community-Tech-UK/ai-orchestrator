import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  asRecord,
  copyNumeric,
  finiteNumber,
  isOneOf,
  valueByteLength,
} from './shared';
import {
  PROVIDER_EVENT_KINDS,
  type AnalysisState,
  type AnalysisTimelineEvent,
  type CaptureRow,
  type CodexContextAnalysisDependencies,
  type ProviderEventKind,
  type ReadonlyCaptureDatabase,
} from './types';

export function openDefaultDatabase(
  path: string,
  options: { readonly: true; fileMustExist: true },
): ReadonlyCaptureDatabase {
  statSync(path);
  try {
    return new Database(path, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!message.includes('NODE_MODULE_VERSION')
      && !message.includes('compiled against a different Node.js version')) throw error;
    return new DatabaseSync(path, { readOnly: true }) as unknown as ReadonlyCaptureDatabase;
  }
}

export function parseProviderCaptures(
  path: string,
  instanceId: string,
  state: AnalysisState,
  dependencies: CodexContextAnalysisDependencies,
): void {
  const db = dependencies.openDatabase(path, { readonly: true, fileMustExist: true });
  try {
    const tableExists = db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_event_captures'
    `).get();
    if (!tableExists) {
      state.summary.sources.providerCaptures.available = false;
      return;
    }
    const rows = db.prepare(`
      SELECT sequence, created_at, event_json,
             CASE WHEN length(raw_source) > 0 AND length(raw_json) > 0 THEN 1 ELSE 0 END
               AS raw_provenance_present
      FROM provider_event_captures
      WHERE instance_id = ?
      ORDER BY created_at ASC, sequence ASC
    `).iterate(instanceId) as Iterable<CaptureRow>;
    for (const row of rows) {
      const event = parseProviderEvent(row);
      if (!event) {
        state.summary.sources.providerCaptures.malformedRecords += 1;
        continue;
      }
      state.timeline.push(event);
      state.summary.sources.providerCaptures.acceptedRecords += 1;
      const kind = event.kind as ProviderEventKind;
      state.summary.counts.providerEventKinds[kind] += 1;
      if (kind === 'context') state.summary.coverage.normalizedContextEvents = true;
    }
  } finally {
    db.close();
  }
}

function parseProviderEvent(row: CaptureRow): AnalysisTimelineEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.event_json) as unknown;
  } catch {
    return null;
  }
  const event = asRecord(parsed);
  if (!event || finiteNumber(row.created_at) === null || finiteNumber(row.sequence) === null) return null;
  const kind = normalizeProviderKind(event['kind']);
  const output: AnalysisTimelineEvent = {
    source: 'provider-capture', at: row.created_at, sequence: row.sequence, kind,
    rawProvenancePresent: row.raw_provenance_present === 1,
  };
  if (kind === 'output') output['contentBytes'] = valueByteLength(event['content']);
  if (kind === 'tool-result') output['contentBytes'] = valueByteLength(event['output']);
  if (kind === 'status') output['statusClass'] = normalizeStatus(event['status']);
  if (kind === 'context') {
    copyNumeric(output, event, 'used', 'usedTokens');
    copyNumeric(output, event, 'total', 'contextWindow');
    copyNumeric(output, event, 'percentage', 'occupancyPercentage');
    copyNumeric(output, event, 'inputTokens', 'inputTokens');
    copyNumeric(output, event, 'outputTokens', 'outputTokens');
    copyNumeric(output, event, 'promptWeight', 'inputShareRatio');
  }
  return output;
}

function normalizeProviderKind(value: unknown): ProviderEventKind {
  const normalized = value === 'tool_use' ? 'tool-use' : value === 'tool_result' ? 'tool-result' : value;
  return isOneOf(normalized, PROVIDER_EVENT_KINDS) ? normalized : 'other';
}

function normalizeStatus(value: unknown): 'busy' | 'idle' | 'waiting' | 'working' | 'other' {
  switch (value) {
    case 'busy': return 'busy';
    case 'idle': return 'idle';
    case 'waiting':
    case 'waiting_for_input':
    case 'waiting-for-input': return 'waiting';
    case 'working':
    case 'thinking': return 'working';
    default: return 'other';
  }
}
