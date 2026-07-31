/**
 * System-prompt injection contract (WS-B4).
 *
 * The Claude/Codex/Gemini/Copilot prompt-cache prefix is only reusable across
 * turns if the assembled system prompt is byte-stable for identical inputs.
 * This module is the single, locked contract for that assembly:
 *
 * - `SYSTEM_PROMPT_BLOCK_ORDER` is the hard-coded sequence every block must be
 *   added in. It mirrors the real order instance-lifecycle.ts assembles today
 *   (instructions/agent prompt first, tool-permissions last).
 * - `createSystemPromptComposer()` enforces that order at runtime (out-of-order
 *   or duplicate `add()` calls throw — those are programmer errors, not data
 *   errors) and joins blocks with the exact `\n\n---\n\n` separator used
 *   throughout the codebase today, skipping blocks with empty/undefined
 *   content so no stray separators appear.
 * - `findVolatileText()` is a heuristic scanner for content that would bust a
 *   cached prefix (timestamps, epoch-millisecond numbers, UUIDs, generatedAt-
 *   style keys). New callers should not add volatile content to any of these
 *   blocks: put it in the LAST block position (`tool-permissions`, or a new
 *   kind appended after it) or, better, in a per-turn user message instead —
 *   the system prompt should stay identical turn over turn.
 *
 * Changing `SYSTEM_PROMPT_BLOCK_ORDER` (reordering, inserting, or removing a
 * kind) changes the assembled prefix for every existing session and is a
 * deliberate cache-busting release event, not a routine refactor. The
 * ORDER-SNAPSHOT test in prompt-injection-contract.spec.ts hard-fails on any
 * change to make that decision visible in review.
 */

import { createHash } from 'node:crypto';

// ============================================
// Block order contract
// ============================================

/**
 * Every kind of content instance-lifecycle.ts may inject into a system
 * prompt, in the exact order it injects them today. See instance-lifecycle.ts
 * (the `backgroundInit` system-prompt assembly section) for the source of
 * truth this was derived from.
 */
export type SystemPromptBlockKind =
  | 'instructions'
  | 'output-style'
  | 'observation-memory'
  | 'project-brief'
  | 'lessons'
  | 'repo-map'
  | 'wake-context'
  | 'mcp-tool-context'
  | 'tool-permissions';

/**
 * The locked block order. Changing this array is a cache-busting release
 * decision: every prefix already cached by a provider becomes stale the
 * moment this ships, and it must be made deliberately (see module header).
 */
export const SYSTEM_PROMPT_BLOCK_ORDER: readonly SystemPromptBlockKind[] = [
  'instructions',
  'output-style',
  'observation-memory',
  'project-brief',
  'lessons',
  'repo-map',
  'wake-context',
  'mcp-tool-context',
  'tool-permissions',
];

/** The exact separator used between blocks throughout the codebase today. */
export const SYSTEM_PROMPT_BLOCK_SEPARATOR = '\n\n---\n\n';

export interface SystemPromptBlockManifestEntry {
  kind: SystemPromptBlockKind;
  /** sha256 hex digest of the block's content. */
  contentHash: string;
  charLength: number;
  /** 0-based index into the composed (non-empty) block list. */
  position: number;
}

export interface SystemPromptComposeResult {
  text: string;
  manifest: SystemPromptBlockManifestEntry[];
}

export interface SystemPromptComposer {
  /**
   * Register a block's content at its contract position. `content` may be
   * empty/null/undefined — such blocks are skipped entirely (matching
   * today's conditional appends), but the `add()` call itself still counts
   * for order/duplicate enforcement.
   *
   * Throws if `kind` is added out of order relative to
   * `SYSTEM_PROMPT_BLOCK_ORDER`, or if `kind` has already been added. Both
   * are programmer errors: instance-lifecycle.ts assembly is meant to call
   * `add()` at most once per kind, in contract order.
   */
  add(kind: SystemPromptBlockKind, content: string | null | undefined): void;
  /** Join the added, non-empty blocks and return the manifest. */
  compose(): SystemPromptComposeResult;
}

