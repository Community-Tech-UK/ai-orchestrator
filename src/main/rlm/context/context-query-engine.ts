/**
 * Context Query Engine Module
 *
 * Handles query execution and dispatching:
 * - Query routing by type
 * - Summarization execution
 * - Sub-query execution
 */

import type {
  ContextStore,
  ContextQuery,
  ContextQueryResult,
  RLMSession,
  RLMConfig,
  RecursiveCall
} from '../../../shared/types/rlm.types';
import type { VectorStore } from '../vector-store';
import type { HyDEService } from '../hyde-service';
import type {
  GrepParams,
  SliceParams,
  GetSectionParams,
  SummarizeParams,
  SubQueryParams,
  SemanticSearchParams,
  SubQueryResult
} from './context.types';
import { estimateTokens, generateShortId } from './context.utils';
import {
  executeGrep,
  executeSlice,
  getSection,
  executeSemanticSearch,
  type SearchDependencies
} from './context-search';
import { persistSummary, type StorageDependencies } from './context-storage';

/**
 * Dependencies for query engine
 */
export interface QueryEngineDependencies {
  vectorStore: VectorStore | null;
  hydeService: HyDEService | null;
  config: RLMConfig;
  tokenEstimator?: (text: string) => number;
  onSummarizeRequest?: (request: {
    sessionId: string;
    content: string;
    targetTokens: number;
    callback: (summary: string) => void;
  }) => void;
  onSubQueryRequest?: (request: {
    sessionId: string;
    callId: string;
    prompt: string;
    context: string;
    depth: number;
    callback: (
      response: string,
      tokens: { input: number; output: number }
    ) => void;
  }) => void;
  onHyDE?: (event: {
    query: string;
    hydeResult: {
      used: boolean;
      cached: boolean;
      generationTimeMs: number;
      hypotheticalPreview?: string;
    };
  }) => void;
  storageDeps: StorageDependencies;
}

/**
 * Execute a query against a store.
 *
 * @param session - Active session
 * @param store - Store to query
 * @param query - Query to execute
 * @param depth - Recursion depth (0 = root)
 * @param deps - Query engine dependencies
 * @returns Query result
 */
export async function executeQuery(
  session: RLMSession,
  store: ContextStore,
  query: ContextQuery,
  depth: number,
  deps: QueryEngineDependencies
): Promise<ContextQueryResult> {
  const startTime = Date.now();
  let result: string;
  let sectionsAccessed: string[] = [];
  let subQueries: ContextQueryResult[] = [];

  const searchDeps: SearchDependencies = {
    vectorStore: deps.vectorStore,
    hydeService: deps.hydeService,
    searchWindowSize: deps.config.searchWindowSize
  };

  switch (query.type) {
    case 'grep':
      ({ result, sectionsAccessed } = executeGrep(
        store,
        query.params as unknown as GrepParams,
        deps.config.searchWindowSize
      ));
      break;

    case 'slice':
      ({ result, sectionsAccessed } = executeSlice(
        store,
        query.params as unknown as SliceParams
      ));
      break;

    case 'get_section':
      ({ result, sectionsAccessed } = getSection(
        store,
        (query.params as unknown as GetSectionParams).sectionId
      ));
      break;

    case 'summarize':
      result = await executeSummarize(
        session,
        store,
        query.params as unknown as SummarizeParams,
        deps
      );
      sectionsAccessed = (query.params as unknown as SummarizeParams).sectionIds;
      break;

    case 'sub_query': {
      const subResult = await executeSubQuery(
        session,
        store,
        query.params as unknown as SubQueryParams,
        depth,
        deps
      );
      result = subResult.result;
      sectionsAccessed = subResult.sectionsAccessed;
      subQueries = subResult.subQueries || [];
      break;
    }

    case 'semantic_search':
      ({ result, sectionsAccessed } = await executeSemanticSearch(
        store,
        query.params as unknown as SemanticSearchParams,
        searchDeps,
        deps.onHyDE
      ));
      break;

    default:
      throw new Error(`Unknown query type: ${query.type}`);
  }

  const tokenEstimator = deps.tokenEstimator || estimateTokens;
  const tokensUsed =
    query.type === 'sub_query' ? 0 : tokenEstimator(result);

  const queryResult: ContextQueryResult = {
    query,
    result,
    tokensUsed,
    sectionsAccessed,
    duration: Date.now() - startTime,
    subQueries,
    depth
  };

  return queryResult;
}

/**
 * Execute summarization query.
 */
