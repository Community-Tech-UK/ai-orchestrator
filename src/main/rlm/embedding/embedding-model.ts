/**
 * The embedding models AIO can run, and what their similarity scores mean.
 *
 * A similarity score only means something for one model. Two unrelated texts
 * score about 0 on the word hash and about 0.54 on bge-small, so every threshold
 * has to be chosen per model and per use. Vectors from different models must
 * never be compared, which is why each stored vector records its model.
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { OnnxModelFormat } from './onnx-text-embedder';

/** What a similarity threshold is being used for. */
export type SimilarityUse =
  | 'context-search'
  | 'hyde-search'
  | 'reflection-search'
  | 'session-search'
  | 'pattern-search'
  | 'pattern-match'
  | 'pattern-relevance'
  | 'pattern-duplicate'
  | 'skill-match'
  | 'memory-related'
  | 'memory-link';

export interface EmbeddingModelSpec {
  id: string;
  /** The lowest score at which two texts count as a match for each use. */
  similarityFloors: Record<SimilarityUse, number>;
}

export interface LocalEmbeddingModelSpec extends EmbeddingModelSpec, OnnxModelFormat {
  /** Prepended to search queries, never to stored text. The model was trained this way. */
  queryInstruction: string;
}

/** Hashed bag of words: measures shared words, not meaning. Used when no model can run. */
export const HASH_EMBEDDING_MODEL: EmbeddingModelSpec = {
  id: 'local-tfidf',
  similarityFloors: {
    'context-search': 0.5,
    'hyde-search': 0.5,
    'reflection-search': 0.3,
    'session-search': 0.5,
    'pattern-search': 0.6,
    'pattern-match': 0.7,
    'pattern-relevance': 0.5,
    'pattern-duplicate': 0.8,
    // No value separates on-topic from off-topic messages on this backend, so
    // this stays high enough that matching is effectively off and triggers do
    // the work. See docs/plans/2026-08-19-open-decisions-resolved.md.
    'skill-match': 0.65,
    'memory-related': 0.6,
    'memory-link': 0.8,
  },
};

/**
 * bge-small-en-v1.5, 8-bit. Chosen on 6 November 2026 from four candidates by
 * skill matching on 34 unseen prompts. Measured against real memory text:
 *
 * - A message and an unrelated memory score 0.54 at the median, 0.68 at the
 *   99th percentile and 0.73 at the 99.9th, so search floors sit near 0.70.
 * - Two unrelated stored texts score higher, 0.62 at the median and 0.76 at the
 *   99th percentile, so comparisons between stored texts need higher floors.
 * - `skill-match` is 0.62 with only the best skill taken: no wrong skill and no
 *   off-topic match across 68 prompts, with 25 of 34 skills found.
 *
 * Floors must be re-measured if the model changes.
 */
export const LOCAL_EMBEDDING_MODEL: LocalEmbeddingModelSpec = {
  id: 'bge-small-en-v1.5-int8',
  pooling: 'cls',
  maxTokens: 256,
  queryInstruction: 'Represent this sentence for searching relevant passages: ',
  similarityFloors: {
    'context-search': 0.7,
    'hyde-search': 0.78,
    'reflection-search': 0.68,
    'session-search': 0.7,
    'pattern-search': 0.72,
    'pattern-match': 0.85,
    'pattern-relevance': 0.7,
    'pattern-duplicate': 0.92,
    'skill-match': 0.62,
    'memory-related': 0.75,
    'memory-link': 0.85,
  },
};

const MODEL_FILE = 'model.onnx';
const MAX_ANCESTOR_DEPTH = 8;

function ancestors(start: string): string[] {
  const found: string[] = [];
  let current = start;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    found.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return found;
}

/**
 * Where the model is installed, or null when it is not. Walks up from this file
 * rather than asking Electron, because this also runs in worker threads. A
 * packaged app finds `<resources>/embedding-model` from inside its asar, and a
 * checkout finds `resources/embedding-model`. Setting `AIO_EMBEDDING_MODEL_DIR`
 * replaces the search, and an empty value means no model.
 */
export function resolveEmbeddingModelDir(startDir: string = __dirname): string | null {
  const override = process.env['AIO_EMBEDDING_MODEL_DIR'];
  if (override !== undefined) {
    return override && existsSync(path.join(override, MODEL_FILE)) ? override : null;
  }
  for (const directory of ancestors(startDir)) {
    for (const parent of [directory, path.join(directory, 'resources')]) {
      const candidate = path.join(parent, 'embedding-model', LOCAL_EMBEDDING_MODEL.id);
      if (existsSync(path.join(candidate, MODEL_FILE))) return candidate;
    }
  }
  return null;
}
