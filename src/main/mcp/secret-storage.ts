import { getLogger } from '../logging/logger';

const logger = getLogger('McpSecretStorage');

export type EncryptedSecretStatus = 'encrypted' | 'plaintext-quarantined';

export interface EncryptedSecret {
  status: EncryptedSecretStatus;
  payload: string;
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString?(plain: string): Buffer;
  decryptString?(encrypted: Buffer): string;
}

export class McpSecretStorage {
  constructor(private readonly deps: { safeStorage: SafeStorageLike }) {}

  isEncryptionAvailable(): boolean {
    return this.deps.safeStorage.isEncryptionAvailable();
  }

  encryptSecret(plain: string): EncryptedSecret {
    if (this.deps.safeStorage.isEncryptionAvailable() && this.deps.safeStorage.encryptString) {
      return {
        status: 'encrypted',
        payload: this.deps.safeStorage.encryptString(plain).toString('base64'),
      };
    }

    logger.warn('safeStorage unavailable; refusing to persist MCP secret');
    throw new Error('SAFESTORAGE_UNAVAILABLE: safeStorage encryption unavailable for MCP secrets');
  }

  decryptSecret(secret: EncryptedSecret): string {
    if (secret.status === 'plaintext-quarantined') {
      return secret.payload;
    }
    if (!this.deps.safeStorage.decryptString) {
      throw new Error('safeStorage.decryptString unavailable');
    }
    return this.deps.safeStorage.decryptString(Buffer.from(secret.payload, 'base64'));
  }
}

let instance: McpSecretStorage | null = null;

export function getMcpSecretStorage(): McpSecretStorage {
  if (!instance) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { safeStorage } = require('electron') as { safeStorage: SafeStorageLike };
    instance = new McpSecretStorage({ safeStorage });
  }
  return instance;
}

export function _resetMcpSecretStorageForTesting(): void {
  instance = null;
}
