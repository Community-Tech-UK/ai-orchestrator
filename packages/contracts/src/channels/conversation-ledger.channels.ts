/**
 * IPC channels for provider-native conversation ledger operations.
 */
export const CONVERSATION_LEDGER_CHANNELS = {
  CONVERSATION_LEDGER_LIST: 'conversation-ledger:list',
  CONVERSATION_LEDGER_GET: 'conversation-ledger:get',
  CONVERSATION_LEDGER_DISCOVER: 'conversation-ledger:discover',
  CONVERSATION_LEDGER_RECONCILE: 'conversation-ledger:reconcile',
  CONVERSATION_LEDGER_START: 'conversation-ledger:start',
  CONVERSATION_LEDGER_SEND_TURN: 'conversation-ledger:send-turn',
} as const;
