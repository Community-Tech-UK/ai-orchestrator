import {
  asRecord,
  finiteNumber,
  forEachLine,
  isOneOf,
  validNumbers,
  validUsage,
  withNumbers,
  withUsage,
} from './shared';
import {
  DIAGNOSTIC_KINDS,
  ITEM_CLASSES,
  type AnalysisState,
  type AnalysisTimelineEvent,
  type CodexContextAnalysisSummary,
  type DiagnosticKind,
} from './types';

export async function parseDiagnosticLog(path: string, state: AnalysisState): Promise<void> {
  let lineNumber = 0;
  await forEachLine(path, (line) => {
    lineNumber += 1;
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      state.summary.sources.diagnosticLog.malformedRecords += 1;
      return;
    }
    const entry = asRecord(parsed);
    if (entry?.['subsystem'] !== 'CodexContextDiagnostics'
      || entry['message'] !== 'context-pressure-observation') return;
    const event = sanitizeDiagnosticRecord(entry['data'], lineNumber);
    if (!event) {
      state.summary.sources.diagnosticLog.malformedRecords += 1;
      return;
    }
    state.timeline.push(event);
    state.summary.sources.diagnosticLog.acceptedRecords += 1;
    const kind = event.kind as DiagnosticKind;
    state.summary.counts.diagnosticKinds[kind] += 1;
    updateDiagnosticCoverage(kind, state.summary);
  });
}

function sanitizeDiagnosticRecord(value: unknown, sequence: number): AnalysisTimelineEvent | null {
  const data = asRecord(value);
  const kind = data?.['kind'];
  if (data?.['schemaVersion'] !== 1 || !isOneOf(kind, DIAGNOSTIC_KINDS)) return null;
  const at = finiteNumber(data['at']);
  if (at === null) return null;
  const base: AnalysisTimelineEvent = { source: 'diagnostic', at, sequence, kind };
  switch (kind) {
    case 'transport-usage':
      if (!validNumbers(data, ['transportSequence'], ['contextWindow']) || !validUsage(data)) return null;
      return withUsage(base, data, ['transportSequence', 'contextWindow']);
    case 'transport-compaction':
      if (!validNumbers(data, ['transportSequence'])) return null;
      return withNumbers(base, data, ['transportSequence']);
    case 'turn-start':
      if (!validNumbers(data, ['turnSequence'], ['baselineUsedTokens'])) return null;
      return withNumbers(base, data, ['turnSequence', 'baselineUsedTokens']);
    case 'item-completed': {
      const itemClass = data['itemClass'];
      if (!ITEM_CLASSES.has(itemClass as never)
        || typeof data['rootThread'] !== 'boolean'
        || !validNumbers(data, [
          'turnSequence', 'itemSequence', 'observedPayloadBytes', 'serializedItemBytes',
        ])) return null;
      return {
        ...withNumbers(base, data, [
          'turnSequence', 'itemSequence', 'observedPayloadBytes', 'serializedItemBytes',
        ]),
        itemClass,
        rootThread: data['rootThread'],
      };
    }
    case 'token-usage':
      if (!validNumbers(
        data,
        ['turnSequence', 'requestSequence', 'rootItemsSincePreviousUsage', 'observedPayloadBytesSincePreviousUsage'],
        ['contextWindow', 'previousLastTotalTokens', 'lastTotalDelta', 'cumulativeTotalDelta', 'occupancyPercentage'],
      ) || !validUsage(data)) return null;
      return withUsage(withNumbers(base, data, [
        'turnSequence', 'requestSequence', 'previousLastTotalTokens', 'lastTotalDelta',
        'cumulativeTotalDelta', 'occupancyPercentage', 'rootItemsSincePreviousUsage',
        'observedPayloadBytesSincePreviousUsage',
      ]), data, ['contextWindow']);
    case 'compaction-rpc': {
      const stage = data['stage'];
      if (!isOneOf(stage, ['requested', 'accepted', 'failed'] as const)
        || !validNumbers(data, [], ['turnSequence', 'lastKnownUsedTokens'])) return null;
      return { ...withNumbers(base, data, ['turnSequence', 'lastKnownUsedTokens']), stage };
    }
    case 'compaction-observed':
      if (!validNumbers(data, [], ['turnSequence', 'requestSequence', 'lastKnownUsedTokens'])) return null;
      return withNumbers(base, data, ['turnSequence', 'requestSequence', 'lastKnownUsedTokens']);
    case 'turn-complete': {
      const completionStatus = data['completionStatus'];
      if (!isOneOf(completionStatus, ['completed', 'interrupted', 'failed', 'unknown'] as const)
        || !validNumbers(
          data,
          ['turnSequence', 'requestSequence', 'rootItems', 'subagentItems', 'observedPayloadBytes', 'compactionsObserved'],
          ['peakUsedTokens', 'peakPercentage'],
        )) return null;
      return {
        ...withNumbers(base, data, [
          'turnSequence', 'requestSequence', 'rootItems', 'subagentItems',
          'observedPayloadBytes', 'peakUsedTokens', 'peakPercentage', 'compactionsObserved',
        ]),
        completionStatus,
      };
    }
  }
}

function updateDiagnosticCoverage(
  kind: DiagnosticKind,
  summary: CodexContextAnalysisSummary,
): void {
  if (kind === 'transport-usage') summary.coverage.rawDiagnosticUsageNotifications = true;
  if (kind === 'item-completed') summary.coverage.itemSizeObservations = true;
  if (kind === 'transport-compaction' || kind === 'compaction-rpc' || kind === 'compaction-observed') {
    summary.coverage.compactionMarkers = true;
  }
  if (kind === 'turn-start' || kind === 'turn-complete') summary.coverage.turnBoundaries = true;
}
