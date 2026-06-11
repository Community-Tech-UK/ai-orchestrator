import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import { getLogger } from '../logging/logger';
import { getSettingsManager } from '../core/config/settings-manager';
import { getNodeIdentityStore } from '../remote-node/node-identity-store';
import type {
  NodeIdentity,
  NodePlatform,
  RemotePairingCredentialInfo,
} from '../../shared/types/worker-node.types';

const logger = getLogger('RemoteAuth');

const DEFAULT_PAIRING_TTL_MS = 60 * 60 * 1000;
const LAST_SEEN_PERSIST_INTERVAL_MS = 60_000;

/**
 * Sentinel expiry used by the manually-managed pairing token. It never times
 * out, so it is deliberately kept out of the one-time "pending pairings"
 * listing — the manual token has its own dedicated Settings section and must
 * not masquerade as a one-time credential (which previously rendered a
 * nonsensical "expires in ~104,000,000 days").
 */
const NON_EXPIRING_AT = Number.MAX_SAFE_INTEGER;

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

type PairingPurpose = 'pairing' | 'repair';

interface RemotePairingCredentialRecord extends RemotePairingCredentialInfo {
  purpose: PairingPurpose;
  allowedNodeId?: string;
}

export type RemotePairingCredential = RemotePairingCredentialInfo;

export interface RemoteSession {
  sessionId: string;
  nodeId: string;
  nodeName: string;
  /** Transport access token used after registration completes. */
  transportToken: string;
  /** Backward-compatible alias for transportToken. */
  token: string;
  /** Same-node recovery token used to rotate a stale transport token. */
  recoveryToken?: string;
  issuedAt: number;
  /** Backward-compatible alias for issuedAt. */
  createdAt: number;
  lastSeenAt: number;
  pairingLabel?: string;
}

export type RemoteRegistrationResult =
  | { status: 'registered'; session: RemoteSession }
  | { status: 'recovered'; session: RemoteSession }
  | { status: 'paired'; session: RemoteSession }
  | { status: 'rejected'; reason: string };

export class RemoteAuthService {
  private readonly pendingPairings = new Map<string, RemotePairingCredentialRecord>();
  private loadedFromSettings = false;

  issuePairingCredential(options: {
    label?: string;
    ttlMs?: number;
    purpose?: PairingPurpose;
    allowedNodeId?: string;
  } = {}): RemotePairingCredential {
    const createdAt = Date.now();
    const record: RemotePairingCredentialRecord = {
      token: generateToken(24),
      createdAt,
      expiresAt: createdAt + Math.max(1_000, options.ttlMs ?? DEFAULT_PAIRING_TTL_MS),
      purpose: options.purpose ?? 'pairing',
      ...(options.label ? { label: options.label } : {}),
      ...(options.allowedNodeId ? { allowedNodeId: options.allowedNodeId } : {}),
    };
    this.pendingPairings.set(record.token, record);
    return this.toPairingInfo(record);
  }