/**
 * Create a fresh composer for one system-prompt assembly. Not reusable across
 * instances/turns — construct a new one per assembly.
 */
export function createSystemPromptComposer(): SystemPromptComposer {
  const addedKinds = new Set<SystemPromptBlockKind>();
  let lastOrderIndex = -1;
  const blocks: { kind: SystemPromptBlockKind; content: string }[] = [];

  return {
    add(kind, content) {
      const orderIndex = SYSTEM_PROMPT_BLOCK_ORDER.indexOf(kind);
      if (orderIndex === -1) {
        throw new Error(`prompt-injection-contract: unknown system-prompt block kind "${kind}"`);
      }
      if (addedKinds.has(kind)) {
        throw new Error(`prompt-injection-contract: duplicate system-prompt block "${kind}"`);
      }
      if (orderIndex < lastOrderIndex) {
        throw new Error(
          `prompt-injection-contract: system-prompt block "${kind}" added out of order ` +
          `(SYSTEM_PROMPT_BLOCK_ORDER position ${orderIndex} is before the last-added position ${lastOrderIndex})`,
        );
      }

      addedKinds.add(kind);
      lastOrderIndex = orderIndex;

      const text = content ?? '';
      if (text.length === 0) {
        return;
      }
      blocks.push({ kind, content: text });
    },

    compose() {
      const text = blocks.map((block) => block.content).join(SYSTEM_PROMPT_BLOCK_SEPARATOR);
      const manifest = blocks.map((block, position) => ({
        kind: block.kind,
        contentHash: sha256Hex(block.content),
        charLength: block.content.length,
        position,
      }));
      return { text, manifest };
    },
  };
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ============================================
// Volatile-text scanner
// ============================================

export type VolatileTextFindingKind =
  | 'iso-timestamp'
  | 'epoch-millis'
  | 'uuid'
  | 'generated-at-key';

export interface VolatileTextFinding {
  kind: VolatileTextFindingKind;
  /** The exact substring that matched. */
  match: string;
  /** Character offset of the match within the scanned text. */
  index: number;
}

const ISO_TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
// 13-digit numbers in the epoch-millisecond range for 2020-01-01..2040-01-01.
const EPOCH_MILLIS_RE = /\b\d{13}\b/g;
const EPOCH_MILLIS_MIN = 1_577_836_800_000; // 2020-01-01T00:00:00Z
const EPOCH_MILLIS_MAX = 2_208_988_800_000; // 2040-01-01T00:00:00Z
const GENERATED_AT_KEY_RE = /\b(generatedAt|generated_at|createdAt|created_at|timestamp)\b"?\s*[:=]\s*"?(\d{9,14})"?/gi;

/**
 * Heuristically scan rendered prompt text for content that would make it
 * time/instance-dependent (and therefore cache-busting turn over turn).
 * Used by tests and available for future runtime diagnostics; does not
 * mutate or reject anything on its own.
 */
export function findVolatileText(text: string): VolatileTextFinding[] {
  const findings: VolatileTextFinding[] = [];

  for (const match of text.matchAll(ISO_TIMESTAMP_RE)) {
    findings.push({ kind: 'iso-timestamp', match: match[0], index: match.index ?? -1 });
  }

  for (const match of text.matchAll(UUID_RE)) {
    findings.push({ kind: 'uuid', match: match[0], index: match.index ?? -1 });
  }

  for (const match of text.matchAll(EPOCH_MILLIS_RE)) {
    const value = Number(match[0]);
    if (value >= EPOCH_MILLIS_MIN && value <= EPOCH_MILLIS_MAX) {
      findings.push({ kind: 'epoch-millis', match: match[0], index: match.index ?? -1 });
    }
  }

  for (const match of text.matchAll(GENERATED_AT_KEY_RE)) {
    findings.push({ kind: 'generated-at-key', match: match[0], index: match.index ?? -1 });
  }

  return findings.sort((a, b) => a.index - b.index);
}
