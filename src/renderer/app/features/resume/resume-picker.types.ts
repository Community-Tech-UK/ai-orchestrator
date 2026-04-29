import type { ConversationHistoryEntry, HistorySnippet } from '../../../../shared/types/history.types';
import type { Instance } from '../../core/state/instance/instance.types';

export type ResumePickerAction =
  | 'resumeLatest'
  | 'resumeById'
  | 'switchToLive'
  | 'forkNew'
  | 'restoreFromFallback';

export type ResumePickerItemKind = 'latest' | 'live' | 'history' | 'archived';

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
  snippets?: HistorySnippet[];
  nativeResumeFailedAt?: number | null;
  frecencyScore?: number;
}
