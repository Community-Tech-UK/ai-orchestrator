/**
 * Dependency-free BM25 ranker for MCP tool search (WS9 tool-schema economy).
 *
 * Ranks tool documents (name + description + schema text) against a free-text
 * query. Used by the browser-gateway stdio forwarder's deferred-tool search,
 * so it must stay free of Electron/main-process imports — the forwarder runs
 * inside the aio-mcp SEA binary.
 */

export interface RankableToolDoc {
  /** Stable identifier returned in results (the tool name). */
  id: string;
  /** Searchable text: name, description, schema property names/descriptions. */
  text: string;
}

export interface RankedToolResult {
  id: string;
  score: number;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * Lowercase and split on non-alphanumerics. Tool ids like
 * `browser.fill_form` tokenize to [browser, fill, form] so queries such as
 * "type into a form" match on shared tokens.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}

interface IndexedDoc {
  id: string;
  termFrequencies: Map<string, number>;
  length: number;
}

/**
 * Rank documents against the query with BM25 (k1=1.2, b=0.75). Only documents
 * with a positive score are returned, sorted by score descending with the id
 * as a deterministic tiebreak.
 */
export function rankToolDocuments(
  query: string,
  docs: RankableToolDoc[],
  limit = 5,
): RankedToolResult[] {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0 || docs.length === 0) {
    return [];
  }

  const indexed: IndexedDoc[] = docs.map((doc) => {
    const tokens = tokenize(doc.text);
    const termFrequencies = new Map<string, number>();
    for (const token of tokens) {
      termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + 1);
    }
    return { id: doc.id, termFrequencies, length: tokens.length };
  });

  const totalDocs = indexed.length;
  const averageLength =
    indexed.reduce((sum, doc) => sum + doc.length, 0) / totalDocs || 1;

  const documentFrequencies = new Map<string, number>();
  for (const term of queryTerms) {
    let count = 0;
    for (const doc of indexed) {
      if (doc.termFrequencies.has(term)) count += 1;
    }
    documentFrequencies.set(term, count);
  }

  const results: RankedToolResult[] = [];
  for (const doc of indexed) {
    let score = 0;
    for (const term of queryTerms) {
      const tf = doc.termFrequencies.get(term);
      if (!tf) continue;
      const df = documentFrequencies.get(term) ?? 0;
      // Standard BM25 idf with the +1 inside the log so idf stays positive
      // even for terms present in most documents.
      const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
      const numerator = tf * (BM25_K1 + 1);
      const denominator =
        tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / averageLength));
      score += idf * (numerator / denominator);
    }
    if (score > 0) {
      results.push({ id: doc.id, score });
    }
  }

  results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return results.slice(0, Math.max(1, limit));
}
