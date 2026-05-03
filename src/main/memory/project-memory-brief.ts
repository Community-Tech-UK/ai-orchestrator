import { getLogger } from '../logging/logger';
import type { PromptHistoryEntry } from '../../shared/types/prompt-history.types';
import type { ConversationHistoryEntry, HistorySnippet } from '../../shared/types/history.types';
import type { SessionRecallResult } from '../../shared/types/session-recall.types';
import { getPromptHistoryService, type PromptHistoryService } from '../prompt-history/prompt-history-service';
import { getHistoryManager, type HistoryManager } from '../history/history-manager';
import { getTranscriptSnippetService, type TranscriptSnippetService } from '../history/transcript-snippet-service';
import { getSessionRecallService, type SessionRecallService } from '../session/session-recall-service';
import { getRLMDatabase } from '../persistence/rlm-database';
import {
  recordProjectMemoryStartupBrief,
  type RecordProjectMemoryStartupBriefParams,
} from '../persistence/rlm/rlm-project-memory-briefs';
import {
  getProjectKnowledgeReadModelService,
  type ProjectKnowledgeReadModelService,
} from './project-knowledge-read-model';
import { normalizeProjectMemoryKey, projectMemoryKeysEqual } from './project-memory-key';
import type {
  ProjectCodeSymbol,
  ProjectKnowledgeFact,
  ProjectKnowledgeReadModel,
  ProjectKnowledgeWakeHintItem,
} from '../../shared/types/knowledge-graph.types';

const logger = getLogger('ProjectMemoryBriefService');

const DEFAULT_MAX_CHARS = 1600;
const DEFAULT_MAX_RESULTS = 8;
const HISTORY_SCAN_MULTIPLIER = 4;
const HISTORY_EXPAND_LIMIT = 6;
const HISTORY_SNIPPETS_PER_ENTRY = 2;
const SNIPPET_CHARS = 260;
const MIN_TOKEN_LENGTH = 3;
const SOURCE_BACKED_RESERVED_RATIO = 0.5;
const CODE_SYMBOL_FALLBACK_LIMIT = 12;
const PROJECT_KNOWLEDGE_READ_WARN_MS = 250;

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

export type ProjectMemoryBriefSourceType =
  | 'prompt-history'
  | 'history-transcript'
  | 'project-fact'
  | 'project-wake-hint'
  | 'code-index-status'
  | 'code-symbol';

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
  label?: string;
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
type ProjectMemoryKnowledgeDep = Pick<ProjectKnowledgeReadModelService, 'getReadModel'>;
export type ProjectMemoryBriefRecorder = (params: RecordProjectMemoryStartupBriefParams) => void;

interface ProjectMemoryBriefDeps {
  promptHistory?: ProjectMemoryPromptHistoryDep;
  history?: ProjectMemoryHistoryDep;
  snippets?: ProjectMemorySnippetDep;
  recall?: ProjectMemoryRecallDep;
  projectKnowledge?: ProjectMemoryKnowledgeDep;
  recorder?: ProjectMemoryBriefRecorder;
}

type BriefSectionKey = 'facts' | 'codeIndex' | 'codeSymbols' | 'wakeHints' | 'prompts' | 'history';

interface BriefCandidate {
  sourceId: string;
  sourceType: ProjectMemoryBriefSourceType;
  section: BriefSectionKey;
  text: string;
  label?: string;
  timestamp: number;
  provider?: string;
  model?: string;
  projectPath: string;
  title?: string;
  score: number;
  sourceRank: number;
  metadata?: Record<string, unknown>;
}

