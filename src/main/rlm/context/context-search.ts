/**
 * Context Search Module
 *
 * Handles search operations:
 * - Grep (regex pattern matching)
 * - Semantic search (vector-based)
 * - Optimized search (bloom filter + grep)
 */

import type { ContextStore, ContextSection } from '../../../shared/types/rlm.types';
import type { VectorStore } from '../vector-store';
import type { HyDEService } from '../hyde-service';
import type {
  QueryResult,
  GrepParams,
  SemanticSearchParams,
  VectorSearchResult
} from './context.types';
import { cosineSimilarity } from './context.utils';
import { bloomMightContain } from './context-cache';
import { getLogger } from '../../logging/logger';

const logger = getLogger('ContextSearch');

/**
 * Dependencies for search operations
 */
export interface SearchDependencies {
  vectorStore: VectorStore | null;
  hydeService: HyDEService | null;
  searchWindowSize: number;
}

/**
 * Execute grep search with regex pattern matching.
 *
 * @param store - Store to search in
 * @param params - Grep parameters (pattern, maxResults)
 * @param searchWindowSize - Context window size around matches
 * @returns Query result with matches and sections accessed
 */
export function executeGrep(
  store: ContextStore,
  params: GrepParams,
  searchWindowSize: number
): QueryResult {
  const { pattern, maxResults = 10 } = params;

  // Validate regex pattern to prevent crashes
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'gi');
  } catch (error) {
    logger.warn('Invalid regex pattern, falling back to literal search', { error });
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    regex = new RegExp(escaped, 'gi');
  }

  const matches: {
    section: ContextSection;
    match: RegExpMatchArray;
    context: string;
  }[] = [];
  const sectionsAccessed: string[] = [];

  for (const section of store.sections) {
    if (section.depth > 0) continue; // Skip summaries

    const sectionMatches = [...section.content.matchAll(regex)];

    for (const match of sectionMatches) {
      if (matches.length >= maxResults) break;

      // Extract context around match
      const start = Math.max(0, match.index! - searchWindowSize);
      const end = Math.min(
        section.content.length,
        match.index! + match[0].length + searchWindowSize
      );
      const context = section.content.slice(start, end);

      matches.push({ section, match, context });
      if (!sectionsAccessed.includes(section.id)) {
        sectionsAccessed.push(section.id);
      }
    }

    if (matches.length >= maxResults) break;
  }

  const result = matches
    .map(
      (m, i) =>
        `[Match ${i + 1}] ${m.section.name} (${m.section.type}):\n...${m.context}...`
    )
    .join('\n\n---\n\n');

  return { result: result || 'No matches found.', sectionsAccessed };
}

/**
 * Execute slice operation to get content by byte offset.
 *
 * @param store - Store to slice from
 * @param params - Slice parameters (start, end offsets)
 * @returns Query result with sliced content
 */
export function executeSlice(
  store: ContextStore,
  params: { start: number; end: number }
): QueryResult {
  const { start, end } = params;
  const sectionsAccessed: string[] = [];
  let result = '';

  for (const section of store.sections) {
    if (section.depth > 0) continue;
    if (section.endOffset < start) continue;
    if (section.startOffset > end) break;

    const sliceStart = Math.max(0, start - section.startOffset);
    const sliceEnd = Math.min(
      section.content.length,
      end - section.startOffset
    );

    result += section.content.slice(sliceStart, sliceEnd);
    sectionsAccessed.push(section.id);
  }

  return { result, sectionsAccessed };
}

/**
 * Get a specific section by ID.
 *
 * @param store - Store to search in
 * @param sectionId - ID of section to retrieve
 * @returns Query result with section content
 */
export function getSection(
  store: ContextStore,
  sectionId: string
): QueryResult {
  const section = store.sections.find((s) => s.id === sectionId);
  if (!section) {
    return {
      result: `Section not found: ${sectionId}`,
      sectionsAccessed: []
    };
  }

  return {
    result: `[${section.name}] (${section.tokens} tokens)\n\n${section.content}`,
    sectionsAccessed: [section.id]
  };
}

/**
 * Execute semantic search using vector embeddings.
 * Falls back to keyword search if vector store unavailable.
 *
 * @param store - Store to search in
 * @param params - Semantic search parameters
 * @param deps - Search dependencies
 * @param onHyDE - Optional callback for HyDE events
 * @returns Query result with semantic matches
 */
