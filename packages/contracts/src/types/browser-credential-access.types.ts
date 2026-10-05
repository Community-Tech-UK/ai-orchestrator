/** Non-secret, trusted main-process metadata for a saved-login decision. */
export interface BrowserCredentialAccessMetadata {
  taskScope: string;
  sessionName: string;
  reason: string;
  origin: string;
  computerName: string;
  computerId: string;
  scope: string;
  vaultItemRef: string;
  itemTitle: string;
  vaultFolder: string;
  moveIntoFolder: boolean;
  purposes: ('login' | 'totp')[];
  permission: 'task' | 'remember';
  permissionExpiresAt?: number;
  authorizationId?: string;
  operationError?: string;
}

export interface BrowserCredentialAccessChoice {
  permission: 'task' | 'remember';
  rememberForMs?: number;
}

export interface BrowserRequestCredentialAccess {
  profileId: string;
  targetId: string;
  item: string;
  reason: string;
  purposes?: ('login' | 'totp')[];
}
