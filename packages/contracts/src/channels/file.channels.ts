/**
 * IPC channels for file system operations, external editor integration,
 * dialog windows, and image handling.
 */
export const FILE_CHANNELS = {
  // File operations
  FILE_DROP: 'file:drop',
  FILE_READ_DIR: 'file:read-dir',
  FILE_GET_STATS: 'file:get-stats',
  FILE_READ_TEXT: 'file:read-text',
  FILE_READ_BYTES: 'file:read-bytes',
  FILE_WRITE_TEXT: 'file:write-text',
  FILE_OPEN_PATH: 'file:open-path',
  FILE_OPEN_TERMINAL: 'file:open-terminal',
  FILE_COPY_TO_CLIPBOARD: 'file:copy-to-clipboard',

  // Ecosystem operations (file-based extensibility)
  ECOSYSTEM_LIST: 'ecosystem:list',
  ECOSYSTEM_WATCH_START: 'ecosystem:watch-start',
  ECOSYSTEM_WATCH_STOP: 'ecosystem:watch-stop',
  ECOSYSTEM_CHANGED: 'ecosystem:changed',

  // External Editor
  EDITOR_DETECT: 'editor:detect',
  EDITOR_OPEN: 'editor:open',
  EDITOR_OPEN_FILE: 'editor:open-file',
  EDITOR_OPEN_FILE_AT_LINE: 'editor:open-file-at-line',
  EDITOR_OPEN_DIRECTORY: 'editor:open-directory',
  EDITOR_SET_PREFERRED: 'editor:set-preferred',
  EDITOR_SET_DEFAULT: 'editor:set-default',
  EDITOR_GET_PREFERRED: 'editor:get-preferred',
  EDITOR_GET_DEFAULT: 'editor:get-default',
  EDITOR_GET_AVAILABLE: 'editor:get-available',

  // Dialog operations
  DIALOG_SELECT_FOLDER: 'dialog:select-folder',
  DIALOG_SELECT_FILES: 'dialog:select-files',

  // Image operations
  IMAGE_PASTE: 'image:paste',
  IMAGE_COPY_TO_CLIPBOARD: 'image:copy-to-clipboard',
  IMAGE_COPY_MESSAGE: 'image:copy-message',
  IMAGE_CONTEXT_MENU: 'image:context-menu',
  IMAGE_RESOLVE: 'image:resolve',

  // File Watcher
  WATCHER_START: 'watcher:start',
  WATCHER_STOP: 'watcher:stop',
  WATCHER_STOP_ALL: 'watcher:stop-all',
  WATCHER_WATCH: 'watcher:watch',
  WATCHER_UNWATCH: 'watcher:unwatch',
  WATCHER_GET_ACTIVE: 'watcher:get-active',
  WATCHER_GET_SESSIONS: 'watcher:get-sessions',
  WATCHER_GET_CHANGES: 'watcher:get-changes',
  WATCHER_CLEAR_BUFFER: 'watcher:clear-buffer',
  WATCHER_FILE_CHANGED: 'watcher:file-changed',
  WATCHER_ERROR: 'watcher:error',
} as const;
