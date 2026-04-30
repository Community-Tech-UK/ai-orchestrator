import { getLogger } from '../logging/logger';
import type { PromptHistoryEntry } from '../../shared/types/prompt-history.types';
import type { ConversationHistoryEntry, HistorySnippet } from '../../shared/types/history.types';
import type { SessionRecallResult } from '../../shared/types/session-recall.types';
import { getPromptHistoryService, type PromptHistoryService } from '../prompt-history/prompt-history-service';
import { getHistoryManager, type HistoryManager } from '../history/history-manager';
import { getTranscriptSnippetService, type TranscriptSnippetService } from '../history/transcript-snippet-service';
import { getSessionRecallService, type SessionRecallService } from '../session/session-recall-service';
import { normalizeProjectMemoryKey, projectMemoryKeysEqual } from './project-memory-key';

const logger = getLogger('ProjectMemoryBriefService');

const DEFAULT_MAX_CHARS = 1600;
const DEFAULT_MAX_RESULTS = 8;
const HISTORY_SCAN_MULTIPLIER = 4;
const HISTORY_EXPAND_LIMIT = 6;
const HISTORY_SNIPPETS_PER_ENTRY = 2;
const SNIPPET_CHARS = 260;
const MIN_TOKEN_LENGTH = 3;

export interface ProjectMemoryBriefRequest {
  projectPath: string;
  instanceId?: string;
  initialPrompt?: string;
  provider?: string;
  model?: string;
  maxChars?: number;
  maxResults?: number;
  includeMinedMemory?: boolean;
}

export type ProjectMemoryBriefSourceType = 'prompt-history' | 'history-transcript';

export interface ProjectMemoryBriefSource {
  id: string;
  type: ProjectMemoryBriefSourceType;
  title?: string;
  timestamp?: number;
  provider?: string;
  model?: string;
  projectPath: string;
  metadata?: Record<string, unknown>;
}

export interface ProjectMemoryBriefSectionItem {
  sourceId: string;
  text: string;
  timestamp?: number;
  provider?: string;
  model?: string;
}

export interface ProjectMemoryBriefSection {
  title: string;
  items: ProjectMemoryBriefSectionItem[];
}

export interface ProjectMemoryBrief {
  text: string;
  sections: ProjectMemoryBriefSection[];
  sources: ProjectMemoryBriefSource[];
  stats: {
    projectKey: string;
    candidatesScanned: number;
    candidatesIncluded: number;
    truncated: boolean;
  };
}

type ProjectMemoryPromptHistoryDep = Pick<PromptHistoryService, 'getForProject'>;
type ProjectMemoryHistoryDep = Pick<HistoryManager, 'getEntries'>;
type ProjectMemorySnippetDep = Pick<TranscriptSnippetService, 'expandSnippetsOnDemand'>;
type ProjectMemoryRecallDep = Pick<SessionRecallService, 'search'>;

interface ProjectMemoryBriefDeps {
  promptHistory?: ProjectMemoryPromptHistoryDep;
  history?: ProjectMemoryHistoryDep;
  snippets?: ProjectMemorySnippetDep;
  recall?: ProjectMemoryRecallDep;
}

interface BriefCandidate {
  sourceId: string;
  sourceType: ProjectMemoryBriefSourceType;
  section: 'prompts' | 'history';
  text: string;
  timestamp: number;
  provider?: string;
  model?: string;
  projectPath: string;
  title?: string;
  score: number;
  sourceRank: number;
  metadata?: Record<string, unknown>;
}

export class ProjectMemoryBriefService {
  constructor(private readonly deps: ProjectMemoryBriefDeps = {}) {}

