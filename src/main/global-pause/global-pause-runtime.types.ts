import type { GlobalPauseEntry } from '@contracts/schemas/global-pause';
export class GlobalPauseUnsafeError extends Error {}
export interface PauseSessionSnapshot {
  id: string;
  displayName: string;
  workspace?: string;
  provider?: string;
  originalInstanceId?: string;
  historyThreadId?: string;
  providerSessionId?: string;
  busy: boolean;
  waitingForInitialization?: boolean;
  lastRequest: string;
  lastReply: string;
  helperReplies: string[];
  unavailableReason?: string;
}
export interface PauseEngineSnapshot {
  kind: Exclude<GlobalPauseEntry['kind'], 'session'>;
  id: string;
  displayName: string;
  originalInstanceId?: string | null;
  historyThreadId?: string | null;
  providerSessionId?: string | null;
}
export interface GlobalPauseRuntime {
  sessions(): PauseSessionSnapshot[];
  sessionIdentities?(id: string): string[];
  targetVoided?(identities: string[], reason: string): void;
  engines(): Promise<PauseEngineSnapshot[]>;
  pauseEngines(entries: PauseEngineSnapshot[]): Promise<void>;
  stopHelpers(sessionId: string): Promise<void>;
  interruptSession(session: PauseSessionSnapshot): Promise<boolean>;
  collectNote(session: PauseSessionSnapshot, signal: AbortSignal): Promise<string | null>;
  resumeSession(entry: GlobalPauseEntry): Promise<string>;
  resumeEngine(entry: GlobalPauseEntry): Promise<void>;
  level(): number;
  runningWork?(): { sessions: number; queueJobs: number; loops: number };
}

export function basicPauseNote(session: PauseSessionSnapshot): string {
  return `Task\n${session.lastRequest.slice(0, 3000) || 'Reopen the conversation to see the current task.'}\nDone\n${session.lastReply.slice(0, 3000) || 'No reply was available.'}\nIn progress\n${session.unavailableReason ?? 'The session was interrupted for a restart.'}\n${session.helperReplies.map((reply) => `Helper: ${reply.slice(0, 1500)}`).join('\n')}\nNext step\nCheck the conversation and continue the current task.\nWaiting on James\n${session.unavailableReason ? 'Review this basic note before continuing.' : 'Nothing recorded.'}`;
}
