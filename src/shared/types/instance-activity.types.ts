/** Shared instance activity summaries; type-only to keep runtime consumers isolated. */
export type { InstanceBackgroundWork } from './instance-background-work.types';

/** Live native helpers inside this provider session, including foreground work; excludes shell jobs and child sessions. */
export interface NativeHelperSummary {
  running: number;
}

/**
 * An idle instance offered to memory-pressure reclamation.
 *
 * `hasConversation` is the hibernate/terminate switch: instances holding user
 * work are hibernated (recoverable — the session stays in the list and can be
 * woken), and only empty ones are terminated.
 */
export interface IdleInstanceInfo {
  id: string;
  lastActivity: number;
  displayName: string;
  hasConversation: boolean;
}