export async function executeSemanticSearch(
  store: ContextStore,
  params: SemanticSearchParams,
  deps: SearchDependencies,
  onHyDE?: (event: {
    query: string;
    hydeResult: {
      used: boolean;
      cached: boolean;
      generationTimeMs: number;
      hypotheticalPreview?: string;
    };
  }) => void
): Promise<QueryResult> {
  const { query, topK = 5, minSimilarity = 0.5, useHyDE = true } = params;

  // Use vector store for semantic search if available
  if (deps.vectorStore) {
    try {
      // Use HyDE (Hypothetical Document Embeddings) for better search
      let searchEmbedding: number[] | undefined;
      let hydeInfo: { used: boolean; generationTimeMs: number } = {
        used: false,
        generationTimeMs: 0
      };

      if (useHyDE && deps.hydeService) {
        try {
          const hydeResult = await deps.hydeService.embed(query);
          if (hydeResult.hydeUsed) {
            searchEmbedding = hydeResult.embedding;
            hydeInfo = {
              used: true,
              generationTimeMs: hydeResult.generationTimeMs
            };
            onHyDE?.({
              query,
              hydeResult: {
                used: hydeResult.hydeUsed,
                cached: hydeResult.cached,
                generationTimeMs: hydeResult.generationTimeMs,
                hypotheticalPreview:
                  hydeResult.hypotheticalDocuments[0]?.substring(0, 200)
              }
            });
          }
        } catch (hydeError) {
          logger.warn('HyDE failed, using direct query embedding', { error: hydeError });
        }
      }

      // Search using HyDE embedding or standard search
      let searchResults;
      if (searchEmbedding) {
        searchResults = await vectorStoreSearchWithEmbedding(
          store.id,
          searchEmbedding,
          { topK, minSimilarity },
          deps.vectorStore
        );
      } else {
        searchResults = await deps.vectorStore.search(store.id, query, {
          topK,
          minSimilarity
        });
      }

      if (searchResults.length > 0) {
        const sectionsAccessed: string[] = [];
        const matches: string[] = [];

        for (const result of searchResults) {
          const section = store.sections.find(
            (s) => s.id === result.entry.sectionId
          );
          if (section) {
            sectionsAccessed.push(section.id);
            const hydeTag = hydeInfo.used ? ' [HyDE]' : '';
            matches.push(
              `[Similarity: ${(result.similarity * 100).toFixed(1)}%${hydeTag}] ${section.name} (${section.type}):\n...${result.entry.contentPreview}...`
            );
          }
        }

        return {
          result: matches.join('\n\n---\n\n') || 'No matches found.',
          sectionsAccessed
        };
      }
    } catch (error) {
      logger.error('Semantic search failed, falling back to keyword search', error instanceof Error ? error : undefined);
    }
  }

  // Fall back to keyword search
  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);
  const pattern = keywords.join('|');

  return executeGrep(store, { pattern, maxResults: topK }, deps.searchWindowSize);
}

/**
 * Search vector store using a precomputed embedding (used with HyDE).
 */
async function vectorStoreSearchWithEmbedding(
  storeId: string,
  embedding: number[],
  options: { topK: number; minSimilarity: number },
  vectorStore: VectorStore
): Promise<VectorSearchResult[]> {
  // Access the vector store's internal cache to find matches
  const vs = vectorStore as unknown as {
    storeVectorIds: Map<string, Set<string>>;
    vectorCache: Map<
      string,
      {
        id: string;
        sectionId: string;
        embedding: number[];
        contentPreview: string;
      }
    >;
  };

  const storeVectors = vs.storeVectorIds.get(storeId);
  if (!storeVectors || storeVectors.size === 0) {
    return [];
  }

  // Collect candidates
  const candidates: {
    id: string;
    sectionId: string;
    embedding: number[];
    contentPreview: string;
  }[] = [];
  for (const vectorId of storeVectors) {
    const entry = vs.vectorCache.get(vectorId);
    if (entry) {
      candidates.push(entry);
    }
  }

  // Calculate similarities
  const results: VectorSearchResult[] = [];
  for (const candidate of candidates) {
    const similarity = cosineSimilarity(embedding, candidate.embedding);
    if (similarity >= options.minSimilarity) {
      results.push({
        entry: {
          sectionId: candidate.sectionId,
          contentPreview: candidate.contentPreview
        },
        similarity
      });
    }
  }

  // Sort by similarity and take top K
  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, options.topK);
}

/**
 * Optimized search using bloom filter for fast negative lookups.
 *
 * @param store - Store to search in
 * @param terms - Search terms
 * @param maxResults - Maximum results to return
 * @param searchWindowSize - Context window size
 * @returns Query result
 */
export function searchStoreOptimized(
  store: ContextStore,
  terms: string[],
  maxResults: number,
  searchWindowSize: number
): QueryResult {
  // Quick check with bloom filter
  if (store.bloomFilter) {
    const possibleTerms = terms.filter((term) =>
      bloomMightContain(store.bloomFilter!, term.toLowerCase())
    );

    // If none of the terms might be present, return early
    if (possibleTerms.length === 0) {
      return { result: 'No matches found.', sectionsAccessed: [] };
    }
  }

  // Proceed with actual search
  const pattern = terms.join('|');
  return executeGrep(store, { pattern, maxResults }, searchWindowSize);
}
