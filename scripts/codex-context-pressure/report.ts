import {
  asRecord,
  finiteNumber,
  isOneOf,
  yesNo,
} from './shared';
import {
  ITEM_CLASSES,
  type AnalysisTimelineEvent,
  type CodexContextAnalysisSummary,
  type ItemClass,
  type LimitationCode,
} from './types';

export function buildLimitations(summary: CodexContextAnalysisSummary): LimitationCode[] {
  const limitations: LimitationCode[] = [];
  if (!summary.sources.diagnosticLog.provided) limitations.push('diagnostic-log-not-supplied');
  if (!summary.sources.providerCaptures.provided) limitations.push('provider-captures-not-supplied');
  if (summary.sources.providerCaptures.provided && !summary.sources.providerCaptures.available) {
    limitations.push('provider-capture-table-unavailable');
  }
  if (!summary.sources.rollout.provided) limitations.push('rollout-not-supplied');
  if (!summary.coverage.rawDiagnosticUsageNotifications) limitations.push('raw-diagnostic-usage-unavailable');
  if (!summary.coverage.normalizedContextEvents) limitations.push('normalized-context-events-unavailable');
  if (!summary.coverage.rolloutTokenCountEvents) limitations.push('rollout-token-count-events-unavailable');
  if (!summary.coverage.itemSizeObservations) limitations.push('item-size-observations-unavailable');
  if (!summary.coverage.compactionMarkers) limitations.push('compaction-markers-unavailable');
  if (!summary.coverage.turnBoundaries) limitations.push('turn-boundaries-unavailable');
  return limitations;
}

const LIMITATION_TEXT: Record<LimitationCode, string> = {
  'diagnostic-log-not-supplied': 'No diagnostic log was supplied.',
  'provider-captures-not-supplied': 'No provider captures were supplied.',
  'provider-capture-table-unavailable': 'The supplied ledger capture table was unavailable.',
  'rollout-not-supplied': 'No rollout was supplied.',
  'raw-diagnostic-usage-unavailable': 'Raw diagnostic usage notifications were unavailable.',
  'normalized-context-events-unavailable': 'Normalized context events were unavailable.',
  'rollout-token-count-events-unavailable': 'Rollout token-count events were unavailable.',
  'item-size-observations-unavailable': 'Item-size observations were unavailable.',
  'compaction-markers-unavailable': 'Compaction markers were unavailable.',
  'turn-boundaries-unavailable': 'Turn boundaries were unavailable.',
};

export function buildReport(
  summary: CodexContextAnalysisSummary,
  timeline: readonly AnalysisTimelineEvent[],
): string {
  const coverage = summary.coverage;
  const source = summary.sources;
  const rows = [
    ['Raw diagnostic usage notifications', coverage.rawDiagnosticUsageNotifications],
    ['Normalized context events', coverage.normalizedContextEvents],
    ['Rollout token-count events', coverage.rolloutTokenCountEvents],
    ['Item-size observations', coverage.itemSizeObservations],
    ['Compaction markers', coverage.compactionMarkers],
    ['Turn boundaries', coverage.turnBoundaries],
  ] as const;
  return [
    '# Codex Context Pressure Evidence Report',
    '',
    '## Source summary',
    '',
    '| Source | Supplied | Available | Accepted | Malformed |',
    '| --- | ---: | ---: | ---: | ---: |',
    `| Diagnostic log | ${yesNo(source.diagnosticLog.provided)} | ${yesNo(source.diagnosticLog.available)} | ${source.diagnosticLog.acceptedRecords} | ${source.diagnosticLog.malformedRecords} |`,
    `| Provider captures | ${yesNo(source.providerCaptures.provided)} | ${yesNo(source.providerCaptures.available)} | ${source.providerCaptures.acceptedRecords} | ${source.providerCaptures.malformedRecords} |`,
    `| Rollout | ${yesNo(source.rollout.provided)} | ${yesNo(source.rollout.available)} | ${source.rollout.acceptedRecords} | ${source.rollout.malformedRecords} |`,
    '',
    `Malformed diagnostic records: ${source.diagnosticLog.malformedRecords}`,
    '',
    'Usage evidence retains the first, final, and up to 98 evenly spaced middle observations.',
    '',
    '## Usage evidence',
    '',
    '| Evidence | At | Current used | Current delta | Cumulative | Cumulative delta | Window | Occupancy % |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...usageEvidenceRows(timeline),
    '',
    '## Item-size evidence',
    '',
    '| Item class | Count | Content bytes | Serialized bytes |',
    '| --- | ---: | ---: | ---: |',
    ...itemEvidenceRows(timeline),
    '',
    '## Compaction and turn observations',
    '',
    '| Observation | Count |',
    '| --- | ---: |',
    ...observationRows(timeline),
    '',
    '## Coverage',
    '',
    '| Evidence | Present |',
    '| --- | ---: |',
    ...rows.map(([label, present]) => `| ${label} | ${yesNo(present)} |`),
    '',
    '## Limitations',
    '',
    ...(summary.limitations.length > 0
      ? summary.limitations.map((code) => `- ${LIMITATION_TEXT[code]}`)
      : ['- No source-coverage limitation was detected.']),
    '',
  ].join('\n');
}

