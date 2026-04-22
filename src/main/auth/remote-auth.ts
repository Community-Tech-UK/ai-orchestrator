import * as crypto from 'crypto';
import { getLogger } from '../logging/logger';
import { getSettingsManager } from '../core/config/settings-manager';
import { getNodeIdentityStore } from '../remote-node/node-identity-store';
import { getRemoteNodeConfig } from '../remote-node/remote-node-config';
import type { NodeIdentity, RemotePairingCredentialInfo } from '../../shared/types/worker-node.types';

const logger = getLogger('RemoteAuth');

const DEFAULT_PAIRING_TTL_MS = 60 * 60 * 1000;

function safeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf-8');
  const bBuf = Buffer.from(b, 'utf-8');
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export interface RemotePairingCredential extends RemotePairingCredentialInfo {}

export interface RemoteSession {
  nodeId: string;
  nodeName: string;
  token: string;
  createdAt: number;
}

export type RemoteRegistrationResult =
  | { status: 'registered'; session: RemoteSession }
  | { status: 'paired'; session: RemoteSession }
  | { status: 'rejected'; reason: string };

export class RemoteAuthService {
  private readonly pendingPairings = new Map<string, RemotePairingCredential>();
  private loadedFromSettings = false;

  issuePairingCredential(options: {
    label?: string;
    ttlMs?: number;
  } = {}): RemotePairingCredential {
    const createdAt = Date.now();
    const credential: RemotePairingCredential = {
      token: generateToken(24),
      createdAt,
      expiresAt: createdAt + Math.max(1_000, options.ttlMs ?? DEFAULT_PAIRING_TTL_MS),
      ...(options.label ? { label: options.label } : {}),
    };
    this.pendingPairings.set(credential.token, credential);
    return credential;
  }

  authenticateRegistration(params: {
    nodeId: string;
    nodeName: string;
    token?: string | null;
  }): RemoteRegistrationResult {
    this.ensureLoadedFromSettings();
    this.pruneExpiredPairings();

    const token = params.token?.trim();
    if (!token) {
      return { status: 'rejected', reason: 'Missing token' };
    }

    const existingIdentity = getNodeIdentityStore().findByToken(token);
    if (existingIdentity) {
      if (existingIdentity.nodeId !== params.nodeId) {
        return {
          status: 'rejected',
          reason: `Session token belongs to node "${existingIdentity.nodeId}"`,
        };
      }
      return {
        status: 'registered',
        session: {
          nodeId: existingIdentity.nodeId,
          nodeName: existingIdentity.nodeName,
          token: existingIdentity.token,
          createdAt: existingIdentity.createdAt,
        },
      };
    }

    const pairing = this.pendingPairings.get(token);
    if (pairing) {
      this.pendingPairings.delete(token);
      return {
        status: 'paired',
        session: this.issueSession(params.nodeId, params.nodeName),
      };
    }

    const legacyPairingToken = getRemoteNodeConfig().authToken?.trim();
    if (legacyPairingToken && safeCompare(token, legacyPairingToken)) {
      return {
        status: 'paired',
        session: this.issueSession(params.nodeId, params.nodeName),
      };
    }

    return { status: 'rejected', reason: 'Invalid or expired pairing token' };
  }

  validateSessionToken(
    token: string | undefined | null,
    nodeId?: string,
  ): boolean {
    this.ensureLoadedFromSettings();
    if (!token) {
      return false;
    }

    const identity = getNodeIdentityStore().findByToken(token);
    if (!identity) {
      return false;
    }

    return nodeId ? identity.nodeId === nodeId : true;
  }

  listSessions(): NodeIdentity[] {
    this.ensureLoadedFromSettings();
    return getNodeIdentityStore().getAll();
  }

  listPendingPairings(): RemotePairingCredentialInfo[] {
    this.pruneExpiredPairings();
    return [...this.pendingPairings.values()]
      .sort((left, right) => left.expiresAt - right.expiresAt)
      .map((pairing) => ({ ...pairing }));
  }

  revokePairingCredential(token: string): boolean {
    this.pruneExpiredPairings();
    return this.pendingPairings.delete(token.trim());
  }

  revokeSession(nodeId: string): boolean {
    this.ensureLoadedFromSettings();
    const removed = getNodeIdentityStore().remove(nodeId);
    if (removed) {
      this.persistSessions();
    }
    return removed;
  }

  clearPairingsForTesting(): void {
    this.pendingPairings.clear();
  }

  private issueSession(nodeId: string, nodeName: string): RemoteSession {
    const identity: NodeIdentity = {
      nodeId,
      nodeName,
      token: generateToken(),
      createdAt: Date.now(),
    };
    getNodeIdentityStore().set(identity);
    this.persistSessions();
    logger.info('Issued remote node session token', { nodeId, nodeName });
    return {
      nodeId,
      nodeName,
      token: identity.token,
      createdAt: identity.createdAt,
    };
  }

  private ensureLoadedFromSettings(): void {
    if (this.loadedFromSettings) {
      return;
    }

    this.loadedFromSettings = true;
    const raw = getSettingsManager().get('remoteNodesRegisteredNodes');
    if (typeof raw === 'string' && raw.trim().length > 0) {
      getNodeIdentityStore().loadFromJson(raw);
    }
  }

  private persistSessions(): void {
    getSettingsManager().set('remoteNodesRegisteredNodes', getNodeIdentityStore().toJson());
  }

  private pruneExpiredPairings(now = Date.now()): void {
    for (const [token, pairing] of this.pendingPairings.entries()) {
      if (pairing.expiresAt <= now) {
        this.pendingPairings.delete(token);
      }
    }
  }
}

let remoteAuthService: RemoteAuthService | null = null;

export function getRemoteAuthService(): RemoteAuthService {
  if (!remoteAuthService) {
    remoteAuthService = new RemoteAuthService();
  }
  return remoteAuthService;
}

export function _resetRemoteAuthServiceForTesting(): void {
  remoteAuthService = null;
}