async function executeSummarize(
  session: RLMSession,
  store: ContextStore,
  params: SummarizeParams,
  deps: QueryEngineDependencies
): Promise<string> {
  const sections = store.sections.filter((s) =>
    params.sectionIds.includes(s.id)
  );
  const content = sections
    .map((s) => `## ${s.name}\n${s.content}`)
    .join('\n\n---\n\n');

  const totalTokens = sections.reduce((sum, s) => sum + s.tokens, 0);
  const targetTokens = Math.ceil(
    totalTokens * deps.config.summaryTargetRatio
  );

  return new Promise((resolve) => {
    let resolved = false;

    if (deps.onSummarizeRequest) {
      deps.onSummarizeRequest({
        sessionId: session.id,
        content,
        targetTokens,
        callback: (summary: string) => {
          if (resolved) return;
          resolved = true;

          // Store the summary as a new section
          persistSummary(
            store,
            summary,
            params.sectionIds,
            sections,
            deps.storageDeps
          );

          resolve(summary);
        }
      });
    }

    // Fallback if not handled
    setTimeout(() => {
      if (resolved) return;
      resolved = true;

      const fallbackSummary = `[Summary of ${sections.length} sections, ~${totalTokens} tokens → ~${targetTokens} target tokens]\n\nKey content from: ${sections.map((s) => s.name).join(', ')}`;

      // Store even the fallback summary
      persistSummary(
        store,
        fallbackSummary,
        params.sectionIds,
        sections,
        deps.storageDeps
      );

      resolve(fallbackSummary);
    }, 5000);
  });
}

/**
 * Execute sub-query with LLM.
 */
async function executeSubQuery(
  session: RLMSession,
  store: ContextStore,
  params: SubQueryParams,
  depth: number,
  deps: QueryEngineDependencies
): Promise<SubQueryResult> {
  if (depth >= deps.config.maxRecursionDepth) {
    return {
      result: '[Max recursion depth reached. Please refine your query.]',
      sectionsAccessed: []
    };
  }

  // Build context window from hints or use summaries
  let contextWindow = '';
  let sectionsAccessed: string[] = [];

  if (params.contextHints && params.contextHints.length > 0) {
    // Search for relevant context based on hints
    for (const hint of params.contextHints.slice(0, 3)) {
      const grepResult = executeGrep(
        store,
        { pattern: hint, maxResults: 3 },
        deps.config.searchWindowSize
      );
      contextWindow += grepResult.result + '\n\n';
      sectionsAccessed.push(...grepResult.sectionsAccessed);
    }
  } else {
    // Use top-level summaries if available
    const summaries = store.sections.filter(
      (s) => s.type === 'summary' && s.depth === 1
    );
    if (summaries.length > 0) {
      contextWindow = summaries.map((s) => s.content).join('\n\n---\n\n');
      sectionsAccessed = summaries.map((s) => s.id);
    } else {
      // Fall back to section names overview
      const overview = store.sections
        .filter((s) => s.depth === 0)
        .map((s) => `- ${s.name} (${s.tokens} tokens, ${s.type})`)
        .join('\n');
      contextWindow = `Available sections:\n${overview}`;
    }
  }

  // Create recursive call record
  const recursiveCall: RecursiveCall = {
    id: generateShortId('rc'),
    parentId:
      session.recursiveCalls.length > 0
        ? session.recursiveCalls[session.recursiveCalls.length - 1].id
        : undefined,
    depth: depth + 1,
    prompt: params.prompt,
    contextWindow: contextWindow.slice(0, 2000),
    tokens: { input: 0, output: 0 },
    duration: 0,
    status: 'pending'
  };
  session.recursiveCalls.push(recursiveCall);

  return new Promise((resolve) => {
    recursiveCall.status = 'running';
    const startTime = Date.now();

    if (deps.onSubQueryRequest) {
      deps.onSubQueryRequest({
        sessionId: session.id,
        callId: recursiveCall.id,
        prompt: params.prompt,
        context: contextWindow,
        depth: depth + 1,
        callback: (
          response: string,
          tokens: { input: number; output: number }
        ) => {
          recursiveCall.response = response;
          recursiveCall.tokens = tokens;
          recursiveCall.duration = Date.now() - startTime;
          recursiveCall.status = 'completed';

          session.totalSubQueryTokens += tokens.input + tokens.output;

          resolve({
            result: response,
            sectionsAccessed
          });
        }
      });
    }

    // Timeout handler
    setTimeout(() => {
      if (recursiveCall.status === 'running') {
        recursiveCall.status = 'failed';
        resolve({
          result: '[Sub-query timed out]',
          sectionsAccessed
        });
      }
    }, deps.config.subQueryTimeout);
  });
}