  async buildBrief(request: ProjectMemoryBriefRequest): Promise<ProjectMemoryBrief> {
    const projectKey = normalizeProjectMemoryKey(request.projectPath);
    if (!projectKey) {
      return emptyBrief('');
    }

    const maxResults = clamp(Math.floor(request.maxResults ?? DEFAULT_MAX_RESULTS), 1, 20);
    const maxChars = clamp(Math.floor(request.maxChars ?? DEFAULT_MAX_CHARS), 500, 5000);
    const queryTokens = tokenize(request.initialPrompt ?? '');
    const candidates: BriefCandidate[] = [];

    candidates.push(...this.collectPromptCandidates(request, projectKey, queryTokens));
    candidates.push(...await this.collectHistoryCandidates(request, projectKey, queryTokens, maxResults));
    candidates.push(...await this.collectRecallCandidates(request, projectKey, queryTokens, maxResults));

    const deduped = dedupeCandidates(candidates);
    deduped.sort((left, right) => (
      right.score - left.score
      || right.sourceRank - left.sourceRank
      || right.timestamp - left.timestamp
    ));

    const selected = deduped.slice(0, maxResults);
    const { sections, sources } = buildStructuredBrief(selected);
    const rendered = renderBrief({
      projectKey,
      sections,
      sources,
      maxChars,
    });

    logger.debug('Built project memory brief', {
      projectKey,
      candidatesScanned: candidates.length,
      candidatesIncluded: selected.length,
      sourceCounts: countSources(sources),
      truncated: rendered.truncated,
    });

    return {
      text: rendered.text,
      sections,
      sources,
      stats: {
        projectKey,
        candidatesScanned: candidates.length,
        candidatesIncluded: selected.length,
        truncated: rendered.truncated,
      },
    };
  }

  private collectPromptCandidates(
    request: ProjectMemoryBriefRequest,
    projectKey: string,
    queryTokens: Set<string>,
  ): BriefCandidate[] {
    const promptHistory = this.deps.promptHistory ?? getPromptHistoryService();
    const alias = promptHistory.getForProject(projectKey);
    const candidates: BriefCandidate[] = [];

    for (const entry of alias.entries) {
      if (!entry.projectPath || !projectMemoryKeysEqual(entry.projectPath, projectKey)) {
        continue;
      }
      candidates.push(promptEntryToCandidate(entry, request, projectKey, queryTokens));
    }

    return candidates;
  }

