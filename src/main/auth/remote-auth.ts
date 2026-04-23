import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import { getLogger } from '../logging/logger';
import { getSettingsManager } from '../core/config/settings-manager';
import { getNodeIdentityStore } from '../remote-node/node-identity-store';
import type { NodeIdentity, RemotePairingCredentialInfo } from '../../shared/types/worker-node.types';

const logger = getLogger('RemoteAuth');

const DEFAULT_PAIRING_TTL_MS = 60 * 60 * 1000;
const LAST_SEEN_PERSIST_INTERVAL_MS = 60_000;

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
  sessionId: string;
  nodeId: string;
  nodeName: string;
  /** Transport access token used after registration completes. */
  transportToken: string;
  /** Backward-compatible alias for transportToken. */
  token: string;
  issuedAt: number;
  /** Backward-compatible alias for issuedAt. */
  createdAt: number;
  lastSeenAt: number;
  pairingLabel?: string;
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

    const existingSession = getNodeIdentityStore().findByTransportToken(token);
    if (existingSession) {
      if (existingSession.nodeId !== params.nodeId) {
        return {
          status: 'rejected',
          reason: `Session token belongs to node "${existingSession.nodeId}"`,
        };
      }
      const touched = getNodeIdentityStore().touch(existingSession.nodeId, {
        nodeName: params.nodeName,
        lastSeenAt: Date.now(),
      });
      if (touched) {
        this.persistSessions();
      }
      const session = touched ?? existingSession;
      return {
        status: 'registered',
        session: this.toRemoteSession(session),
      };
    }

    const pairing = this.pendingPairings.get(token);
    if (pairing) {
      this.pendingPairings.delete(token);
      this.clearManualPairingTokenIfMatches(token);
      return {
        status: 'paired',
        session: this.issueSession(params.nodeId, params.nodeName, pairing),
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

    const session = getNodeIdentityStore().findByTransportToken(token);
    if (!session) {
      return false;
    }

    if (nodeId && session.nodeId !== nodeId) {
      return false;
    }

    const now = Date.now();
    getNodeIdentityStore().touch(session.nodeId, { lastSeenAt: now });
    if (now - session.lastSeenAt >= LAST_SEEN_PERSIST_INTERVAL_MS) {
      this.persistSessions();
    }
    return true;
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
    const normalized = token.trim();
    const deleted = this.pendingPairings.delete(normalized);
    if (deleted) {
      this.clearManualPairingTokenIfMatches(normalized);
    }
    return deleted;
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

  setManualPairingCredential(token: string): RemotePairingCredential {
    this.ensureLoadedFromSettings();
    const now = Date.now();
    const credential: RemotePairingCredential = {
      token,
      createdAt: now,
      expiresAt: Number.MAX_SAFE_INTEGER,
      label: 'Manual pairing token',
    };
    this.pendingPairings.set(token, credential);
    return credential;
  }

  private issueSession(
    nodeId: string,
    nodeName: string,
    pairing?: RemotePairingCredential,
  ): RemoteSession {
    const issuedAt = Date.now();
    const transportToken = generateToken();
    const identity: NodeIdentity = {
      sessionId: randomUUID(),
      nodeId,
      nodeName,
      transportToken,
      token: transportToken,
      issuedAt,
      createdAt: issuedAt,
      lastSeenAt: issuedAt,
      authMethod: pairing?.label === 'Manual pairing token' ? 'manual_pairing' : 'pairing_credential',
      pairingLabel: pairing?.label,
    };
    getNodeIdentityStore().set(identity);
    this.persistSessions();
    logger.info('Issued remote node session token', { nodeId, nodeName });
    return this.toRemoteSession(identity);
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
    const manualPairingToken = getSettingsManager().get('remoteNodesEnrollmentToken');
    if (typeof manualPairingToken === 'string' && manualPairingToken.trim().length > 0) {
      this.setManualPairingCredential(manualPairingToken.trim());
    }
  }

  private persistSessions(): void {
    getSettingsManager().set('remoteNodesRegisteredNodes', getNodeIdentityStore().toJson());
  }

  private pruneExpiredPairings(now = Date.now()): void {
    for (const [token, pairing] of this.pendingPairings.entries()) {
      if (pairing.expiresAt <= now) {
        this.pendingPairings.delete(token);
        this.clearManualPairingTokenIfMatches(token);
      }
    }
  }

  private clearManualPairingTokenIfMatches(token: string): void {
    const persisted = getSettingsManager().get('remoteNodesEnrollmentToken');
    if (typeof persisted === 'string' && persisted.trim().length > 0 && safeCompare(persisted.trim(), token)) {
      getSettingsManager().set('remoteNodesEnrollmentToken', '');
    }
  }

  private toRemoteSession(identity: NodeIdentity): RemoteSession {
    return {
      sessionId: identity.sessionId,
      nodeId: identity.nodeId,
      nodeName: identity.nodeName,
      transportToken: identity.transportToken,
      token: identity.transportToken,
      issuedAt: identity.issuedAt,
      createdAt: identity.issuedAt,
      lastSeenAt: identity.lastSeenAt,
      pairingLabel: identity.pairingLabel,
    };
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