function defaultRecordProjectMemoryStartupBrief(params: RecordProjectMemoryStartupBriefParams): void {
  recordProjectMemoryStartupBrief(getRLMDatabase().getRawDb(), params);
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

    candidates.push(...this.collectProjectKnowledgeCandidates(request, projectKey, queryTokens));
    candidates.push(...this.collectPromptCandidates(request, projectKey, queryTokens));
    candidates.push(...await this.collectHistoryCandidates(request, projectKey, queryTokens, maxResults));
    candidates.push(...await this.collectRecallCandidates(request, projectKey, queryTokens, maxResults));

    const deduped = dedupeCandidates(candidates);
    const selected = selectCandidates(deduped, maxResults);
    const { sections, sources } = buildStructuredBrief(selected);
    const rendered = renderBrief({
      projectKey,
      sections,
      sources,
      maxChars,
    });
    const sourceCounts = countSources(sources);

    if (request.instanceId) {
      try {
        const recorder = this.deps.recorder ?? defaultRecordProjectMemoryStartupBrief;
        recorder({
          instanceId: request.instanceId,
          projectKey,
          renderedText: rendered.text,
          sections,
          sources,
          maxChars,
          truncated: rendered.truncated,
          provider: request.provider,
          model: request.model,
          metadata: {
            candidatesScanned: candidates.length,
            candidatesDeduped: deduped.length,
            candidatesIncluded: selected.length,
            sourceCounts,
          },
        });
      } catch (error) {
        logger.warn('Failed to record project memory startup brief', {
          projectKey,
          instanceId: request.instanceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.debug('Built project memory brief', {
      projectKey,
      candidatesScanned: candidates.length,
      candidatesIncluded: selected.length,
      sourceCounts,
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

  private collectProjectKnowledgeCandidates(
    request: ProjectMemoryBriefRequest,
    projectKey: string,
    queryTokens: Set<string>,
  ): BriefCandidate[] {
    if (request.includeMinedMemory === false) {
      return [];
    }

    const projectKnowledge = this.deps.projectKnowledge ?? getProjectKnowledgeReadModelService();
    const startedAt = Date.now();
    let readModel: ProjectKnowledgeReadModel;
    try {
      readModel = projectKnowledge.getReadModel(projectKey);
    } catch (error) {
      logger.warn('Failed to collect source-backed project memory candidates', {
        projectKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    } finally {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs > PROJECT_KNOWLEDGE_READ_WARN_MS) {
        logger.warn('Project knowledge read model was slow during startup brief packing', {
          projectKey,
          elapsedMs,
        });
      }
    }

    return [
      ...codeIndexStatusToCandidates(readModel, projectKey),
      ...readModel.facts.map((fact) => factToCandidate(fact, projectKey, queryTokens)),
      ...readModel.wakeHints.map((hint) => wakeHintToCandidate(hint, projectKey, queryTokens)),
      ...codeSymbolCandidates(readModel, projectKey, queryTokens),
    ];
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

function codeIndexStatusToCandidates(
  readModel: ProjectKnowledgeReadModel,
  projectKey: string,
): BriefCandidate[] {
  const status = readModel.codeIndex;
  if (status.status === 'never') {
    return [];
  }

  const indexedDate = status.lastSyncedAt
    ? new Date(status.lastSyncedAt).toISOString().slice(0, 10)
    : 'not synced yet';
  const text = cleanSnippet(
    `${status.fileCount} files, ${status.symbolCount} symbols indexed ${indexedDate}.`,
    SNIPPET_CHARS,
  );

  return [{
    sourceId: `code-index:${projectKey}`,
    sourceType: 'code-index-status',
    section: 'codeIndex',
    text,
    label: `code-index ${status.status}`,
    timestamp: status.lastSyncedAt ?? status.updatedAt,
    projectPath: projectKey,
    score: 88,
    sourceRank: 5,
    metadata: {
      status: status.status,
      fileCount: status.fileCount,
      symbolCount: status.symbolCount,
      lastSyncedAt: status.lastSyncedAt,
      workspaceHash: status.workspaceHash,
      error: status.error,
    },
  }];
}

function factToCandidate(
  fact: ProjectKnowledgeFact,
  projectKey: string,
  queryTokens: Set<string>,
): BriefCandidate {
  const factText = cleanSnippet(
    `${fact.subject} ${formatPredicate(fact.predicate)} ${fact.object}.`,
    SNIPPET_CHARS,
  );
  const overlap = countTokenOverlap(queryTokens, factText);
  const confidencePercent = Math.round(fact.confidence * 100);

  return {
    sourceId: `fact:${fact.targetId}`,
    sourceType: 'project-fact',
    section: 'facts',
    text: factText,
    label: `fact src:${fact.evidenceCount} conf:${confidencePercent}%`,
    timestamp: Date.parse(fact.validFrom ?? '') || 0,
    projectPath: projectKey,
    score: 100 + overlap * 15 + fact.confidence * 10 + Math.min(fact.evidenceCount, 5),
    sourceRank: 6,
    metadata: {
      targetKind: 'kg_triple',
      targetId: fact.targetId,
      evidenceCount: fact.evidenceCount,
      confidence: fact.confidence,
      sourceFile: fact.sourceFile,
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
    },
  };
}

function wakeHintToCandidate(
  hint: ProjectKnowledgeWakeHintItem,
  projectKey: string,
  queryTokens: Set<string>,
): BriefCandidate {
  const text = cleanSnippet(hint.content, SNIPPET_CHARS);
  const overlap = countTokenOverlap(queryTokens, text);

  return {
    sourceId: `wake:${hint.targetId}`,
    sourceType: 'project-wake-hint',
    section: 'wakeHints',
    text,
    label: `wake src:${hint.evidenceCount} imp:${hint.importance}`,
    timestamp: hint.createdAt,
    projectPath: projectKey,
    score: 72 + hint.importance + overlap * 12 + Math.min(hint.evidenceCount, 5),
    sourceRank: 4,
    metadata: {
      targetKind: 'wake_hint',
      targetId: hint.targetId,
      evidenceCount: hint.evidenceCount,
      importance: hint.importance,
      room: hint.room,
    },
  };
}

function codeSymbolCandidates(
  readModel: ProjectKnowledgeReadModel,
  projectKey: string,
  queryTokens: Set<string>,
): BriefCandidate[] {
  const statusAllowsSymbols = readModel.codeIndex.status === 'ready'
    || (readModel.codeIndex.status === 'indexing' && readModel.codeSymbols.length > 0);
  if (!statusAllowsSymbols) {
    return [];
  }

  const includeFallback = readModel.codeSymbols.length <= CODE_SYMBOL_FALLBACK_LIMIT;
  return readModel.codeSymbols.flatMap((symbol) => {
    const searchableText = [
      symbol.name,
      symbol.kind,
      symbol.containerName,
      symbol.pathFromRoot,
      symbol.signature,
      symbol.docComment,
    ].filter(Boolean).join(' ');
    const overlap = countTokenOverlap(queryTokens, searchableText);
    if (overlap === 0 && !includeFallback) {
      return [];
    }
    return [codeSymbolToCandidate(symbol, projectKey, overlap)];
  });
}

function codeSymbolToCandidate(
  symbol: ProjectCodeSymbol,
  projectKey: string,
  overlap: number,
): BriefCandidate {
  const location = `${symbol.pathFromRoot}:${symbol.startLine}`;
  const container = symbol.containerName ? ` in ${symbol.containerName}` : '';
  const text = cleanSnippet(`${symbol.name}${container} at ${location}`, SNIPPET_CHARS);

  return {
    sourceId: `symbol:${symbol.symbolId}`,
    sourceType: 'code-symbol',
    section: 'codeSymbols',
    text,
    label: `symbol ${symbol.kind} src:${symbol.evidenceCount}`,
    timestamp: symbol.updatedAt,
    projectPath: projectKey,
    score: 82 + overlap * 20,
    sourceRank: 5,
    metadata: {
      targetKind: 'code_symbol',
      targetId: symbol.targetId,
      workspaceHash: symbol.workspaceHash,
      pathFromRoot: symbol.pathFromRoot,
      symbolKind: symbol.kind,
      line: symbol.startLine,
      containerName: symbol.containerName,
    },
  };
}

function buildStructuredBrief(candidates: BriefCandidate[]): {
  sections: ProjectMemoryBriefSection[];
  sources: ProjectMemoryBriefSource[];
} {
  const sectionsByKey = new Map<BriefSectionKey, ProjectMemoryBriefSection>();
  const sources: ProjectMemoryBriefSource[] = [];

  for (const candidate of candidates) {
    const sectionTitle = sectionTitleForKey(candidate.section);
    const section = sectionsByKey.get(candidate.section) ?? {
      title: sectionTitle,
      items: [],
    };
    section.items.push({
      sourceId: candidate.sourceId,
      text: candidate.text,
      label: candidate.label,
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
    sections: ['facts', 'codeIndex', 'codeSymbols', 'wakeHints', 'prompts', 'history']
      .map(key => sectionsByKey.get(key as BriefSectionKey))
      .filter((section): section is ProjectMemoryBriefSection => Boolean(section)),
    sources,
  };
}

function sectionTitleForKey(key: BriefSectionKey): string {
  switch (key) {
    case 'facts':
      return 'Current source-backed facts';
    case 'codeIndex':
      return 'Current code index';
    case 'codeSymbols':
      return 'Relevant code symbols';
    case 'wakeHints':
      return 'Project wake hints';
    case 'prompts':
      return 'Recent relevant prompts';
    case 'history':
      return 'Relevant prior chat excerpts';
  }
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
    'Scope: current source-backed project memory plus prior local chats/prompts for this project only',
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
    'Use this as recall context. Prefer current repository files and direct user instructions when they conflict with memory. Verify important details against source files before editing.',
  );

  const text = redactProjectMemoryBriefText(lines.join('\n').trim());
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
  let text = redactProjectMemoryBriefText(lines.join('\n').trim());
  if (text.length <= maxChars) {
    return text;
  }

  const truncated = text.slice(0, Math.max(0, maxChars - marker.length - 2)).trimEnd();
  text = `${truncated}\n${marker}`;
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function formatSourceLabel(item: ProjectMemoryBriefSectionItem): string {
  if (item.label) {
    return `[${item.label}]`;
  }
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

function formatPredicate(predicate: string): string {
  return predicate.replace(/[_-]+/g, ' ');
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
      || compareDuplicatePreference(candidate, previous) < 0
    ) {
      byText.set(key, candidate);
    }
  }
  return [...byText.values()];
}

function selectCandidates(candidates: BriefCandidate[], maxResults: number): BriefCandidate[] {
  const sorted = [...candidates].sort(compareCandidates);
  const sourceBacked = sorted.filter(isSourceBackedCandidate);
  const reservedCount = sourceBacked.length > 0
    ? Math.min(sourceBacked.length, Math.ceil(maxResults * SOURCE_BACKED_RESERVED_RATIO))
    : 0;
  const selected = new Map<string, BriefCandidate>();

  for (const candidate of sourceBacked.slice(0, reservedCount)) {
    selected.set(candidate.sourceId, candidate);
  }
  for (const candidate of sorted) {
    if (selected.size >= maxResults) {
      break;
    }
    selected.set(candidate.sourceId, candidate);
  }

  return [...selected.values()].sort(compareCandidates);
}

function compareDuplicatePreference(left: BriefCandidate, right: BriefCandidate): number {
  return sourceTypePriority(right.sourceType) - sourceTypePriority(left.sourceType)
    || compareCandidates(left, right);
}

function compareCandidates(left: BriefCandidate, right: BriefCandidate): number {
  return right.score - left.score
    || right.sourceRank - left.sourceRank
    || right.timestamp - left.timestamp
    || left.sourceId.localeCompare(right.sourceId);
}

function sourceTypePriority(type: ProjectMemoryBriefSourceType): number {
  if (type === 'project-fact' || type === 'project-wake-hint' || type === 'code-index-status' || type === 'code-symbol') {
    return 3;
  }
  if (type === 'history-transcript') {
    return 2;
  }
  return 1;
}

function isSourceBackedCandidate(candidate: BriefCandidate): boolean {
  return sourceTypePriority(candidate.sourceType) === 3;
}

function normalizeCandidateText(text: string): string {
  return redactProjectMemoryBriefText(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

function cleanSnippet(text: string, maxChars: number): string {
  const cleaned = redactProjectMemoryBriefText(text).replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxChars) {
    return cleaned;
  }
  return `${cleaned.slice(0, maxChars - 3).trim()}...`;
}

export function redactProjectMemoryBriefText(text: string): string {
  let redacted = text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY_MARKER]')
    .replace(/-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY_MARKER]')
    .replace(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s]+)@/gi, '$1[REDACTED_CREDENTIALS]@')
    .replace(/\b(api[_-]?key|access[_-]?key|secret|token|password|passwd|pwd|private[_-]?key)\b\s*[:=]\s*["']?([^\s"']{3,})/gi, (_match, key: string) => `${key}=[REDACTED_SECRET]`);

  redacted = redacted.replace(
    /(^|[^A-Za-z0-9+/_=-])([A-Za-z0-9+/_=-]{32,})(?=$|[^A-Za-z0-9+/_=-])/g,
    (_match, prefix: string, value: string) => (
      `${prefix}${hasAtLeastThreeTokenClasses(value) ? '[REDACTED_TOKEN]' : value}`
    ),
  );
  return redacted;
}

function hasAtLeastThreeTokenClasses(value: string): boolean {
  if (value.includes('/') && value.split('/').length > 2) {
    return false;
  }
  const classes = [
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /\d/.test(value),
    /[+/_=-]/.test(value),
  ];
  return classes.filter(Boolean).length >= 3;
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
      'project-fact': 0,
      'project-wake-hint': 0,
      'code-index-status': 0,
      'code-symbol': 0,
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
