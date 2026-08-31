import type { ConversationHistoryEntry, HistorySnippet } from '../../../../shared/types/history.types';
import type { SessionRecoveryCandidate } from '../../../../shared/types/session-recovery.types';
import type { Instance } from '../../core/state/instance/instance.types';

export type ResumePickerAction =
  | 'resumeLatest'
  | 'resumeById'
  | 'switchToLive'
  | 'forkNew'
  | 'restoreFromFallback'
  | 'recoverAutosave';

export type ResumePickerItemKind = 'latest' | 'live' | 'history' | 'archived' | 'recovery';

export interface ResumePickerItem {
  id: string;
  kind: ResumePickerItemKind;
  title: string;
  subtitle: string;
  projectPath?: string;
  provider?: string;
  lastActivity?: number;
  availableActions: ResumePickerAction[];
  entry?: ConversationHistoryEntry;
  instance?: Instance;
  recoveryCandidate?: SessionRecoveryCandidate;
  snippets?: HistorySnippet[];
  nativeResumeFailedAt?: number | null;
  frecencyScore?: number;
}
