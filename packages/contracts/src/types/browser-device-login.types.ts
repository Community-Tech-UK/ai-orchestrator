/** One native Codex sign-in; never a vault permission or reusable browser grant. */
export interface BrowserDeviceLoginMetadata {
  operationHandle: string;
  ownerSessionId: string;
  ownerGeneration: string;
  nativeNodeId: string;
  nativeProfileId: string;
  nativeComputerName: string;
  browserNodeId: string;
  browserProfileId: string;
  browserComputerName: string;
  targetId: string;
  origin: 'https://auth.openai.com';
  expectedIdentity: string;
  extensionInstanceId: string;
  extensionGeneration: string;
  documentId: string;
  expiresAt: number;
  sessionName?: string;
}

export interface BrowserDeviceLoginChoice { permission: 'operation' }
