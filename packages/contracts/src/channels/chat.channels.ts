/**
 * IPC channels for durable top-level Chats.
 */
export const CHAT_CHANNELS = {
  CHAT_LIST: 'chat:list',
  CHAT_GET: 'chat:get',
  CHAT_CREATE: 'chat:create',
  CHAT_RENAME: 'chat:rename',
  CHAT_ARCHIVE: 'chat:archive',
  CHAT_SET_CWD: 'chat:set-cwd',
  CHAT_SET_PROVIDER: 'chat:set-provider',
  CHAT_SET_MODEL: 'chat:set-model',
  CHAT_SET_REASONING: 'chat:set-reasoning',
  CHAT_SET_YOLO: 'chat:set-yolo',
  CHAT_SEND_MESSAGE: 'chat:send-message',
  CHAT_EVENT: 'chat:event',
} as const;
