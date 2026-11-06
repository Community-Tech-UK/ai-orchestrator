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
const MIN_PREFIX_LENGTH = 3;

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

/**
 * Everyday words that say nothing about code, even when a file is named after
 * them. Kept out of `STOP_WORDS` because a deliberate search can still use them.
 */
const CHATTY_WORDS = new Set<string>(`
  good better best bad worse look looks looking see seen sees saw think thought know knew try trying
  tried show shows showing tell told find found start started stop stopped mean means right wrong new
  old last next first still already again maybe actually really probably sorry wait check checks
  checking run running work works working put putting take taking give given able sure time times day
  today now
`.trim().split(/\s+/));

const DOC_PATH = /(^|\/)(docs?|documentation)\/|\.(md|mdx|rst|txt|adoc)$/i;
const DATA_PATH = /\.(json|jsonl|ya?ml|toml|lock|csv|tsv|xml|svg|snap|map|ini|env)$/i;
const TEST_PATH = /\.(spec|test)\.|(^|\/)(__tests__|tests?|fixtures?)\//i;
const SOURCE_PATH = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi|java|kt|kts|groovy|gradle|go|rs|rb|php|phtml|inc|twig|jsp|swift|dart|lua|c|h|cc|cpp|hpp|cs|scala|sh|bash|zsh|ps1|bat|sql|proto|graphql|html|css|scss|sass|less|vue|svelte)$/i;
/** Folders of copies, output and third-party code. Their files look like source but nobody here is working on them. */
const NON_SOURCE_FOLDER = /(^|\/)(tmp|temp|\.tmp|\.cache|node_modules|dist|coverage|vendor|third_party|wp-admin|wp-includes|_scratch|_archive|Pods|DerivedData)\/|^(out|build|target)\/|(^|\/)[^/]*-archive-[^/]*\//i;
/** Parts of nearly every path, which say nothing about what a file does. */
const PATH_NOISE_WORDS = new Set(['src', 'main', 'lib']);

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

function isInformative(term: string): boolean {
  return !CHATTY_WORDS.has(term.toLowerCase());
}

/** Whether a query says enough to be worth searching for automatic context at all. */
export function canMatchStrongly(terms: readonly string[]): boolean {
  return terms.filter(isInformative).length >= MIN_STRONG_MATCH_TERMS || terms.some(isIdentifierLike);
}

function isSourceFile(relativePath: string): boolean {
  return classifyFileKind(relativePath) === 'code'
    && SOURCE_PATH.test(relativePath)
    && !NON_SOURCE_FOLDER.test(relativePath);
}

/** The words a path and symbol name are made of: `src/planQueue-worker.ts` gives plan, queue, worker. */
function nameWords(relativePath: string, chunkName: string): string[] {
  return `${relativePath.replace(/\.[^./]+$/, '')} ${chunkName}`
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => !PATH_NOISE_WORDS.has(word));
}

/** Very short words must match whole, or `id` would match `identity`. */
function isNamedBy(word: string, stem: string): boolean {
  return stem.length < MIN_PREFIX_LENGTH ? word === stem : word.startsWith(stem);
}

/**
 * Whether a chunk is relevant enough to add to a prompt unasked. Unrelated code
 * costs tokens and misleads, and shared words in a chunk's body prove little: a
 * blind review found about 7% of such matches relevant on real messages, and
 * words in the file path or symbol name did far better. So a chunk must be
 * source code and either be named after two informative words or define a code
 * name from the query. Merely containing the name is not enough, because `GitHub` is
 * shaped like a class.
 */
export function isStrongMatch(
  terms: readonly string[],
  relativePath: string,
  chunkName: string,
): boolean {
  if (!isSourceFile(relativePath)) return false;
  if (terms.some((term) => isIdentifierLike(term) && term === chunkName)) return true;

  // Each name word counts once, so `session` and `sessions` cannot pass on one word.
  const unmatched = new Set(nameWords(relativePath, chunkName));
  let named = 0;
  for (const term of terms.filter(isInformative)) {
    const stem = comparableStem(term);
    const word = [...unmatched].find((candidate) => isNamedBy(candidate, stem));
    if (word === undefined) continue;
    unmatched.delete(word);
    named += 1;
  }
  return named >= MIN_STRONG_MATCH_TERMS;
}