  authenticateRegistration(params: {
    nodeId: string;
    nodeName: string;
    token?: string | null;
    recoveryToken?: string | null;
    platform?: NodePlatform | null;
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
      const now = Date.now();
      const touched = getNodeIdentityStore().touch(existingSession.nodeId, {
        nodeName: params.nodeName,
        lastSeenAt: now,
        ...(params.platform ? { platform: params.platform, platformSeenAt: now } : {}),
      });
      if (touched) {
        this.persistSessions();
      }
      const session = this.ensureRecoveryToken(touched ?? existingSession);
      return {
        status: 'registered',
        session: this.toRemoteSession(session),
      };
    }

    const pairing = this.pendingPairings.get(token);
    if (pairing) {
      if (pairing.allowedNodeId && pairing.allowedNodeId !== params.nodeId) {
        return {
          status: 'rejected',
          reason: 'Repair credential is scoped to another node',
        };
      }
      this.pendingPairings.delete(token);
      this.clearManualPairingTokenIfMatches(token);
      return {
        status: 'paired',
        session: this.issueSession(params.nodeId, params.nodeName, pairing, params.platform ?? undefined),
      };
    }

    const recoveryToken = params.recoveryToken?.trim();
    if (recoveryToken) {
      const recoverySession = getNodeIdentityStore().findByRecoveryToken(recoveryToken);
      if (recoverySession) {
        if (recoverySession.nodeId !== params.nodeId) {
          return {
            status: 'rejected',
            reason: `Recovery token belongs to node "${recoverySession.nodeId}"`,
          };
        }
        return {
          status: 'recovered',
          session: this.rotateSessionToken(recoverySession, params.nodeName, params.platform ?? undefined),
        };
      }
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
      // The manual pairing token never expires and is surfaced in its own
      // Settings section; exclude it so it is not listed/counted as a
      // one-time "Quick Pairing" credential.
      .filter((pairing) => pairing.expiresAt !== NON_EXPIRING_AT)
      .filter((pairing) => pairing.purpose === 'pairing')
      .sort((left, right) => left.expiresAt - right.expiresAt)
      .map((pairing) => this.toPairingInfo(pairing));
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

  recordTrustedPlatform(nodeId: string, platform: NodePlatform): void {
    this.ensureLoadedFromSettings();
    const touched = getNodeIdentityStore().touch(nodeId, {
      platform,
      platformSeenAt: Date.now(),
    });
    if (touched) {
      this.persistSessions();
    }
  }

  clearPairingsForTesting(): void {
    this.pendingPairings.clear();
  }

  setManualPairingCredential(token: string): RemotePairingCredential {
    this.ensureLoadedFromSettings();
    const now = Date.now();
    const credential: RemotePairingCredentialRecord = {
      token,
      createdAt: now,
      expiresAt: NON_EXPIRING_AT,
      label: 'Manual pairing token',
      purpose: 'pairing',
    };
    this.pendingPairings.set(token, credential);
    return this.toPairingInfo(credential);
  }

  private issueSession(
    nodeId: string,
    nodeName: string,
    pairing?: RemotePairingCredentialRecord,
    platform?: NodePlatform,
  ): RemoteSession {
    const issuedAt = Date.now();
    const transportToken = generateToken();
    const identity: NodeIdentity = {
      sessionId: randomUUID(),
      nodeId,
      nodeName,
      transportToken,
      token: transportToken,
      recoveryToken: generateToken(),
      issuedAt,
      createdAt: issuedAt,
      lastSeenAt: issuedAt,
      authMethod: pairing?.label === 'Manual pairing token' ? 'manual_pairing' : 'pairing_credential',
      pairingLabel: pairing?.label,
      ...(platform ? { platform, platformSeenAt: issuedAt } : {}),
    };
    getNodeIdentityStore().set(identity);
    this.persistSessions();
    logger.info('Issued remote node session token', { nodeId, nodeName });
    return this.toRemoteSession(identity);
  }

  private ensureRecoveryToken(identity: NodeIdentity): NodeIdentity {
    if (identity.recoveryToken) {
      return identity;
    }

    const next: NodeIdentity = {
      ...identity,
      recoveryToken: generateToken(),
    };
    getNodeIdentityStore().set(next);
    this.persistSessions();
    logger.info('Issued remote node recovery token', { nodeId: next.nodeId, nodeName: next.nodeName });
    return next;
  }

  private rotateSessionToken(identity: NodeIdentity, nodeName: string, platform?: NodePlatform): RemoteSession {
    const issuedAt = Date.now();
    const transportToken = generateToken();
    const next: NodeIdentity = {
      ...identity,
      sessionId: randomUUID(),
      nodeName,
      transportToken,
      token: transportToken,
      issuedAt,
      createdAt: issuedAt,
      lastSeenAt: issuedAt,
      ...(platform ? { platform, platformSeenAt: issuedAt } : {}),
    };
    getNodeIdentityStore().set(next);
    this.persistSessions();
    logger.info('Rotated remote node session token via recovery token', {
      nodeId: next.nodeId,
      nodeName: next.nodeName,
    });
    return this.toRemoteSession(next);
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
      recoveryToken: identity.recoveryToken,
      issuedAt: identity.issuedAt,
      createdAt: identity.issuedAt,
      lastSeenAt: identity.lastSeenAt,
      pairingLabel: identity.pairingLabel,
    };
  }

  private toPairingInfo(record: RemotePairingCredentialRecord): RemotePairingCredentialInfo {
    return {
      token: record.token,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      ...(record.label ? { label: record.label } : {}),
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
