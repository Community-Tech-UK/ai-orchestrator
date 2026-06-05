import { getRLMDatabase } from '../persistence/rlm-database';
import {
  recordProjectMemoryStartupBrief,
  type RecordProjectMemoryStartupBriefParams,
} from '../persistence/rlm/rlm-project-memory-briefs';
import {
  getProjectKnowledgeReadModelService,
  type ProjectKnowledgeReadModelService,
} from './project-knowledge-read-model';
import { normalizeProjectMemoryKey } from './project-memory-key';
import type {
  ProjectCodeSymbol,
  ProjectKnowledgeFact,
  ProjectKnowledgeReadModel,
  ProjectKnowledgeWakeHintItem,
} from '../../shared/types/knowledge-graph.types';
import type {
  ProjectMemoryBrief,
  ProjectMemoryBriefRequest,
  ProjectMemoryBriefSection,
  ProjectMemoryBriefSectionItem,
  ProjectMemoryBriefSource,
} from './project-memory-brief';

const DEFAULT_MAX_CHARS = 1600;
const DEFAULT_MAX_RESULTS = 8;

type ProjectKnowledgeDep = Pick<ProjectKnowledgeReadModelService, 'getReadModel'>;
type WorkerBriefRecorder = (params: RecordProjectMemoryStartupBriefParams) => void;

export interface ProjectMemoryBriefWorkerDeps {
  projectKnowledge?: ProjectKnowledgeDep;
  recorder?: WorkerBriefRecorder;
}

interface WorkerBriefCandidate {
  source: ProjectMemoryBriefSource;
  sectionTitle: string;
  item: ProjectMemoryBriefSectionItem;
  score: number;
  order: number;
}

export async function buildProjectMemoryBriefInWorker(
  request: ProjectMemoryBriefRequest,
  deps: ProjectMemoryBriefWorkerDeps = {},
): Promise<ProjectMemoryBrief> {
  const projectKey = normalizeProjectMemoryKey(request.projectPath);
  if (!projectKey) {
    return emptyBrief('');
  }

  const maxResults = clamp(Math.floor(request.maxResults ?? DEFAULT_MAX_RESULTS), 1, 20);
  const maxChars = clamp(Math.floor(request.maxChars ?? DEFAULT_MAX_CHARS), 500, 5000);
  const queryTokens = tokenize(request.initialPrompt ?? '');
  const projectKnowledge = deps.projectKnowledge ?? getProjectKnowledgeReadModelService();

  let readModel: ProjectKnowledgeReadModel;
  try {
    readModel = projectKnowledge.getReadModel(projectKey);
  } catch {
    return emptyBrief(projectKey);
  }

  const candidates = [
    ...codeIndexCandidates(readModel, projectKey),
    ...readModel.facts.map((fact) => factCandidate(fact, projectKey, queryTokens)),
    ...readModel.wakeHints.map((hint) => wakeHintCandidate(hint, projectKey, queryTokens)),
    ...readModel.codeSymbols.map((symbol) => codeSymbolCandidate(symbol, projectKey, queryTokens)),
  ].filter((candidate): candidate is WorkerBriefCandidate => Boolean(candidate));

  const selected = candidates
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, maxResults)
    .sort((a, b) => a.order - b.order);
  const { sections, sources } = groupSelected(selected);
  const rendered = renderWorkerBrief(sections, maxChars);
  const brief: ProjectMemoryBrief = {
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

  if (request.instanceId) {
    try {
      const recorder = deps.recorder ?? defaultRecorder;
      recorder({
        instanceId: request.instanceId,
        projectKey,
        renderedText: brief.text,
        sections,
        sources,
        maxChars,
        truncated: rendered.truncated,
        provider: request.provider,
        model: request.model,
        metadata: {
          source: 'context-worker',
          candidatesScanned: candidates.length,
          candidatesIncluded: selected.length,
        },
      });
    } catch {
      // Startup brief recording is diagnostic only; never fail context assembly.
    }
  }

  return brief;
}

function defaultRecorder(params: RecordProjectMemoryStartupBriefParams): void {
  recordProjectMemoryStartupBrief(getRLMDatabase().getRawDb(), params);
}

function codeIndexCandidates(
  readModel: ProjectKnowledgeReadModel,
  projectKey: string,
): WorkerBriefCandidate[] {
  const status = readModel.codeIndex;
  if (status.status === 'never') {
    return [];
  }
  const text = `Code index ${status.status}: ${status.fileCount} files, ${status.symbolCount} symbols.`;
  return [{
    source: {
      id: `code-index:${projectKey}`,
      type: 'code-index-status',
      projectPath: projectKey,
      metadata: {
        status: status.status,
        fileCount: status.fileCount,
        symbolCount: status.symbolCount,
      },
    },
    sectionTitle: 'Source-backed project memory',
    item: {
      sourceId: `code-index:${projectKey}`,
      text,
      label: 'Code index',
      timestamp: status.updatedAt,
    },
    score: 0.5,
    order: 0,
  }];
}