interface UsageEvidenceObservation {
  label: 'diagnostic transport usage' | 'diagnostic token usage' | 'normalized context' | 'rollout token count';
  at: number | null;
  current: number | null;
  currentDelta: number | null;
  cumulative: number | null;
  cumulativeDelta: number | null;
  window: number | null;
  occupancy: number | null;
}

function usageEvidenceRows(timeline: readonly AnalysisTimelineEvent[]): string[] {
  const observations = collectUsageEvidence(timeline);
  if (observations.length === 0) return ['| none | — | — | — | — | — | — | — |'];
  const selected = selectBoundedUsageObservations(observations);
  const rows = selected.map(renderUsageObservation);
  const omitted = observations.length - selected.length;
  if (omitted > 0) rows.splice(1, 0, `| omitted observations | ${omitted} | — | — | — | — | — | — |`);
  return rows;
}

function collectUsageEvidence(
  timeline: readonly AnalysisTimelineEvent[],
): UsageEvidenceObservation[] {
  const observations: UsageEvidenceObservation[] = [];
  const previous = new Map<UsageEvidenceObservation['label'], {
    current: number | null;
    cumulative: number | null;
  }>();
  for (const event of timeline) {
    let label: UsageEvidenceObservation['label'] | null = null;
    let current: number | null = null;
    let cumulative: number | null = null;
    let currentDelta: number | null = null;
    let cumulativeDelta: number | null = null;
    let window: number | null = null;
    let occupancy: number | null = null;
    if (event.source === 'diagnostic' && event.kind === 'transport-usage') {
      label = 'diagnostic transport usage';
      current = snapshotTotal(event['last']);
      cumulative = snapshotTotal(event['cumulative']);
      window = finiteNumber(event['contextWindow']);
    } else if (event.source === 'diagnostic' && event.kind === 'token-usage') {
      label = 'diagnostic token usage';
      current = snapshotTotal(event['last']);
      cumulative = snapshotTotal(event['cumulative']);
      currentDelta = finiteNumber(event['lastTotalDelta']);
      cumulativeDelta = finiteNumber(event['cumulativeTotalDelta']);
      window = finiteNumber(event['contextWindow']);
      occupancy = finiteNumber(event['occupancyPercentage']);
    } else if (event.source === 'provider-capture' && event.kind === 'context') {
      label = 'normalized context';
      current = finiteNumber(event['usedTokens']);
      window = finiteNumber(event['contextWindow']);
      occupancy = finiteNumber(event['occupancyPercentage']);
    } else if (event.source === 'rollout' && event.subtype === 'token-count') {
      label = 'rollout token count';
      const usage = asRecord(event['tokenUsage']);
      current = snapshotTotal(usage?.['last']);
      cumulative = snapshotTotal(usage?.['cumulative']);
      window = finiteNumber(usage?.['contextWindow']);
    }
    if (!label) continue;
    const prior = previous.get(label);
    currentDelta ??= difference(current, prior?.current ?? null);
    cumulativeDelta ??= difference(cumulative, prior?.cumulative ?? null);
    occupancy ??= current !== null && window !== null && window > 0 ? (current / window) * 100 : null;
    observations.push({
      label, at: event.at, current, currentDelta, cumulative, cumulativeDelta, window, occupancy,
    });
    previous.set(label, { current, cumulative });
  }
  return observations;
}