  private async collectHistoryCandidates(
    request: ProjectMemoryBriefRequest,
    projectKey: string,
    queryTokens: Set<string>,
    maxResults: number,
  ): Promise<BriefCandidate[]> {
    const history = this.deps.history ?? getHistoryManager();
    const snippets = this.deps.snippets ?? getTranscriptSnippetService();
    const scanLimit = Math.max(maxResults * HISTORY_SCAN_MULTIPLIER, HISTORY_EXPAND_LIMIT);
    const entries = history.getEntries({
      workingDirectory: projectKey,
      projectScope: 'current',
      source: 'history-transcript',
      limit: scanLimit,
    });
    const candidates: BriefCandidate[] = [];

    for (const entry of entries.slice(0, HISTORY_EXPAND_LIMIT)) {
      let entrySnippets: HistorySnippet[] = [];
      try {
        entrySnippets = await snippets.expandSnippetsOnDemand(
          entry.id,
          request.initialPrompt ?? '',
          {
            maxSnippets: HISTORY_SNIPPETS_PER_ENTRY,
            maxExcerptChars: SNIPPET_CHARS,
          },
        );
      } catch (error) {
        logger.warn('Failed to expand history snippets for project memory brief', {
          entryId: entry.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (entrySnippets.length === 0) {
        entrySnippets = (entry.snippets ?? []).slice(0, HISTORY_SNIPPETS_PER_ENTRY);
      }
      if (entrySnippets.length === 0) {
        const preview = entry.lastUserMessage || entry.firstUserMessage;
        if (preview.trim()) {
          entrySnippets = [{ position: -1, excerpt: preview, score: 0.1 }];
        }
      }

      for (const snippet of entrySnippets.slice(0, HISTORY_SNIPPETS_PER_ENTRY)) {
        candidates.push(historySnippetToCandidate(entry, snippet, request, projectKey, queryTokens));
      }
    }

    return candidates;
  }

  private async collectRecallCandidates(
    request: ProjectMemoryBriefRequest,
    projectKey: string,
    queryTokens: Set<string>,
    maxResults: number,
  ): Promise<BriefCandidate[]> {
    const recall = this.deps.recall ?? getSessionRecallService();
    const scanLimit = Math.max(maxResults * HISTORY_SCAN_MULTIPLIER, HISTORY_EXPAND_LIMIT);
    let results: SessionRecallResult[] = [];

    try {
      results = await recall.search({
        query: request.initialPrompt?.trim() ?? '',
        repositoryPath: projectKey,
        provider: request.provider,
        model: request.model,
        sources: ['history-transcript', 'archived_session'],
        includeHistoryTranscripts: true,
        maxHistoryTranscriptResults: scanLimit,
        limit: scanLimit,
      });
    } catch (error) {
      logger.warn('Failed to collect session recall results for project memory brief', {
        projectKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }

    const candidates: BriefCandidate[] = [];
    for (const result of results) {
      if (result.source !== 'history-transcript') {
        continue;
      }

      const workingDirectory = result.metadata?.['workingDirectory'];
      if (
        typeof workingDirectory === 'string'
        && !projectMemoryKeysEqual(workingDirectory, projectKey)
      ) {
        continue;
      }

      const excerpt = typeof result.metadata?.['excerpt'] === 'string'
        ? result.metadata['excerpt']
        : result.summary;
      if (!excerpt.trim()) {
        continue;
      }

      candidates.push(recallResultToCandidate(result, excerpt, request, projectKey, queryTokens));
    }

    return candidates;
  }
}

function emptyBrief(projectKey: string): ProjectMemoryBrief {
  return {
    text: '',
    sections: [],
    sources: [],
    stats: {
      projectKey,
      candidatesScanned: 0,
      candidatesIncluded: 0,
      truncated: false,
    },
  };
}

function promptEntryToCandidate(
  entry: PromptHistoryEntry,
  request: ProjectMemoryBriefRequest,
  projectKey: string,
  queryTokens: Set<string>,
): BriefCandidate {
  const overlap = countTokenOverlap(queryTokens, entry.text);
  return {
    sourceId: `prompt:${entry.id}`,
    sourceType: 'prompt-history',
    section: 'prompts',
    text: cleanSnippet(entry.text, SNIPPET_CHARS),
    timestamp: entry.createdAt,
    provider: entry.provider,
    model: entry.model,
    projectPath: projectKey,
    score: 70 + overlap * 15 + recencyBoost(entry.createdAt) + providerModelBoost(entry, request),
    sourceRank: 1,
    metadata: {
      entryId: entry.id,
      wasSlashCommand: entry.wasSlashCommand,
    },
  };
}

function historySnippetToCandidate(
  entry: ConversationHistoryEntry,
  snippet: HistorySnippet,
  request: ProjectMemoryBriefRequest,
  projectKey: string,
  queryTokens: Set<string>,
): BriefCandidate {
  const overlap = countTokenOverlap(queryTokens, snippet.excerpt);
  return {
    sourceId: `history:${entry.id}:${snippet.position}`,
    sourceType: 'history-transcript',
    section: 'history',
    text: cleanSnippet(snippet.excerpt, SNIPPET_CHARS),
    timestamp: entry.endedAt,
    provider: entry.provider,
    model: entry.currentModel,
    projectPath: projectKey,
    title: entry.displayName,
    score: 85 + overlap * 18 + snippet.score * 10 + recencyBoost(entry.endedAt) + providerModelBoost({
      provider: entry.provider,
      model: entry.currentModel,
    }, request),
    sourceRank: 2,
    metadata: {
      entryId: entry.id,
      position: snippet.position,
      historyThreadId: entry.historyThreadId,
      sessionId: entry.sessionId,
      originalInstanceId: entry.originalInstanceId,
    },
  };
}

function recallResultToCandidate(
  result: SessionRecallResult,
  excerpt: string,
  request: ProjectMemoryBriefRequest,
  projectKey: string,
  queryTokens: Set<string>,
): BriefCandidate {
  const overlap = countTokenOverlap(queryTokens, excerpt);
  const provider = typeof result.metadata?.['provider'] === 'string'
    ? result.metadata['provider']
    : undefined;
  const model = typeof result.metadata?.['model'] === 'string'
    ? result.metadata['model']
    : undefined;
  const entryId = typeof result.metadata?.['entryId'] === 'string'
    ? result.metadata['entryId']
    : result.id;
  const position = typeof result.metadata?.['position'] === 'number'
    ? result.metadata['position']
    : result.id;

  return {
    sourceId: `history:${entryId}:${position}`,
    sourceType: 'history-transcript',
    section: 'history',
    text: cleanSnippet(excerpt, SNIPPET_CHARS),
    timestamp: result.timestamp,
    provider,
    model,
    projectPath: projectKey,
    title: result.title,
    score: 80 + overlap * 16 + result.score * 10 + recencyBoost(result.timestamp) + providerModelBoost({
      provider,
      model,
    }, request),
    sourceRank: 2,
    metadata: {
      ...result.metadata,
      recallResultId: result.id,
      sourceLink: result.sourceLink,
    },
  };
}

function buildStructuredBrief(candidates: BriefCandidate[]): {
  sections: ProjectMemoryBriefSection[];
  sources: ProjectMemoryBriefSource[];
} {
  const sectionsByKey = new Map<BriefCandidate['section'], ProjectMemoryBriefSection>();
  const sources: ProjectMemoryBriefSource[] = [];

  for (const candidate of candidates) {
    const sectionTitle = candidate.section === 'prompts'
      ? 'Recent relevant prompts'
      : 'Relevant prior chat excerpts';
    const section = sectionsByKey.get(candidate.section) ?? {
      title: sectionTitle,
      items: [],
    };
    section.items.push({
      sourceId: candidate.sourceId,
      text: candidate.text,
      timestamp: candidate.timestamp,
      provider: candidate.provider,
      model: candidate.model,
    });
    sectionsByKey.set(candidate.section, section);

    sources.push({
      id: candidate.sourceId,
      type: candidate.sourceType,
      title: candidate.title,
      timestamp: candidate.timestamp,
      provider: candidate.provider,
      model: candidate.model,
      projectPath: candidate.projectPath,
      metadata: candidate.metadata,
    });
  }

  return {
    sections: ['prompts', 'history']
      .map(key => sectionsByKey.get(key as BriefCandidate['section']))
      .filter((section): section is ProjectMemoryBriefSection => Boolean(section)),
    sources,
  };
}

function renderBrief(input: {
  projectKey: string;
  sections: ProjectMemoryBriefSection[];
  sources: ProjectMemoryBriefSource[];
  maxChars: number;
}): { text: string; truncated: boolean } {
  if (input.sources.length === 0) {
    return { text: '', truncated: false };
  }

  const lines = [
    '## Project Memory Brief',
    '',
    `Project: ${input.projectKey}`,
    'Scope: prior local chats and prompts for this project only',
    '',
  ];
  let truncated = false;

  for (const section of input.sections) {
    lines.push(`${section.title}:`);
    for (const item of section.items) {
      const prefix = `- ${formatSourceLabel(item)} `;
      const bullet = `${prefix}${item.text}`;
      const candidate = [...lines, bullet, ''].join('\n');
      if (candidate.length > input.maxChars) {
        const available = input.maxChars - [...lines, `${prefix}...`, ''].join('\n').length;
        if (available > 40) {
          lines.push(`${prefix}${item.text.slice(0, available - 3).trim()}...`);
        }
        lines.push('... (more project memory available via old-chat search)');
        truncated = true;
        return {
          text: finalizeRenderedLines(lines, input.maxChars),
          truncated,
        };
      }
      lines.push(bullet);
    }
    lines.push('');
  }

  lines.push(
    'Use this as recall context. Prefer current repository files and direct user instructions when they conflict with old memory.',
  );

  const text = lines.join('\n').trim();
  if (text.length <= input.maxChars) {
    return { text, truncated };
  }

  truncated = true;
  return {
    text: finalizeRenderedLines([
      ...lines.slice(0, -1),
      '... (more project memory available via old-chat search)',
    ], input.maxChars),
    truncated,
  };
}

function finalizeRenderedLines(lines: string[], maxChars: number): string {
  const marker = '... (more project memory available via old-chat search)';
  let text = lines.join('\n').trim();
  if (text.length <= maxChars) {
    return text;
  }

  const truncated = text.slice(0, Math.max(0, maxChars - marker.length - 2)).trimEnd();
  text = `${truncated}\n${marker}`;
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function formatSourceLabel(item: ProjectMemoryBriefSectionItem): string {
  const date = item.timestamp ? new Date(item.timestamp).toISOString().slice(0, 10) : 'unknown date';
  const provider = formatProvider(item.provider);
  const model = item.model ? `/${item.model}` : '';
  return `[${date}${provider ? ` ${provider}${model}` : ''}]`;
}

function formatProvider(provider: string | undefined): string {
  if (!provider) {
    return '';
  }
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function dedupeCandidates(candidates: BriefCandidate[]): BriefCandidate[] {
  const byText = new Map<string, BriefCandidate>();
  for (const candidate of candidates) {
    const key = normalizeCandidateText(candidate.text);
    if (!key) {
      continue;
    }

    const previous = byText.get(key);
    if (
      !previous
      || candidate.sourceRank > previous.sourceRank
      || (
        candidate.sourceRank === previous.sourceRank
        && candidate.score > previous.score
      )
    ) {
      byText.set(key, candidate);
    }
  }
  return [...byText.values()];
}

function normalizeCandidateText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function cleanSnippet(text: string, maxChars: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxChars) {
    return cleaned;
  }
  return `${cleaned.slice(0, maxChars - 3).trim()}...`;
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/\W+/u)
      .filter(token => token.length >= MIN_TOKEN_LENGTH),
  );
}

function countTokenOverlap(queryTokens: Set<string>, text: string): number {
  if (queryTokens.size === 0) {
    return 0;
  }
  const textTokens = tokenize(text);
  let overlap = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap;
}

function recencyBoost(timestamp: number): number {
  const ageMs = Math.max(0, Date.now() - timestamp);
  const oneDayMs = 24 * 60 * 60 * 1000;
  if (ageMs <= oneDayMs) return 10;
  if (ageMs <= 7 * oneDayMs) return 6;
  if (ageMs <= 30 * oneDayMs) return 3;
  return 1;
}

function providerModelBoost(
  source: { provider?: string; model?: string },
  request: Pick<ProjectMemoryBriefRequest, 'provider' | 'model'>,
): number {
  let boost = 0;
  if (source.provider && request.provider && source.provider === request.provider) {
    boost += 2;
  }
  if (source.model && request.model && source.model === request.model) {
    boost += 1;
  }
  return boost;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function countSources(sources: ProjectMemoryBriefSource[]): Record<ProjectMemoryBriefSourceType, number> {
  return sources.reduce<Record<ProjectMemoryBriefSourceType, number>>(
    (counts, source) => {
      counts[source.type] += 1;
      return counts;
    },
    {
      'prompt-history': 0,
      'history-transcript': 0,
    },
  );
}

let instance: ProjectMemoryBriefService | null = null;

export function getProjectMemoryBriefService(): ProjectMemoryBriefService {
  instance ??= new ProjectMemoryBriefService();
  return instance;
}

export function _resetProjectMemoryBriefServiceForTesting(): void {
  instance = null;
}