function factCandidate(
  fact: ProjectKnowledgeFact,
  projectKey: string,
  queryTokens: Set<string>,
): WorkerBriefCandidate {
  const text = `${fact.subject} ${fact.predicate} ${fact.object}.`;
  const label = fact.sourceFile ? `Fact from ${fact.sourceFile}` : 'Project fact';
  return {
    source: {
      id: `fact:${fact.targetId}`,
      type: 'project-fact',
      title: label,
      projectPath: projectKey,
      metadata: {
        targetId: fact.targetId,
        confidence: fact.confidence,
        evidenceCount: fact.evidenceCount,
        sourceFile: fact.sourceFile,
      },
    },
    sectionTitle: 'Source-backed project memory',
    item: {
      sourceId: `fact:${fact.targetId}`,
      text,
      label,
      provider: undefined,
      model: undefined,
    },
    score: 2 + tokenOverlapScore(text, queryTokens) + fact.confidence,
    order: 1,
  };
}

function wakeHintCandidate(
  hint: ProjectKnowledgeWakeHintItem,
  projectKey: string,
  queryTokens: Set<string>,
): WorkerBriefCandidate {
  return {
    source: {
      id: `wake:${hint.targetId}`,
      type: 'project-wake-hint',
      timestamp: hint.createdAt,
      projectPath: projectKey,
      metadata: {
        targetId: hint.targetId,
        importance: hint.importance,
        evidenceCount: hint.evidenceCount,
      },
    },
    sectionTitle: 'Source-backed project memory',
    item: {
      sourceId: `wake:${hint.targetId}`,
      text: hint.content,
      label: 'Wake hint',
      timestamp: hint.createdAt,
    },
    score: 1.5 + tokenOverlapScore(hint.content, queryTokens) + hint.importance,
    order: 2,
  };
}

function codeSymbolCandidate(
  symbol: ProjectCodeSymbol,
  projectKey: string,
  queryTokens: Set<string>,
): WorkerBriefCandidate {
  const text = `${symbol.kind} ${symbol.name} in ${symbol.pathFromRoot}:${symbol.startLine}.`;
  return {
    source: {
      id: `symbol:${symbol.id}`,
      type: 'code-symbol',
      title: symbol.name,
      projectPath: projectKey,
      metadata: {
        pathFromRoot: symbol.pathFromRoot,
        kind: symbol.kind,
        startLine: symbol.startLine,
      },
    },
    sectionTitle: 'Source-backed project memory',
    item: {
      sourceId: `symbol:${symbol.id}`,
      text,
      label: symbol.name,
    },
    score: 1 + tokenOverlapScore(text, queryTokens),
    order: 3,
  };
}

function groupSelected(selected: WorkerBriefCandidate[]): {
  sections: ProjectMemoryBriefSection[];
  sources: ProjectMemoryBriefSource[];
} {
  const sectionMap = new Map<string, ProjectMemoryBriefSection>();
  const sources: ProjectMemoryBriefSource[] = [];
  const seenSources = new Set<string>();

  for (const candidate of selected) {
    if (!seenSources.has(candidate.source.id)) {
      sources.push(candidate.source);
      seenSources.add(candidate.source.id);
    }
    let section = sectionMap.get(candidate.sectionTitle);
    if (!section) {
      section = { title: candidate.sectionTitle, items: [] };
      sectionMap.set(candidate.sectionTitle, section);
    }
    section.items.push(candidate.item);
  }

  return { sections: Array.from(sectionMap.values()), sources };
}

function renderWorkerBrief(
  sections: ProjectMemoryBriefSection[],
  maxChars: number,
): { text: string; truncated: boolean } {
  if (sections.length === 0) {
    return { text: '', truncated: false };
  }
  const lines = ['## Project Memory Brief'];
  for (const section of sections) {
    lines.push('', `### ${section.title}`);
    for (const item of section.items) {
      lines.push(`- ${item.label ? `[${item.label}] ` : ''}${item.text}`);
    }
  }
  const text = lines.join('\n').trim();
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, Math.max(0, maxChars - 14)).trimEnd()}\n...[truncated]`, truncated: true };
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

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_/-]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  );
}

function tokenOverlapScore(text: string, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  const tokens = tokenize(text);
  let score = 0;
  for (const token of queryTokens) {
    if (tokens.has(token)) score += 0.25;
  }
  return score;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
