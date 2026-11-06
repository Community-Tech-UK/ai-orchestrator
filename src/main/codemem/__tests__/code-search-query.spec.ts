import { describe, expect, it } from 'vitest';
import {
  canMatchStrongly,
  chunkRankingText,
  classifyFileKind,
  countMatchedTerms,
  extractSearchTerms,
  fileKindWeight,
  isStrongMatch,
  toFtsMatchQuery,
} from '../code-search-query';

describe('extractSearchTerms', () => {
  it('keeps the words that identify code and drops filler', () => {
    expect(extractSearchTerms('how do we stop the worker exiting while waiting?'))
      .toEqual(['stop', 'worker', 'exiting', 'waiting']);
  });

  it('keeps domain nouns that matter in this codebase', () => {
    expect(extractSearchTerms('session status for the instance')).toEqual(['session', 'status', 'instance']);
  });

  it('removes repeats regardless of case, keeping the first spelling', () => {
    expect(extractSearchTerms('Retry retry RETRY backoff')).toEqual(['Retry', 'backoff']);
  });

  it('keeps identifiers whole', () => {
    expect(extractSearchTerms('call max_tokens in VectorStore')).toEqual(['call', 'max_tokens', 'VectorStore']);
  });

  it('caps very long messages', () => {
    const words = Array.from({ length: 40 }, (_, index) => `word${index}`).join(' ');
    expect(extractSearchTerms(words)).toHaveLength(12);
  });

  it('finds nothing in a chatty reply', () => {
    expect(extractSearchTerms('yes please, thanks!')).toEqual([]);
  });
});

describe('toFtsMatchQuery', () => {
  it('lets any informative word match', () => {
    expect(toFtsMatchQuery('wire service IPC to scoped RPC')).toBe('"wire" OR "service" OR "IPC" OR "scoped" OR "RPC"');
  });

  it('never lets a word act as a search operator', () => {
    expect(toFtsMatchQuery('NEAR NOT handler')).toBe('"NEAR" OR "handler"');
    expect(toFtsMatchQuery('session AND token')).toBe('"session" OR "token"');
  });

  it('still searches when someone deliberately looks for a stop word', () => {
    expect(toFtsMatchQuery('make')).toBe('"make"');
  });

  it('produces no query from punctuation alone', () => {
    expect(toFtsMatchQuery('!!! ???')).toBe('');
  });
});

describe('file kinds', () => {
  it.each([
    ['src/main/rlm/vector-store.ts', 'code'],
    ['apps/mobile/src/main.ts', 'code'],
    ['src/main/rlm/vector-store.spec.ts', 'test'],
    ['src/main/codemem/__tests__/cas-store.spec.ts', 'test'],
    ['tests/helpers/setup.ts', 'test'],
    ['docs/plans/2026-11-06-search_plan.md', 'doc'],
    ['README.md', 'doc'],
    ['needjamesfor.md', 'doc'],
    ['package.json', 'data'],
    ['config/app.yaml', 'data'],
  ] as const)('%s is %s', (filePath, kind) => {
    expect(classifyFileKind(filePath)).toBe(kind);
  });

  it('ranks code above tests, tests above documents, and documents above data', () => {
    const weights = ['src/a.ts', 'src/a.spec.ts', 'docs/a.md', 'a.json'].map(fileKindWeight);
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
    expect(new Set(weights).size).toBe(4);
  });
});

describe('countMatchedTerms', () => {
  it('counts a word when the chunk uses a related form of it', () => {
    const text = chunkRankingText('src/a.ts', 'indexWorkspace', 'indexing retried workspaces');
    expect(countMatchedTerms(['indexes', 'retries', 'workspace', 'missing'], text)).toBe(3);
  });

  it('looks at the file path and symbol name as well as the code', () => {
    const text = chunkRankingText('src/billing/invoice.ts', 'chargeCustomer', 'return 1;');
    expect(countMatchedTerms(['billing', 'chargeCustomer'], text)).toBe(2);
  });
});

describe('automatic context relevance', () => {
  it('does not search on a chatty message', () => {
    expect(canMatchStrongly(extractSearchTerms('yeah fix all those issues please!!!'))).toBe(false);
    expect(canMatchStrongly(extractSearchTerms('continue'))).toBe(false);
    expect(canMatchStrongly(extractSearchTerms('ok'))).toBe(false);
  });

  it('searches on a technical message', () => {
    expect(canMatchStrongly(extractSearchTerms('repair the outstanding defects'))).toBe(true);
  });

  it('treats a single exact identifier as enough to search on', () => {
    expect(canMatchStrongly(extractSearchTerms('what does VectorStore do'))).toBe(true);
    expect(canMatchStrongly(extractSearchTerms('max_tokens'))).toBe(true);
  });

  it('needs two words and half the query', () => {
    const terms = ['one', 'two', 'three', 'four'];
    expect(isStrongMatch(terms, 2, 'text')).toBe(true);
    expect(isStrongMatch(terms, 1, 'text')).toBe(false);
    expect(isStrongMatch(['aa', 'bb', 'cc', 'dd', 'ee'], 2, 'text')).toBe(false);
  });

  it('accepts the chunk that defines an identifier on its own', () => {
    expect(isStrongMatch(['VectorStore', 'other', 'words', 'here'], 1, 'VectorStore')).toBe(true);
  });

  it('wants the identifier exactly, not a lookalike', () => {
    expect(isStrongMatch(['VectorStore', 'other', 'words', 'here'], 1, 'vectorstore')).toBe(false);
  });

  it('does not accept a chunk just for containing a word shaped like a name', () => {
    expect(isStrongMatch(['GitHub'], 1, 'createPullRequest')).toBe(false);
  });

  it('does not mistake a version number or ordinary word with a digit for a code name', () => {
    expect(canMatchStrongly(extractSearchTerms('v2'))).toBe(false);
    expect(canMatchStrongly(extractSearchTerms('utf8'))).toBe(false);
    expect(isStrongMatch(['v2', 'other', 'words', 'here'], 1, 'v2')).toBe(false);
  });
});
