/**
 * IPC channels for the Harness Computer Use (desktop gateway) diagnostics and
 * management surface used by the renderer Settings tab: health/permission
 * status, running app discovery, grant listing/revocation, and audit log.
 *
 * Runtime grant approvals ride the generic PermissionRegistry approval path
 * (`desktop_computer_use_grant`), so there are no approve/deny channels here.
 */
export const DESKTOP_CHANNELS = {
  DESKTOP_GET_HEALTH: 'desktop:get-health',
  DESKTOP_LIST_APPS: 'desktop:list-apps',
  DESKTOP_LIST_GRANTS: 'desktop:list-grants',
  DESKTOP_REVOKE_GRANT: 'desktop:revoke-grant',
  DESKTOP_GET_AUDIT_LOG: 'desktop:get-audit-log',
  DESKTOP_OPEN_PERMISSION_SETTINGS: 'desktop:open-permission-settings',
  DESKTOP_CHANGED: 'desktop:changed',
} as const;
