/** `register` is always alone: permission to create a new agent-owned login. */
export type BrowserCredentialAccessPurpose = 'login' | 'totp' | 'email_code' | 'register';

/** Non-secret, trusted main-process metadata for a saved-login decision. */
export interface BrowserCredentialAccessMetadata {
  taskScope: string;
  sessionName: string;
  reason: string;
  origin: string;
  computerName: string;
  computerId: string;
  scope: string;
  /** Absent only for a register request, which has no saved login yet. */
  vaultItemRef?: string;
  itemTitle?: string;
  vaultFolder: string;
  moveIntoFolder: boolean;
  purposes: BrowserCredentialAccessPurpose[];
  /** Declared senders of this website's emailed codes (email_code only). */
  senderDomains?: string[];
  permission: 'task' | 'remember';
  permissionExpiresAt?: number;
  authorizationId?: string;
  operationError?: string;
  /** Approved by James's agent-folder setting rather than an Approve press. */
  preApproved?: true;
  /** Asked again after James denied the same login and site: only he may answer it. */
  afterDenial?: true;
}

export interface BrowserCredentialAccessChoice {
  permission: 'task' | 'remember';
  rememberForMs?: number;
}

export interface BrowserRequestCredentialAccess {
  profileId: string;
  targetId: string;
  /** The saved login; omitted for a register request. */
  item?: string;
  /** Register only: the website the new login is for. Defaults to the tab's website. */
  origin?: string;
  reason: string;
  purposes?: BrowserCredentialAccessPurpose[];
  senderDomains?: string[];
}
