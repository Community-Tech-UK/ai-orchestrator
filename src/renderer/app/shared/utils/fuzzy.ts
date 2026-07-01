export interface FuzzyMatch {
  readonly matched: boolean;
  readonly score: number;
  readonly positions: readonly number[];
}

export interface FuzzyRanked<T> {
  readonly item: T;
  readonly score: number;
  readonly positions: readonly number[];
}

interface InternalMatch {
  readonly matched: boolean;
  readonly penalty: number;
  readonly positions: readonly number[];
}

const WORD_BOUNDARY_RE = /[\s\-_./:]/;

export function fuzzyMatch(query: string, candidate: string): FuzzyMatch {
  const normalizedQuery = query.trim().toLowerCase();
  const candidateLower = candidate.toLowerCase();

  const primary = matchQuery(normalizedQuery, candidateLower);
  if (primary.matched) {
    return toPublicMatch(primary);
  }

  const swappedQuery = swappedAlphaNumericQuery(normalizedQuery);
  if (!swappedQuery) {
    return toPublicMatch(primary);
  }

  const swapped = matchQuery(swappedQuery, candidateLower);
  if (!swapped.matched) {
    return toPublicMatch(primary);
  }

  return toPublicMatch({
    matched: true,
    penalty: swapped.penalty + 5,
    positions: swapped.positions,
  });
}

export function fuzzyRank<T>(
  query: string,
  items: readonly T[],
  label: (item: T) => string,
): FuzzyRanked<T>[] {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) {
    return items.map((item) => ({ item, score: 0, positions: [] }));
  }

  const ranked: (FuzzyRanked<T> & { readonly index: number })[] = [];
  items.forEach((item, index) => {
    const text = label(item);
    let score = 0;
    const positions = new Set<number>();

    for (const token of tokens) {
      const match = fuzzyMatch(token, text);
      if (!match.matched) {
        return;
      }
      score += match.score;
      match.positions.forEach((position) => positions.add(position));
    }

    ranked.push({
      item,
      score,
      positions: [...positions].sort((left, right) => left - right),
      index,
    });
  });

  return ranked
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ item, score, positions }) => ({ item, score, positions }));
}

function matchQuery(query: string, candidate: string): InternalMatch {
  if (query.length === 0) {
    return { matched: true, penalty: 0, positions: [] };
  }

  if (query.length > candidate.length) {
    return { matched: false, penalty: 0, positions: [] };
  }

  let queryIndex = 0;
  let penalty = 0;
  let lastMatchIndex = -1;
  let consecutiveMatches = 0;
  const positions: number[] = [];

  for (let i = 0; i < candidate.length && queryIndex < query.length; i++) {
    if (candidate[i] !== query[queryIndex]) {
      continue;
    }

    const isWordBoundary = i === 0 || WORD_BOUNDARY_RE.test(candidate[i - 1]!);
    if (lastMatchIndex === i - 1) {
      consecutiveMatches++;
      penalty -= consecutiveMatches * 5;
    } else {
      consecutiveMatches = 0;
      if (lastMatchIndex >= 0) {
        penalty += (i - lastMatchIndex - 1) * 2;
      }
    }

    if (isWordBoundary) {
      penalty -= 10;
    }

    penalty += i * 0.1;
    lastMatchIndex = i;
    queryIndex++;
    positions.push(i);
  }

  if (queryIndex < query.length) {
    return { matched: false, penalty: 0, positions: [] };
  }

  if (query === candidate) {
    penalty -= 100;
  }

  return { matched: true, penalty, positions };
}

function toPublicMatch(match: InternalMatch): FuzzyMatch {
  return {
    matched: match.matched,
    score: match.matched ? 1000 - match.penalty : 0,
    positions: match.positions,
  };
}

function swappedAlphaNumericQuery(query: string): string {
  const alphaNumericMatch = /^(?<letters>[a-z]+)(?<digits>[0-9]+)$/.exec(query);
  if (alphaNumericMatch?.groups) {
    return `${alphaNumericMatch.groups['digits']}${alphaNumericMatch.groups['letters']}`;
  }

  const numericAlphaMatch = /^(?<digits>[0-9]+)(?<letters>[a-z]+)$/.exec(query);
  if (numericAlphaMatch?.groups) {
    return `${numericAlphaMatch.groups['letters']}${numericAlphaMatch.groups['digits']}`;
  }

  return '';
}

function tokenizeQuery(query: string): string[] {
  return query.trim().toLowerCase().split(/[\s/]+/).filter(Boolean);
}
