/**
 * ID Generation Utilities
 */

import type { InstanceId } from '../types/branded-ids';
import { toInstanceId } from '../types/branded-ids';

/**
 * Generate a UUID v4
 */
export function generateId(): string {
  // Use crypto.randomUUID if available (Node 19+, modern browsers)
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  // Fallback for older environments
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Generate a short ID (8 characters)
 */
export function generateShortId(): string {
  return generateId().slice(0, 8);
}

/**
 * Generate a secure token (64 hex characters)
 */
export function generateToken(): string {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Fallback - less secure but functional
  let token = '';
  for (let i = 0; i < 64; i++) {
    token += Math.floor(Math.random() * 16).toString(16);
  }
  return token;
}

/**
 * Generate a timestamped ID for ordering
 */
export function generateTimestampedId(): string {
  const timestamp = Date.now().toString(36);
  const random = generateShortId();
  return `${timestamp}-${random}`;
}

/**
 * Alphabet for prefixed IDs: digits + lowercase = 36 chars
 * 36^8 ≈ 2.8 trillion combinations — collision-resistant, filesystem-safe
 */
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Generate a type-prefixed ID with cryptographic randomness.
 *
 * Format: prefix + 8 random chars from [0-9a-z]
 * Example: "c" + "8f3k2m1p" = "c8f3k2m1p" (Claude instance)
 *
 * The prefix makes IDs human-debuggable: you can tell what type of
 * entity an ID represents at a glance. The cryptographic randomness
 * prevents brute-force guessing (e.g., symlink attacks on task files).
 */
export function generatePrefixedId(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let id = prefix;
  for (let i = 0; i < 8; i++) {
    id += ID_ALPHABET[bytes[i] % 36];
  }
  return id;
}

/** Provider prefixes for instance IDs */
export const INSTANCE_ID_PREFIXES = {
  claude: 'c',
  gemini: 'g',
  codex: 'x',
  copilot: 'p',
  anthropic: 'a',
  generic: 'i',
} as const;

export type InstanceProvider = keyof typeof INSTANCE_ID_PREFIXES;

/**
 * Generate a provider-prefixed instance ID.
 *
 * Examples:
 *   generateInstanceId('claude')  → "c8f3k2m1p0"
 *   generateInstanceId('gemini')  → "gj4n7x2q1"
 *   generateInstanceId()          → "i9m3p5r7w2"
 */
export function generateInstanceId(provider: InstanceProvider = 'generic'): InstanceId {
  return toInstanceId(generatePrefixedId(INSTANCE_ID_PREFIXES[provider]));
}

/** Orchestration prefixes */
export const ORCHESTRATION_ID_PREFIXES = {
  debate: 'd',
  verification: 'v',
  consensus: 'n',
  worktree: 'w',
  session: 's',
} as const;

export type OrchestrationType = keyof typeof ORCHESTRATION_ID_PREFIXES;

/**
 * Generate an orchestration-type-prefixed ID.
 *
 * Examples:
 *   generateOrchestrationId('debate')  → "d5k2m8n3p"
 *   generateOrchestrationId('session') → "s7j4x1q9w"
 */
export function generateOrchestrationId(type: OrchestrationType): string {
  return generatePrefixedId(ORCHESTRATION_ID_PREFIXES[type]);
}
