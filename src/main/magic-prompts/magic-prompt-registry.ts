/**
 * Magic Prompt Registry
 *
 * "Magic prompts" are single-turn, schema-backed commands: they ask a provider
 * for a JSON object matching a fixed shape (recap a thread, draft a commit
 * message, summarize a diff) instead of free text we then have to re-parse.
 *
 * The design here is intentionally provider-agnostic: rather than depend on a
 * given CLI's `--json-schema` / `--output-schema` flag (which not every provider
 * exposes the same way), each definition carries (a) a Zod schema that validates
 * the result and (b) a human-readable `schemaHint` appended to the prompt to
 * steer the model. The runner extracts JSON from the response and validates it
 * against the Zod schema, so a provider that ignores native schema flags still
 * produces a typed, validated result.
 */

import { z } from 'zod';

/** Input handed to a magic prompt. `text` is the primary subject material. */
export interface MagicPromptInput {
  text: string;
  context?: string;
}

export interface MagicPromptDefinition<T = unknown> {
  /** Stable identifier used over IPC and in the command surface. */
  id: string;
  /** Short human label. */
  title: string;
  /** One-line description of what it produces. */
  description: string;
  /** Label describing what `input.text` should contain (transcript, diff, …). */
  inputLabel: string;
  /** System prompt steering the one-shot adapter. */
  systemPrompt: string;
  /** Builds the user prompt from the supplied input. */
  buildPrompt(input: MagicPromptInput): string;
  /** Validates (and types) the structured result. */
  schema: z.ZodType<T>;
  /** JSON shape hint appended to the prompt so the model returns the right keys. */
  schemaHint: string;
}

const JSON_ONLY_SYSTEM =
  'You are a precise assistant that replies with ONLY a single JSON object and no other text, ' +
  'no markdown fences, and no commentary. The JSON must match the requested shape exactly.';

// --- recap -----------------------------------------------------------------

const RecapSchema = z.object({
  summary: z.string(),
  keyPoints: z.array(z.string()),
  openQuestions: z.array(z.string()),
  nextSteps: z.array(z.string()),
});
export type RecapResult = z.infer<typeof RecapSchema>;

const recap: MagicPromptDefinition<RecapResult> = {
  id: 'recap',
  title: 'Recap thread',
  description: 'Summarize a conversation into key points, open questions, and next steps.',
  inputLabel: 'conversation transcript',
  systemPrompt: JSON_ONLY_SYSTEM,
  buildPrompt: ({ text, context }) =>
    `Recap the following conversation. Capture what was decided, what is still ` +
    `unresolved, and what to do next.${context ? `\n\nAdditional context:\n${context}` : ''}` +
    `\n\nConversation:\n${text}`,
  schema: RecapSchema,
  schemaHint:
    '{\n  "summary": string,\n  "keyPoints": string[],\n  "openQuestions": string[],\n  "nextSteps": string[]\n}',
};

// --- commit-message --------------------------------------------------------

const CommitMessageSchema = z.object({
  type: z.enum(['feat', 'fix', 'chore', 'refactor', 'docs', 'test', 'perf', 'build', 'ci', 'style']),
  subject: z.string(),
  body: z.string(),
});
export type CommitMessageResult = z.infer<typeof CommitMessageSchema>;

const commitMessage: MagicPromptDefinition<CommitMessageResult> = {
  id: 'commit-message',
  title: 'Commit message',
  description: 'Draft a Conventional-Commits message from a staged diff.',
  inputLabel: 'git diff',
  systemPrompt: JSON_ONLY_SYSTEM,
  buildPrompt: ({ text, context }) =>
    `Write a Conventional Commits message for the following diff. The subject must be ` +
    `imperative mood and at most 72 characters (no trailing period). The body should explain ` +
    `the what and why in a few short lines (may be empty for trivial changes).` +
    `${context ? `\n\nAdditional context:\n${context}` : ''}\n\nDiff:\n${text}`,
  schema: CommitMessageSchema,
  schemaHint:
    '{\n  "type": "feat" | "fix" | "chore" | "refactor" | "docs" | "test" | "perf" | "build" | "ci" | "style",\n  "subject": string,  // <= 72 chars, imperative, no trailing period\n  "body": string      // may be empty\n}',
};

// --- summarize-diff --------------------------------------------------------

const DiffSummarySchema = z.object({
  summary: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      summary: z.string(),
    }),
  ),
  risk: z.enum(['low', 'medium', 'high']),
});
export type DiffSummaryResult = z.infer<typeof DiffSummarySchema>;

const summarizeDiff: MagicPromptDefinition<DiffSummaryResult> = {
  id: 'summarize-diff',
  title: 'Summarize diff',
  description: 'Explain a diff: overall summary, per-file notes, and a risk rating.',
  inputLabel: 'git diff',
  systemPrompt: JSON_ONLY_SYSTEM,
  buildPrompt: ({ text, context }) =>
    `Summarize the following diff for a reviewer. Give an overall summary, a one-line note ` +
    `per changed file, and an overall risk rating (low/medium/high) reflecting the chance the ` +
    `change introduces a regression.${context ? `\n\nAdditional context:\n${context}` : ''}` +
    `\n\nDiff:\n${text}`,
  schema: DiffSummarySchema,
  schemaHint:
    '{\n  "summary": string,\n  "files": { "path": string, "summary": string }[],\n  "risk": "low" | "medium" | "high"\n}',
};

// --- registry --------------------------------------------------------------

const DEFINITIONS: readonly MagicPromptDefinition[] = [recap, commitMessage, summarizeDiff];

const BY_ID = new Map<string, MagicPromptDefinition>(DEFINITIONS.map((d) => [d.id, d]));

export function getMagicPrompt(id: string): MagicPromptDefinition | undefined {
  return BY_ID.get(id);
}

/** Lightweight, serializable catalog entry for the renderer/command surface. */
export interface MagicPromptSummary {
  id: string;
  title: string;
  description: string;
  inputLabel: string;
}

export function listMagicPrompts(): MagicPromptSummary[] {
  return DEFINITIONS.map(({ id, title, description, inputLabel }) => ({
    id,
    title,
    description,
    inputLabel,
  }));
}

export const MAGIC_PROMPT_IDS = DEFINITIONS.map((d) => d.id);
