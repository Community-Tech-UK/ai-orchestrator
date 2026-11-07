import { sanitizeRetrievalQuery, type SanitizedQuery } from './query-sanitizer';
import { STOPWORDS, stem } from './lesson-use-detector';

export type RetrievalQueryStrategy = SanitizedQuery['strategy'];

/** Keep technical abbreviations while sharing the lesson stopwords and stemmer. */
export function retrievalContentTokens(text: string): Set<string> {
  const tokens = (text.toLowerCase().match(/[a-z0-9_]+/g) ?? [])
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token))
    .map(stem);
  return new Set(tokens);
}

/** One intent extractor shared by semantic and lexical retrieval paths. */
export function prepareRetrievalQuery(raw: string): { query: string; terms: string[]; strategy: RetrievalQueryStrategy } {
  const { query, strategy } = sanitizeRetrievalQuery(raw);
  return { query, terms: [...retrievalContentTokens(query)], strategy };
}
