/**
 * WS-C6 context manifest — shared contract between
 * `context-manifest-store.ts` and the renderer's context-attribution panel.
 *
 * Read-only observability: answers "which version of the project brief (and
 * every other AIO-owned system-prompt source) did this running session
 * actually get, and when". Nothing here changes what is sent to a provider,
 * and it is authoritative ONLY for AIO-owned inputs — a provider's own
 * internal prompt cache/session state is never observable from AIO, so
 * there is deliberately no "provider-confirmed" status (see
 * {@link ContextManifestEntryStatus}).
 */

/** The nine block kinds instance-system-prompt.ts may inject — mirrors SystemPromptBlockKind. */
export type ContextManifestBlockKind =
  | 'instructions'
  | 'output-style'
  | 'observation-memory'
  | 'project-brief'
  | 'lessons'
  | 'repo-map'
  | 'wake-context'
  | 'mcp-tool-context'
  | 'tool-permissions';

export type ContextManifestEntryStatus = 'supplied' | 'skipped-empty' | 'unavailable';

export interface ContextManifestEntry {
  kind: ContextManifestBlockKind;
  status: ContextManifestEntryStatus;
  /** sha256 hex digest — only set when status is 'supplied'. Never raw content. */
  contentHash?: string;
  charLength?: number;
  position?: number;
}

export type ContextManifestTrigger = 'spawn' | 'respawn' | 'restart-compact';

export interface ContextManifestSnapshot {
  epoch: number;
  at: number;
  trigger: ContextManifestTrigger;
  entries: ContextManifestEntry[];
  note?: string;
}

export interface ContextManifestReport {
  instanceId: string;
  /** Bounded epoch history, oldest first. */
  history: ContextManifestSnapshot[];
}
