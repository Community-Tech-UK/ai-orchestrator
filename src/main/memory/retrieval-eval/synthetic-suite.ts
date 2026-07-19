/**
 * WS16 — synthetic retrieval suite: runs the labeled fixture dataset against
 * the REAL production engines, deterministically (in-memory sqlite, no
 * network, no embeddings):
 *
 * - `code` queries → codemem's BM25 path (`CasStore.searchWorkspaceChunks`
 *   via `searchHydratedChunks`) over a fixture workspace seeded from the
 *   corpus — the same functions the code-retrieval service runs in prod.
 * - `lesson` queries → `LessonStore.digest` ordering over a store seeded with
 *   the corpus lessons and their reinforcement counts. Lessons are surfaced
 *   workspace-scoped (not query-scoped) in production, so the labels encode
 *   "these lessons should rank in the digest top-k for this scenario"; the
 *   query text documents the scenario. Reinforcement-on-use changes will move
 *   this metric — that is the point of the harness.
 *
 * The suite NEVER mutates real stores: it builds its own throwaway in-memory
 * database and lesson store per run (plan guardrail).
 */

import { migrate } from '../../codemem/cas-schema';
import { CasStore } from '../../codemem/cas-store';
import { searchHydratedChunks } from '../../codemem/workspace-chunk-search';
import { LessonStore } from '../lesson-store';
import type { SqliteDriver } from '../../db/sqlite-driver';
import type { CorpusDoc, LabeledQuery, RetrievalDataset } from './dataset';
import { splitQueries, validateDataset } from './dataset';
import { buildRetrievalReport, type QueryEvaluation, type RetrievalReport } from './metrics';

/** Exported so other fixture builders (e.g. the local-suite spec) can reuse `seedFixtureCasStore` with matching lookup paths. */
export const FIXTURE_WORKSPACE = '/retrieval-eval/fixture-workspace';
const FIXTURE_WORKSPACE_HASH = 'retrieval-eval-fixture';
const TOP_K = 10;

export interface SyntheticSuiteResult {
  dev: RetrievalReport;
  heldOut: RetrievalReport;
  all: RetrievalReport;
}

function fixtureContentHash(docId: string): string {
  // 64 hex-ish chars, deterministic per doc.
  return docId.replace(/[^a-z0-9]/gi, '').toLowerCase().padEnd(64, '0').slice(0, 64);
}

function docPath(doc: CorpusDoc): string {
  return doc.path ?? `src/${doc.id}.ts`;
}

/** Seed a throwaway CasStore workspace from the corpus code docs. */
export function seedFixtureCasStore(db: SqliteDriver, corpus: readonly CorpusDoc[]): CasStore {
  migrate(db);
  const store = new CasStore(db);
  store.upsertWorkspaceRoot({
    workspaceHash: FIXTURE_WORKSPACE_HASH,
    absPath: FIXTURE_WORKSPACE,
    headCommit: null,
    primaryLanguage: 'typescript',
    lastIndexedAt: 1,
    merkleRootHash: null,
    pagerankJson: null,
  });
  for (const doc of corpus) {
    if (doc.type !== 'code') continue;
    const contentHash = fixtureContentHash(doc.id);
    store.upsertChunk({
      contentHash,
      astNormalizedHash: contentHash,
      language: 'typescript',
      chunkType: 'function',
      name: doc.name ?? doc.id,
      signature: null,
      docComment: null,
      symbolsJson: JSON.stringify([doc.name ?? doc.id]),
      importsJson: '[]',
      exportsJson: '[]',
      rawText: doc.text,
    });
    store.replaceWorkspaceChunksForFile(FIXTURE_WORKSPACE_HASH, docPath(doc), [
      {
        workspaceHash: FIXTURE_WORKSPACE_HASH,
        pathFromRoot: docPath(doc),
        chunkIndex: 0,
        contentHash,
        startLine: 1,
        endLine: Math.max(1, doc.text.split('\n').length),
        language: 'typescript',
        chunkType: 'function',
        name: doc.name ?? doc.id,
        updatedAt: 1,
      },
    ]);
  }
  return store;
}

/** Seed a throwaway LessonStore honoring corpus reinforcement counts. */
export function seedFixtureLessonStore(corpus: readonly CorpusDoc[]): {
  store: LessonStore;
  idByLessonId: Map<string, string>;
} {
  const store = new LessonStore();
  const idByLessonId = new Map<string, string>();
  let clock = 1_000;
  for (const doc of corpus) {
    if (doc.type !== 'lesson') continue;
    const times = Math.max(1, doc.reinforcements ?? 1);
    let lessonId = '';
    for (let i = 0; i < times; i++) {
      lessonId = store.capture(doc.text, clock++).lesson.id;
    }
    idByLessonId.set(lessonId, doc.id);
  }
  return { store, idByLessonId };
}

function evaluateCodeQuery(store: CasStore, query: LabeledQuery): QueryEvaluation {
  const response = searchHydratedChunks(store, FIXTURE_WORKSPACE, query.query, TOP_K);
  const idByPath = (relativePath: string): string => {
    const match = /^src\/(.+)\.ts$/.exec(relativePath);
    return match ? match[1] : relativePath;
  };
  return {
    queryId: query.id,
    type: query.type,
    returned: response.results.map((result) => idByPath(result.relativePath)),
    relevant: new Set(query.relevant),
  };
}

function evaluateLessonQuery(
  digestDocIds: readonly string[],
  query: LabeledQuery,
): QueryEvaluation {
  return {
    queryId: query.id,
    type: query.type,
    returned: [...digestDocIds],
    relevant: new Set(query.relevant),
  };
}

/**
 * Run the full synthetic suite. `driverFactory` supplies the throwaway
 * in-memory database (`defaultDriverFactory(':memory:')` in prod/CLI).
 */
export function runSyntheticSuite(
  dataset: RetrievalDataset,
  driverFactory: (path: string) => SqliteDriver,
): SyntheticSuiteResult {
  const problems = validateDataset(dataset);
  if (problems.length > 0) {
    throw new Error(`Invalid retrieval dataset:\n${problems.join('\n')}`);
  }

  const db = driverFactory(':memory:');
  try {
    const casStore = seedFixtureCasStore(db, dataset.corpus);
    const { store: lessonStore, idByLessonId } = seedFixtureLessonStore(dataset.corpus);
    const digestDocIds = lessonStore
      .digest(TOP_K)
      .map((lesson) => idByLessonId.get(lesson.id))
      .filter((id): id is string => id !== undefined);

    const evaluate = (query: LabeledQuery): QueryEvaluation =>
      query.type === 'code'
        ? evaluateCodeQuery(casStore, query)
        : evaluateLessonQuery(digestDocIds, query);

    const split = splitQueries(dataset.queries);
    return {
      dev: buildRetrievalReport(split.dev.map(evaluate)),
      heldOut: buildRetrievalReport(split.heldOut.map(evaluate)),
      all: buildRetrievalReport(dataset.queries.map(evaluate)),
    };
  } finally {
    db.close();
  }
}
