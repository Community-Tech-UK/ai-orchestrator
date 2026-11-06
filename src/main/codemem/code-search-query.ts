/**
 * Turns free text into a code search, and judges how well a chunk answers it.
 *
 * A query is often a person's whole message rather than a keyword, so it is
 * reduced to its informative words and any of them may match. Requiring every
 * word instead put the right file in the top 10 for 8% of real commit
 * descriptions, because a sentence's filler words rarely share one chunk.
 *
 * Dependency-free so it can run inside the index worker.
 */

const MAX_SEARCH_TERMS = 12;
const MIN_TERM_LENGTH = 2;
/** Words beyond this point in a chunk are not worth scanning to rank it. */
const MAX_RANKED_TEXT_CHARS = 20_000;

/** Below this many informative words, automatic context has too little to go on. */
const MIN_STRONG_MATCH_TERMS = 2;
const MIN_STRONG_MATCH_COVERAGE = 0.5;

/**
 * Words that say nothing about which code is meant. Domain nouns such as
 * `session` or `status` stay out of this list: they identify code here.
 */
const STOP_WORDS = new Set<string>(`
  a about above after again against all also am an and any are aren as at be because been before
  being below between both but by can cannot could couldn did didn do does doesn doing don done down
  during each even ever every few for from further get gets getting go goes going got had hadn has
  hasn have haven having he her here hers him his how i if in into is isn it its itself just keep let
  lets like ll may maybe me might more most much must mustn my myself need needs no nor not now of off
  on once one only onto or other ought our ours out over own please pls plz re really same say says
  shall shan she should shouldn so some something such than that thats the their theirs them then
  there these they thing things this those through to too under until up upon us use used uses using
  ve very via want wants was wasn way we well were weren what when where which while who whom why will
  with within without won would wouldn yeah yep yes yet you your yours ok okay hey hi hello thanks
  thank sure cool great nice awesome fix fixed fixes add added adds make makes made
`.trim().split(/\s+/));

const DOC_PATH = /(^|\/)(docs?|documentation)\/|\.(md|mdx|rst|txt|adoc)$/i;
const DATA_PATH = /\.(json|jsonl|ya?ml|toml|lock|csv|tsv|xml|svg|snap|map|ini|env)$/i;
const TEST_PATH = /\.(spec|test)\.|(^|\/)(__tests__|tests?|fixtures?)\//i;

export type CodeFileKind = 'code' | 'test' | 'doc' | 'data';

/**
 * How much a hit counts by file kind. Plan and reference documents repeat the
 * vocabulary of the code they describe, so without this they outrank it.
 */
const FILE_KIND_WEIGHT: Record<CodeFileKind, number> = {
  code: 1,
  test: 0.6,
  doc: 0.35,
  data: 0.25,
};

function tokenize(query: string): string[] {
  return query.split(/[^A-Za-z0-9_]+/).filter((token) => token.length >= MIN_TERM_LENGTH);
}

function uniqueCaseInsensitive(tokens: readonly string[]): string[] {
  const seen = new Set<string>();
  return tokens.filter((token) => {
    const key = token.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The words in a query that can tell one piece of code from another. */
export function extractSearchTerms(query: string): string[] {
  const informative = tokenize(query).filter((token) => !STOP_WORDS.has(token.toLowerCase()));
  return uniqueCaseInsensitive(informative).slice(0, MAX_SEARCH_TERMS);
}

/**
 * Build an FTS5 MATCH expression that any informative word can satisfy. A query
 * made only of stop words falls back to those words, so a deliberate search for
 * `make` still works. Quoting stops `NOT` or `NEAR` being read as operators.
 */
export function toFtsMatchQuery(query: string): string {
  const terms = extractSearchTerms(query);
  const words = terms.length > 0 ? terms : uniqueCaseInsensitive(tokenize(query)).slice(0, MAX_SEARCH_TERMS);
  return words.map((word) => `"${word}"`).join(' OR ');
}

/** A name only code would use. Letters beside digits are not enough: `v2` and `utf8` are ordinary words. */
function isIdentifierLike(term: string): boolean {
  return /[a-z][A-Z]|_/.test(term);
}

function comparableStem(term: string): string {
  const lower = term.toLowerCase();
  return lower.length > 4 ? lower.slice(0, Math.max(4, lower.length - 2)) : lower;
}

/** Text a chunk is judged on, lower-cased once for repeated term checks. */
export function chunkRankingText(relativePath: string, name: string, rawText: string): string {
  return `${relativePath} ${name} ${rawText.slice(0, MAX_RANKED_TEXT_CHARS)}`.toLowerCase();
}

export function countMatchedTerms(terms: readonly string[], rankingText: string): number {
  return terms.filter((term) => rankingText.includes(comparableStem(term))).length;
}

export function classifyFileKind(relativePath: string): CodeFileKind {
  if (TEST_PATH.test(relativePath)) return 'test';
  if (DOC_PATH.test(relativePath)) return 'doc';
  if (DATA_PATH.test(relativePath)) return 'data';
  return 'code';
}

export function fileKindWeight(relativePath: string): number {
  return FILE_KIND_WEIGHT[classifyFileKind(relativePath)];
}

/** Whether a query says enough to be worth searching for automatic context at all. */
export function canMatchStrongly(terms: readonly string[]): boolean {
  return terms.length >= MIN_STRONG_MATCH_TERMS || terms.some(isIdentifierLike);
}

/**
 * Whether a chunk is relevant enough to add to a prompt unasked. Sending
 * unrelated code on every message costs tokens and misleads, so automatic
 * context needs more than one shared word: at least two informative words and
 * half the query, or the chunk that defines a code name from it. Merely
 * containing the name is not enough, because `GitHub` is shaped like a class.
 */
export function isStrongMatch(
  terms: readonly string[],
  matchedTerms: number,
  chunkName: string,
): boolean {
  if (terms.some((term) => isIdentifierLike(term) && term === chunkName)) {
    return true;
  }
  return matchedTerms >= MIN_STRONG_MATCH_TERMS
    && matchedTerms / terms.length >= MIN_STRONG_MATCH_COVERAGE;
}
