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
  const canSearch = (message: string): boolean => canMatchStrongly(extractSearchTerms(message));

  it('does not search on a chatty message', () => {
    expect(canSearch('yeah fix all those issues please!!!')).toBe(false);
    expect(canSearch('continue')).toBe(false);
    expect(canSearch('ok')).toBe(false);
    expect(canSearch('this looks good to me')).toBe(false);
  });

  it('searches on a technical message', () => {
    expect(canSearch('repair the outstanding defects')).toBe(true);
  });

  it('treats a single exact identifier as enough to search on', () => {
    expect(canSearch('what does VectorStore do')).toBe(true);
    expect(canSearch('max_tokens')).toBe(true);
  });

  it('does not mistake a version number or ordinary word with a digit for a code name', () => {
    expect(canSearch('v2')).toBe(false);
    expect(canSearch('utf8')).toBe(false);
    expect(isStrongMatch(['v2', 'other', 'words', 'here'], 'src/a.ts', 'v2')).toBe(false);
  });

  it('needs two of the words in the file path or symbol name', () => {
    expect(isStrongMatch(['vector', 'store', 'convert'], 'src/rlm/vector-store.ts', 'search')).toBe(true);
    expect(isStrongMatch(['billing', 'charge'], 'src/billing/invoice.ts', 'chargeCustomer')).toBe(true);
    expect(isStrongMatch(['vector', 'convert'], 'src/rlm/vector-store.ts', 'search')).toBe(false);
  });

  it('matches word endings but not letters inside another word', () => {
    expect(isStrongMatch(['bookings', 'screens'], 'src/admin/booking-screen.ts', 'render')).toBe(true);
    expect(isStrongMatch(['port', 'view'], 'src/export/review.ts', 'render')).toBe(false);
  });

  it('counts two forms of one word once', () => {
    expect(isStrongMatch(['plan', 'plans'], 'src/plan.ts', 'run')).toBe(false);
    expect(isStrongMatch(['worker', 'workers'], 'src/worker.ts', 'run')).toBe(false);
    expect(isStrongMatch(['session', 'sessions'], 'src/session.ts', 'run')).toBe(false);
    expect(isStrongMatch(['session', 'sessions'], 'src/session/session.ts', 'run')).toBe(false);
  });

  it('wants a very short word whole, not as the start of a longer one', () => {
    expect(isStrongMatch(['id', 'db'], 'src/identity/db-handler.ts', 'run')).toBe(false);
    expect(isStrongMatch(['id', 'db'], 'src/id/db-handler.ts', 'run')).toBe(true);
  });

  it('does not count everyday words, even in a path', () => {
    expect(isStrongMatch(['looks', 'good'], 'src/looks/good.ts', 'render')).toBe(false);
  });

  it.each([
    'src/plan-queue.ts',
    'wp-content/plugins/plan-queue/plan-queue.inc',
    'app/plan-queue.gradle',
    'scripts/plan-queue.ps1',
    'com/acme/build/plan-queue.java',
    'src/cache/plan-queue.ts',
    'src/main/session/plan-queue-archive.ts',
    'src/preload/generated/plan-queue.ts',
  ])('can add source at %s', (filePath) => {
    expect(isStrongMatch(['plan', 'queue'], filePath, 'run')).toBe(true);
  });

  it.each([
    'src/plan-queue.spec.ts',
    'docs/plan-queue.md',
    'plan-queue.json',
    'plan-queue.tap',
    'ios/build-device/plan-queue.plist',
    'tmp/plan-queue.ts',
    'dist/plan-queue.js',
    'build/plan-queue.js',
    'runner-p1-archive-7t3iaj6w/apps/desk/plan-queue.ts',
    'wp-includes/js/plan-queue.js',
    '_scratch/plan-queue.ts',
  ])('does not add %s', (filePath) => {
    expect(isStrongMatch(['plan', 'queue'], filePath, 'run')).toBe(false);
  });

  it('does not count path parts that nearly every file has', () => {
    expect(isStrongMatch(['main', 'index'], 'src/main/index.ts', 'start')).toBe(false);
    expect(isStrongMatch(['src', 'ts'], 'src/app.ts', 'start')).toBe(false);
  });

  it('accepts the chunk that defines an identifier on its own', () => {
    expect(isStrongMatch(['VectorStore', 'other', 'words', 'here'], 'src/a.ts', 'VectorStore')).toBe(true);
  });

  it('wants the identifier exactly, not a lookalike', () => {
    expect(isStrongMatch(['VectorStore', 'other', 'words', 'here'], 'src/a.ts', 'vectorstore')).toBe(false);
  });

  it('does not accept a chunk just for containing a word shaped like a name', () => {
    expect(isStrongMatch(['GitHub'], 'src/a.ts', 'createPullRequest')).toBe(false);
  });
});
