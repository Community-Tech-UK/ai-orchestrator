/**
 * Session reference resolver (backlog #31).
 *
 * Resolves `@T-<id>` cross-references inside a prompt to the referenced session,
 * so a user can write "implement the plan from @T-s7j4x1q9w" and have the
 * referenced session's title/summary pulled in. The `<id>` may be a full session
 * id or a unique prefix of one.
 *
 * This is a pure, injectable resolver: the lookup is supplied (defaulting to the
 * SessionRecallService archive search), so it is unit-testable without a store.
 */

import type { SessionRecallResult, SessionRecallSource } from '../../shared/types/session-recall.types';
import { getSessionRecallService } from './session-recall-service';

/** `@T-<id>` — id is 2–64 chars of [A-Za-z0-9_-]. */
const REF_PATTERN = /@T-([A-Za-z0-9_-]{2,64})/g;

export interface ResolvedSessionRef {
  /** The full token as it appeared, e.g. '@T-s7j4x1q9w'. */
  token: string;
  /** The id portion, e.g. 's7j4x1q9w'. */
  id: string;
  /** Whether a session was matched. */
  found: boolean;
  /** Matched session id (may differ from `id` when `id` was a prefix). */
  sessionId?: string;
  title?: string;
  summary?: string;
}

export interface SessionReferenceResolution {
  refs: ResolvedSessionRef[];
  /** Original text with each resolved token annotated as `@T-<id> ("title")`. */
  annotatedText: string;
  /** A prependable context block describing resolved sessions ('' when none). */
  contextBlock: string;
}

export interface SessionReferenceResolverDeps {
  search(query: string, sources?: SessionRecallSource[], limit?: number): Promise<SessionRecallResult[]>;
}

const DEFAULT_DEPS: SessionReferenceResolverDeps = {
  search: (query, sources, limit) =>
    getSessionRecallService().search({ query, sources, limit }),
};

/** Extract the unique `@T-<id>` ids referenced in `text`, in first-seen order. */
export function parseSessionRefTokens(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(REF_PATTERN)) {
    const id = m[1];
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/** Pick the best archived-session match for an id (exact > prefix, by score). */
function pickMatch(id: string, results: SessionRecallResult[]): SessionRecallResult | null {
  // Exact id, or the user typed a prefix of a (longer) full session id. We do
  // NOT match when the result id is a prefix of the user's id — valid ids are
  // fixed-length, so a shorter stored id matching a longer typed id would be a
  // false positive (e.g. "@T-abc123xyz" must not resolve to session "abc").
  const candidates = results.filter((r) => r.id === id || r.id.startsWith(id));
  if (candidates.length === 0) return null;
  // Prefer an exact id match; otherwise the highest-scoring candidate.
  const exact = candidates.find((r) => r.id === id);
  if (exact) return exact;
  return candidates.reduce((best, r) => (r.score > best.score ? r : best));
}

export async function resolveSessionReferences(
  text: string,
  deps: SessionReferenceResolverDeps = DEFAULT_DEPS,
): Promise<SessionReferenceResolution> {
  const ids = parseSessionRefTokens(text);
  if (ids.length === 0) {
    return { refs: [], annotatedText: text, contextBlock: '' };
  }

  const refs: ResolvedSessionRef[] = await Promise.all(
    ids.map(async (id): Promise<ResolvedSessionRef> => {
      const token = `@T-${id}`;
      try {
        const results = await deps.search(id, ['archived_session'], 5);
        const match = pickMatch(id, results);
        if (match) {
          return { token, id, found: true, sessionId: match.id, title: match.title, summary: match.summary };
        }
      } catch {
        // fall through to "not found"
      }
      return { token, id, found: false };
    }),
  );

  const byId = new Map(refs.map((r) => [r.id, r]));

  // Annotate each token occurrence with the resolved title (idempotent per match).
  const annotatedText = text.replace(REF_PATTERN, (full, id: string) => {
    const ref = byId.get(id);
    return ref?.found && ref.title ? `${full} ("${ref.title}")` : full;
  });

  const resolved = refs.filter((r) => r.found);
  const contextBlock =
    resolved.length === 0
      ? ''
      : 'Referenced sessions:\n' +
        resolved
          .map((r) => `- @T-${r.id}: ${r.title ?? '(untitled)'}${r.summary ? ` — ${r.summary}` : ''}`)
          .join('\n');

  return { refs, annotatedText, contextBlock };
}
