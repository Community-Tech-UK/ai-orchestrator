import type { SqliteDriver } from '../db/sqlite-driver';
import type { InstanceManager } from '../instance/instance-manager';
import { getWakeContextBuilder } from '../memory/wake-context-builder';
import { getRLMDatabase } from '../persistence/rlm-database';
import type { CompactionMarker } from '../persistence/rlm/rlm-compaction-markers';
import { getCompactionMarker } from '../persistence/rlm/rlm-compaction-markers';
import { querySegmentsForCompactionRecovery } from '../persistence/rlm/rlm-verbatim';
import type { VerbatimSegmentRow } from '../persistence/rlm-database.types';
import { normalizeProjectMemoryKey } from '../memory/project-memory-key';
import { estimateTokens } from '../../shared/utils/token-estimate';
import type { InstanceStatus } from '../../shared/types/instance.types';

const MAX_RECOVERY_CHARS = 24_000;
const MAX_RECOVERY_TOKENS = 6_000;
const MAX_SEGMENTS = 8;

const RECOVERY_TERMINAL_STATUSES = new Set<InstanceStatus>([
  'error',
  'failed',
  'superseded',
  'terminated',
]);

export interface CompactionRecoveryRequest {
  instanceId: string;
  markerId: string;
}

export interface CompactionRecoveryResult {
  markerId: string;
  queuedForNextTurn: true;
  segmentsIncluded: number;
  contextChars: number;
}

export interface CompactionRecoveryDeps {
  db?: SqliteDriver;
  instanceManager: Pick<InstanceManager, 'getInstance' | 'queueContinuityPreamble'>;
  getWakeText?: (wing?: string) => string;
  now?: () => number;
}

export async function recoverCompactionContext(
  request: CompactionRecoveryRequest,
  deps: CompactionRecoveryDeps,
): Promise<CompactionRecoveryResult> {
  const db = deps.db ?? getRLMDatabase().getRawDb();
  const marker = getCompactionMarker(db, request.markerId);
  if (!marker) {
    throw new Error(`Compaction marker ${request.markerId} was not found`);
  }
  if (marker.instanceId !== request.instanceId) {
    throw new Error(`Compaction marker ${request.markerId} does not belong to instance ${request.instanceId}`);
  }

  const instance = deps.instanceManager.getInstance(request.instanceId);
  if (!instance) {
    throw new Error(`Instance ${request.instanceId} not found`);
  }
  if (RECOVERY_TERMINAL_STATUSES.has(instance.status)) {
    throw new Error(`Cannot recover compaction context for terminal instance ${request.instanceId}`);
  }

  const projectKey = marker.projectKey || instance.workingDirectory;
  const wings = buildProjectWings(projectKey);
  const wakeText = safeWakeText(projectKey, deps.getWakeText);
  const segments = querySegmentsForCompactionRecovery(db, {
    wings,
    beforeCreatedAt: marker.ledgerAnchor,
    limit: MAX_SEGMENTS,
  });
  const prompt = buildCompactionRecoveryPrompt({
    marker,
    wakeText,
    segments,
    now: deps.now?.() ?? Date.now(),
  });

  deps.instanceManager.queueContinuityPreamble(request.instanceId, prompt);

  return {
    markerId: marker.id,
    queuedForNextTurn: true,
    segmentsIncluded: segments.length,
    contextChars: prompt.length,
  };
}

function buildProjectWings(projectKey: string | null): string[] {
  if (!projectKey) {
    return [];
  }
  const normalized = normalizeProjectMemoryKey(projectKey);
  return Array.from(new Set([projectKey, normalized].filter(Boolean)));
}

function safeWakeText(
  projectKey: string | null,
  injected?: (wing?: string) => string,
): string {
  try {
    const getText = injected ?? ((wing?: string) =>
      getWakeContextBuilder().getWakeUpText(wing, { bypassCache: true }));
    return getText(projectKey ?? undefined).trim();
  } catch {
    return '';
  }
}

function buildCompactionRecoveryPrompt(params: {
  marker: CompactionMarker;
  wakeText: string;
  segments: VerbatimSegmentRow[];
  now: number;
}): string {
  const header = [
    '[Recovered Context From Compaction Marker]',
    `Recovered at: ${new Date(params.now).toISOString()}`,
    `Marker: ${params.marker.id}`,
    `Compaction method: ${params.marker.method}`,
    `Compacted at: ${new Date(params.marker.createdAt).toISOString()}`,
    '',
    'Use this block as restored context for the next answer. Do not repeat it back unless it is directly relevant.',
  ];

  const sections: string[] = [header.join('\n')];
  if (params.wakeText) {
    sections.push(['Wake context:', limitText(params.wakeText, 4_000)].join('\n'));
  }

  const segmentLines = renderSegments(params.segments);
  sections.push([
    'Preserved transcript snippets:',
    segmentLines.length > 0 ? segmentLines.join('\n\n') : '- No pre-compaction transcript snippets were available.',
  ].join('\n'));
  sections.push('[End Recovered Context]');

  return clampPrompt(sections.join('\n\n'));
}

function renderSegments(segments: VerbatimSegmentRow[]): string[] {
  const lines: string[] = [];
  let tokenBudget = MAX_RECOVERY_TOKENS;
  for (const segment of segments) {
    const snippet = limitText(segment.content.trim(), 3_000);
    const entry = [
      `- Source: ${segment.source_file}#${segment.chunk_index} (${segment.room}, importance ${segment.importance})`,
      snippet,
    ].join('\n');
    const tokens = estimateTokens(entry);
    if (tokens > tokenBudget && lines.length > 0) {
      break;
    }
    lines.push(entry);
    tokenBudget -= tokens;
  }
  return lines;
}

function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n[truncated]`;
}

function clampPrompt(prompt: string): string {
  if (prompt.length <= MAX_RECOVERY_CHARS) {
    return prompt;
  }
  const suffix = '\n\n[Recovered context truncated to stay under the injection budget]\n[End Recovered Context]';
  return `${prompt.slice(0, MAX_RECOVERY_CHARS - suffix.length).trimEnd()}${suffix}`;
}
