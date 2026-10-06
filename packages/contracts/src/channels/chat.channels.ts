/**
 * IPC channels for durable top-level Chats and session-linked sidechats.
 */
export const CHAT_CHANNELS = {
  CHAT_LIST: 'chat:list',
  CHAT_GET: 'chat:get',
  CHAT_CREATE: 'chat:create',
  CHAT_RENAME: 'chat:rename',
  CHAT_ARCHIVE: 'chat:archive',
  CHAT_DELETE: 'chat:delete',
  CHAT_SET_CWD: 'chat:set-cwd',
  CHAT_SET_PROVIDER: 'chat:set-provider',
  CHAT_SET_MODEL: 'chat:set-model',
  CHAT_SET_REASONING: 'chat:set-reasoning',
  CHAT_SET_YOLO: 'chat:set-yolo',
  CHAT_LOAD_OLDER_MESSAGES: 'chat:load-older-messages',
  CHAT_SEND_MESSAGE: 'chat:send-message',
  CHAT_UI_STATE_GET: 'chat:ui-state-get',
  CHAT_UI_STATE_SET: 'chat:ui-state-set',
  CHAT_EVENT: 'chat:event',
  // Session-linked sidechats
  SIDE_CHAT_CREATE: 'side-chat:create',
  SIDE_CHAT_LIST: 'side-chat:list',
  SIDE_CHAT_SEND: 'side-chat:send',
  SIDE_CHAT_MARK_READ: 'side-chat:mark-read',
  SIDE_CHAT_ATTENTION: 'side-chat:attention',
  SIDE_CHAT_ATTENTION_ALL: 'side-chat:attention-all',
  SIDE_CHAT_SET_SELECTION: 'side-chat:set-selection',
  SIDE_CHAT_ATTACH: 'side-chat:attach',
  SIDE_CHAT_PERMISSIONS: 'side-chat:permissions',
} as const;
