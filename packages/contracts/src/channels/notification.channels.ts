/** IPC channels for the in-app notification center. */
export const NOTIFICATION_CHANNELS = {
  NOTIFICATION_LIST: 'notification:list',
  NOTIFICATION_DELTA: 'notification:delta',
  NOTIFICATION_DISMISS: 'notification:dismiss',
  NOTIFICATION_CLEAR: 'notification:clear',
  NOTIFICATION_MARK_SEEN: 'notification:mark-seen',
  NOTIFICATION_OPEN_TARGET: 'notification:open-target',
  NOTIFICATION_SET_BADGE: 'notification:set-badge',
} as const;
