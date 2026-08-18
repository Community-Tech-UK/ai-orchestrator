/**
 * IPC channels for the generic PermissionRegistry approval surface (LT-095).
 *
 * `PermissionRegistry.resolve()` is the only path from a pending
 * `requestPermission()` call to approved/denied for three orphaned flows that
 * share the primitive but had no human-reachable UI: the Computer Use desktop
 * app grant (`desktop_computer_use_grant`), the App Store/Google Play release
 * gate (`store_release_mutation`), and the Microsoft calendar mutation/connect
 * approval (`calendar_mutation` / `calendar_account_connect`). ACP tool
 * permission requests also ride PermissionRegistry but already have a working
 * approval path via `acp-cli-adapter.ts`'s `input_required` chat flow, so the
 * list channel excludes `details.transport === 'acp'` entries by default.
 */
export const PERMISSION_REGISTRY_CHANNELS = {
  PERMISSION_REGISTRY_LIST_PENDING: 'permission-registry:list-pending',
  PERMISSION_REGISTRY_RESOLVE: 'permission-registry:resolve',
  PERMISSION_REGISTRY_EXTEND: 'permission-registry:extend',
} as const;
