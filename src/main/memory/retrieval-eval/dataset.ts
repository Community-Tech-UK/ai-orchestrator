/**
 * WS16 — labeled retrieval dataset: versioned JSONL of corpus documents and
 * queries with relevant-id labels, plus a DETERMINISTIC dev/held-out split
 * (content-hash based, no RNG) so results are reproducible and the
 * teach-to-test disclosure is auditable: ranking tweaks may be tuned on the
 * dev split; the held-out split is report-only.
 */

export interface CorpusDoc {
  id: string;
  /** Which retrieval surface this document belongs to. */
  type: 'code' | 'lesson';
  /** Document body (code chunk text or lesson text). */
  text: string;
  /** For code docs: pretend path inside the fixture workspace. */
  path?: string;
  /** For code docs: symbol name. */
  name?: string;
  /** For lesson docs: reinforcement count to seed ranking. */
  reinforcements?: number;
}

export interface LabeledQuery {
  id: string;
  type: 'code' | 'lesson';
  query: string;
  relevant: string[];
}

export interface RetrievalDataset {
  corpus: CorpusDoc[];
  queries: LabeledQuery[];
}

/** djb2 — deterministic, dependency-free (same family as lesson-store ids). */
function hashText(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  }
  return h;
}

export function parseJsonlDocs(jsonl: string): CorpusDoc[] {
  return parseJsonl<CorpusDoc>(jsonl, (row, line) => {
    if (typeof row.id !== 'string' || !row.id) throw new Error(`corpus line ${line}: missing id`);
    if (row.type !== 'code' && row.type !== 'lesson') {
      throw new Error(`corpus line ${line}: unknown type ${String(row.type)}`);
    }
    if (typeof row.text !== 'string' || !row.text) throw new Error(`corpus line ${line}: missing text`);
  });
}

export function parseJsonlQueries(jsonl: string): LabeledQuery[] {
  return parseJsonl<LabeledQuery>(jsonl, (row, line) => {
    if (typeof row.id !== 'string' || !row.id) throw new Error(`query line ${line}: missing id`);
    if (row.type !== 'code' && row.type !== 'lesson') {
      throw new Error(`query line ${line}: unknown type ${String(row.type)}`);
    }
    if (typeof row.query !== 'string' || !row.query) throw new Error(`query line ${line}: missing query`);
    if (!Array.isArray(row.relevant) || row.relevant.length === 0) {
      throw new Error(`query line ${line}: relevant must be a non-empty id array`);
    }
  });
}

function parseJsonl<T>(jsonl: string, validate: (row: T, line: number) => void): T[] {
  const rows: T[] = [];
  const lines = jsonl.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    let row: T;
    try {
      row = JSON.parse(line) as T;
    } catch {
      throw new Error(`invalid JSONL at line ${i + 1}`);
    }
    validate(row, i + 1);
    rows.push(row);
  }
  return rows;
}

/**
 * Deterministic dev/held-out split by query-id hash. ~2/3 dev, ~1/3 held-out;
 * the same query always lands in the same split regardless of dataset order.
 */
export function splitQueries(queries: readonly LabeledQuery[]): {
  dev: LabeledQuery[];
  heldOut: LabeledQuery[];
} {
  const dev: LabeledQuery[] = [];
  const heldOut: LabeledQuery[] = [];
  for (const query of queries) {
    (hashText(query.id) % 3 === 0 ? heldOut : dev).push(query);
  }
  return { dev, heldOut };
}

/** Cross-check that every labeled relevant id exists in the corpus. */
export function validateDataset(dataset: RetrievalDataset): string[] {
  const ids = new Set(dataset.corpus.map((doc) => doc.id));
  const problems: string[] = [];
  for (const query of dataset.queries) {
    for (const rel of query.relevant) {
      if (!ids.has(rel)) problems.push(`query ${query.id}: relevant id ${rel} not in corpus`);
    }
    const typeMismatch = dataset.corpus.find(
      (doc) => query.relevant.includes(doc.id) && doc.type !== query.type,
    );
    if (typeMismatch) {
      problems.push(`query ${query.id}: relevant id ${typeMismatch.id} has type ${typeMismatch.type}, query is ${query.type}`);
    }
  }
  return problems;
}
