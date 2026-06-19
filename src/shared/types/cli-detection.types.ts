/**
 * CLI Detection Types
 * Shared type definitions for CLI tool detection and identification.
 */

/**
 * CLI type identifiers
 */
export type CliType =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'antigravity'
  | 'ollama'
  | 'aider'
  | 'continue'
  | 'cursor'
  | 'copilot';

/**
 * Information about a detected CLI tool
 */
export interface CliInfo {
  name: string;
  command: string;
  displayName: string;
  installed: boolean;
  version?: string;
  path?: string;
  authenticated?: boolean;
  error?: string;
  capabilities?: string[];
}
