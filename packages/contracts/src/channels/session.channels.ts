/**
 * IPC channels for session management, archiving, and history.
 */
export const SESSION_CHANNELS = {
  // Session operations
  SESSION_FORK: 'session:fork',
  SESSION_EXPORT: 'session:export',
  SESSION_IMPORT: 'session:import',
  SESSION_COPY_TO_CLIPBOARD: 'session:copy-to-clipboard',
  SESSION_SAVE_TO_FILE: 'session:save-to-file',
  SESSION_REVEAL_FILE: 'session:reveal-file',
  SESSION_SHARE_PREVIEW: 'session:share-preview',
  SESSION_SHARE_SAVE: 'session:share-save',
  SESSION_SHARE_LOAD: 'session:share-load',
  SESSION_SHARE_REPLAY: 'session:share-replay',
  SESSION_LIST_RESUMABLE: 'session:list-resumable',
  SESSION_RESUME: 'session:resume',
  SESSION_LIST_SNAPSHOTS: 'session:list-snapshots',
  SESSION_CREATE_SNAPSHOT: 'session:create-snapshot',
  SESSION_GET_STATS: 'session:get-stats',

  // Snapshot operations (file revert)
  SNAPSHOT_TAKE: 'snapshot:take',
  SNAPSHOT_START_SESSION: 'snapshot:start-session',
  SNAPSHOT_END_SESSION: 'snapshot:end-session',
  SNAPSHOT_GET_FOR_INSTANCE: 'snapshot:get-for-instance',
  SNAPSHOT_GET_FOR_FILE: 'snapshot:get-for-file',
  SNAPSHOT_GET_SESSIONS: 'snapshot:get-sessions',
  SNAPSHOT_GET_CONTENT: 'snapshot:get-content',
  SNAPSHOT_REVERT_FILE: 'snapshot:revert-file',
  SNAPSHOT_REVERT_SESSION: 'snapshot:revert-session',
  SNAPSHOT_GET_DIFF: 'snapshot:get-diff',
  SNAPSHOT_DELETE: 'snapshot:delete',
  SNAPSHOT_CLEANUP: 'snapshot:cleanup',
  SNAPSHOT_GET_STATS: 'snapshot:get-stats',

  // Session Archiving
  ARCHIVE_SESSION: 'archive:session',
  ARCHIVE_RESTORE: 'archive:restore',
  ARCHIVE_DELETE: 'archive:delete',
  ARCHIVE_LIST: 'archive:list',
  ARCHIVE_SEARCH: 'archive:search',
  ARCHIVE_GET_META: 'archive:get-meta',
  ARCHIVE_UPDATE_TAGS: 'archive:update-tags',
  ARCHIVE_GET_STATS: 'archive:get-stats',
  ARCHIVE_CLEANUP: 'archive:cleanup',

  // History operations
  HISTORY_LIST: 'history:list',
  HISTORY_LOAD: 'history:load',
  HISTORY_ARCHIVE: 'history:archive',
  HISTORY_DELETE: 'history:delete',
  HISTORY_RESTORE: 'history:restore',
  HISTORY_CLEAR: 'history:clear',
  HISTORY_SEARCH_ADVANCED: 'history:search-advanced',
  HISTORY_EXPAND_SNIPPETS: 'history:expand-snippets',

  // Resume picker operations
  RESUME_LATEST: 'resume:latest',
  RESUME_BY_ID: 'resume:by-id',
  RESUME_SWITCH_TO_LIVE: 'resume:switch-to-live',
  RESUME_FORK_NEW: 'resume:fork-new',
  RESUME_RESTORE_FALLBACK: 'resume:restore-fallback',
} as const;
