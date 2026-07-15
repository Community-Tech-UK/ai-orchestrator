export type DiagnosticKind =
  | 'transport-usage'
  | 'transport-compaction'
  | 'turn-start'
  | 'item-completed'
  | 'token-usage'
  | 'compaction-rpc'
  | 'compaction-observed'
  | 'turn-complete';

export type ProviderEventKind =
  | 'output'
  | 'tool-use'
  | 'tool-result'
  | 'status'
  | 'context'
  | 'error'
  | 'exit'
  | 'spawned'
  | 'complete'
  | 'other';

export type RolloutEntryType =
  | 'session-metadata'
  | 'response-item'
  | 'event-message'
  | 'turn-context'
  | 'compaction'
  | 'other';

export type RolloutSubtype =
  | 'token-count'
  | 'compaction'
  | 'message'
  | 'reasoning'
  | 'tool-call'
  | 'tool-result'
  | 'web-search'
  | 'file-change'
  | 'turn-start'
  | 'turn-complete'
  | 'other';

export type ItemClass =
  | 'command'
  | 'mcp'
  | 'dynamic'
  | 'web'
  | 'file-change'
  | 'collaboration'
  | 'agent-message'
  | 'reasoning'
  | 'other';

export type LimitationCode =
  | 'diagnostic-log-not-supplied'
  | 'provider-captures-not-supplied'
  | 'provider-capture-table-unavailable'
  | 'rollout-not-supplied'
  | 'raw-diagnostic-usage-unavailable'
  | 'normalized-context-events-unavailable'
  | 'rollout-token-count-events-unavailable'
  | 'item-size-observations-unavailable'
  | 'compaction-markers-unavailable'
  | 'turn-boundaries-unavailable';

export interface SourceSummary {
  provided: boolean;
  available: boolean;
  acceptedRecords: number;
  malformedRecords: number;
}

export interface TokenSnapshot {
  totalTokens: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
}

export interface AnalysisTimelineEvent {
  source: 'diagnostic' | 'provider-capture' | 'rollout';
  at: number | null;
  sequence: number;
  kind?: DiagnosticKind | ProviderEventKind;
  entryType?: RolloutEntryType;
  subtype?: RolloutSubtype;
  [key: string]: unknown;
}

export interface CodexContextAnalysisSummary {
  schemaVersion: 1;
  sources: {
    diagnosticLog: SourceSummary;
    providerCaptures: SourceSummary;
    rollout: SourceSummary;
  };
  counts: {
    timelineEvents: number;
    diagnosticKinds: Record<DiagnosticKind, number>;
    providerEventKinds: Record<ProviderEventKind, number>;
    rolloutEntryTypes: Record<RolloutEntryType, number>;
  };
  coverage: {
    rawDiagnosticUsageNotifications: boolean;
    normalizedContextEvents: boolean;
    rolloutTokenCountEvents: boolean;
    itemSizeObservations: boolean;
    compactionMarkers: boolean;
    turnBoundaries: boolean;
  };
  limitations: LimitationCode[];
}

export interface CodexContextAnalysisOptions {
  logPath?: string;
  dbPath?: string;
  instanceId?: string;
  rolloutPath?: string;
  outDir: string;
}

export interface CodexContextAnalysisFiles {
  summaryPath: string;
  timelinePath: string;
  reportPath: string;
}

export interface AnalysisState {
  summary: CodexContextAnalysisSummary;
  timeline: AnalysisTimelineEvent[];
}

export interface CaptureRow {
  sequence: number;
  created_at: number;
  event_json: string;
  raw_provenance_present: number;
}

export interface ReadonlyCaptureDatabase {
  prepare(sql: string): {
    get(...values: unknown[]): unknown;
    iterate(...values: unknown[]): Iterable<unknown>;
  };
  close(): void;
}

export interface CodexContextAnalysisDependencies {
  openDatabase(path: string, options: { readonly: true; fileMustExist: true }): ReadonlyCaptureDatabase;
}

export const DIAGNOSTIC_KINDS: readonly DiagnosticKind[] = [
  'transport-usage', 'transport-compaction', 'turn-start', 'item-completed',
  'token-usage', 'compaction-rpc', 'compaction-observed', 'turn-complete',
];

export const PROVIDER_EVENT_KINDS: readonly ProviderEventKind[] = [
  'output', 'tool-use', 'tool-result', 'status', 'context', 'error', 'exit',
  'spawned', 'complete', 'other',
];

export const ROLLOUT_ENTRY_TYPES: readonly RolloutEntryType[] = [
  'session-metadata', 'response-item', 'event-message', 'turn-context', 'compaction', 'other',
];

export const ITEM_CLASSES = new Set<ItemClass>([
  'command', 'mcp', 'dynamic', 'web', 'file-change', 'collaboration',
  'agent-message', 'reasoning', 'other',
]);
