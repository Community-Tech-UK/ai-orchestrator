export const MOBILE_GATEWAY_CHANNELS = {
  MOBILE_GATEWAY_GET_STATUS: 'mobile-gateway:get-status',
  MOBILE_GATEWAY_START: 'mobile-gateway:start',
  MOBILE_GATEWAY_STOP: 'mobile-gateway:stop',
  MOBILE_GATEWAY_ISSUE_PAIRING: 'mobile-gateway:issue-pairing',
  MOBILE_GATEWAY_LIST_DEVICES: 'mobile-gateway:list-devices',
  MOBILE_GATEWAY_REVOKE_DEVICE: 'mobile-gateway:revoke-device',
  /** Desktop -> main: the user opened this session on the desktop. */
  MOBILE_GATEWAY_MARK_VIEWED: 'mobile-gateway:mark-viewed',
  /** Main -> desktop: the phone opened or dismissed this session. */
  MOBILE_GATEWAY_COMPLETION_VIEWED: 'mobile-gateway:completion-viewed',
} as const;