function selectBoundedUsageObservations(
  observations: readonly UsageEvidenceObservation[],
): UsageEvidenceObservation[] {
  const limit = 100;
  if (observations.length <= limit) return [...observations];
  const indexes = new Set<number>([0, observations.length - 1]);
  for (let slot = 1; slot < limit - 1; slot += 1) {
    indexes.add(Math.round((slot * (observations.length - 1)) / (limit - 1)));
  }
  for (let index = 1; indexes.size < limit && index < observations.length - 1; index += 1) {
    indexes.add(index);
  }
  return [...indexes].sort((left, right) => left - right).map((index) => observations[index]!);
}

function renderUsageObservation(observation: UsageEvidenceObservation): string {
  return `| ${observation.label} | ${reportNumber(observation.at)} | ${reportNumber(observation.current)} | ${reportNumber(observation.currentDelta)} | ${reportNumber(observation.cumulative)} | ${reportNumber(observation.cumulativeDelta)} | ${reportNumber(observation.window)} | ${reportNumber(observation.occupancy)} |`;
}

function difference(current: number | null, previous: number | null): number | null {
  return current !== null && previous !== null ? current - previous : null;
}

function itemEvidenceRows(timeline: readonly AnalysisTimelineEvent[]): string[] {
  const totals = new Map<ItemClass, { count: number; content: number; serialized: number }>();
  for (const event of timeline) {
    if (event.kind !== 'item-completed' && event['itemObservation'] !== true) continue;
    const itemClass = event['itemClass'];
    if (!ITEM_CLASSES.has(itemClass as ItemClass)) continue;
    const current = totals.get(itemClass as ItemClass) ?? { count: 0, content: 0, serialized: 0 };
    current.count += 1;
    current.content += finiteNumber(event['observedPayloadBytes'] ?? event['contentBytes']) ?? 0;
    current.serialized += finiteNumber(event['serializedItemBytes'] ?? event['serializedLineBytes']) ?? 0;
    totals.set(itemClass as ItemClass, current);
  }
  const rows: string[] = [];
  for (const itemClass of ITEM_CLASSES) {
    const total = totals.get(itemClass);
    if (total) rows.push(`| ${itemClass} | ${total.count} | ${total.content} | ${total.serialized} |`);
  }
  return rows.length > 0 ? rows : ['| none | 0 | 0 | 0 |'];
}

function observationRows(timeline: readonly AnalysisTimelineEvent[]): string[] {
  const counts = new Map<string, number>();
  const increment = (label: string): void => {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  };
  for (const event of timeline) {
    if (event.kind === 'compaction-observed') increment('compaction observed');
    if (event.kind === 'transport-compaction') increment('transport compaction');
    if (event.kind === 'compaction-rpc') {
      const stage = event['stage'];
      if (isOneOf(stage, ['requested', 'accepted', 'failed'] as const)) {
        increment(`compaction RPC ${stage}`);
      }
    }
    if (event.source === 'rollout' && event['compactionMarker'] === true) increment('rollout compaction');
    if (event.kind === 'turn-start' || event.subtype === 'turn-start') increment('turn start');
    if (event.kind === 'turn-complete' || event.subtype === 'turn-complete') increment('turn complete');
  }
  const order = [
    'compaction observed', 'transport compaction', 'compaction RPC requested',
    'compaction RPC accepted', 'compaction RPC failed', 'rollout compaction',
    'turn start', 'turn complete',
  ];
  const rows = order.filter((label) => counts.has(label))
    .map((label) => `| ${label} | ${counts.get(label)} |`);
  return rows.length > 0 ? rows : ['| none | 0 |'];
}

function snapshotTotal(value: unknown): number | null {
  return finiteNumber(asRecord(value)?.['totalTokens']);
}

function reportNumber(value: unknown): string {
  const numeric = finiteNumber(value);
  return numeric === null ? '—' : String(Math.round(numeric * 100) / 100);
}
