import type { TooltipCopyEntry } from './tooltip-copy';

export const SIDE_CHAT_COPY = {
  'sideChat.close': {
    label: 'Close panel',
    meaning: 'Close panel. Running sidechats keep going.',
  },
  'sideChat.new': { label: 'New sidechat', meaning: 'New sidechat' },
  'sideChat.switch': { label: 'Switch sidechat', meaning: 'Switch sidechat' },
  'sideChat.discard': { label: 'Discard', meaning: 'Discard sidechat' },
  'sideChat.discardConfirmation': {
    label: 'Discard this sidechat?',
    meaning: 'Discarding stops its answer and permanently deletes its conversation.',
  },
  'sideChat.parentDelete': {
    label: 'Delete conversation',
    meaning: 'This permanently deletes the saved conversation and its sidechats.',
  },
  'sideChat.clearHistory': {
    label: 'Clear all history',
    meaning: 'This permanently deletes all saved conversation history and its sidechats. It cannot be undone.',
  },
  'sideChat.stop': { label: 'Stop sidechat', meaning: "Stop this sidechat's answer; the main session is not affected." },
  'sideChat.send': { label: 'Send', meaning: 'Send sidechat message' },
} as const satisfies Record<string, TooltipCopyEntry>;
