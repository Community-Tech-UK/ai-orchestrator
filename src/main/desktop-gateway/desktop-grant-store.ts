import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  DesktopGatewayContext,
  DesktopGrantCapability,
} from '../../shared/types/desktop-gateway.types';

export type DesktopGrantScope = 'session' | 'durable';

export interface DesktopPermissionGrant {
  id: string;
  instanceId: string;
  provider?: string;
  appId: string;
  capability: DesktopGrantCapability;
  scope: DesktopGrantScope;
  createdAt: number;
  expiresAt: number;
  decidedBy: string;
  reason?: string;
  revokedAt?: number;
}

export interface DesktopGrantListFilter {
  context: DesktopGatewayContext;
  appId?: string;
  includeExpired?: boolean;
  now: number;
  limit?: number;
  /**
   * Operator/management listing: ignore the instance/provider scoping so the
   * renderer Settings tab can show and revoke every grant, not just the ones
   * owned by a single agent instance.
   */
  allInstances?: boolean;
}

export interface DesktopGrantStore {
  createGrant(grant: DesktopPermissionGrant): Promise<DesktopPermissionGrant> | DesktopPermissionGrant;
  listActiveGrants(filter: {
    context: DesktopGatewayContext;
    appId: string;
    now: number;
  }): Promise<DesktopPermissionGrant[]> | DesktopPermissionGrant[];
  listGrants(filter: DesktopGrantListFilter): Promise<DesktopPermissionGrant[]> | DesktopPermissionGrant[];
  revokeGrant(grantId: string, revokedAt: number): Promise<DesktopPermissionGrant | null> | DesktopPermissionGrant | null;
}

function isActiveGrant(
  grant: DesktopPermissionGrant,
  appId: string,
  context: DesktopGatewayContext,
  now: number,
): boolean {
  const appliesToContext = grant.scope === 'durable'
    || (
      grant.instanceId === context.instanceId
      && (!grant.provider || !context.provider || grant.provider === context.provider)
    );
  return grant.appId === appId
    && appliesToContext
    && grant.expiresAt > now
    && !grant.revokedAt;
}

function matchesInstance(grant: DesktopPermissionGrant, filter: DesktopGrantListFilter): boolean {
  if (!filter.allInstances && grant.instanceId !== filter.context.instanceId) {
    return false;
  }
  if (!filter.allInstances && grant.provider && filter.context.provider && grant.provider !== filter.context.provider) {
    return false;
  }
  if (filter.appId && grant.appId !== filter.appId) {
    return false;
  }
  if (!filter.includeExpired && (grant.revokedAt || grant.expiresAt <= filter.now)) {
    return false;
  }
  return true;
}

export class InMemoryDesktopGrantStore implements DesktopGrantStore {
  private readonly grants = new Map<string, DesktopPermissionGrant>();

  createGrant(grant: DesktopPermissionGrant): DesktopPermissionGrant {
    this.grants.set(grant.id, grant);
    return grant;
  }

  listActiveGrants(filter: {
    context: DesktopGatewayContext;
    appId: string;
    now: number;
  }): DesktopPermissionGrant[] {
    return Array.from(this.grants.values()).filter((grant) =>
      isActiveGrant(grant, filter.appId, filter.context, filter.now),
    );
  }

  listGrants(filter: DesktopGrantListFilter): DesktopPermissionGrant[] {
    const matched = Array.from(this.grants.values())
      .filter((grant) => matchesInstance(grant, filter))
      .sort((a, b) => b.createdAt - a.createdAt);
    return typeof filter.limit === 'number' ? matched.slice(0, filter.limit) : matched;
  }

  revokeGrant(grantId: string, revokedAt: number): DesktopPermissionGrant | null {
    const grant = this.grants.get(grantId);
    if (!grant) {
      return null;
    }
    const revoked = { ...grant, revokedAt };
    this.grants.set(grantId, revoked);
    return revoked;
  }
}

/**
 * Durable grant store backed by a JSON file under userData. Grants survive
 * app restarts (durable app grants) and remain auditable/revocable. The file
 * is rewritten atomically on each mutation; volume is small (per-instance,
 * per-app grants), so full read/rewrite is acceptable and avoids a native
 * SQLite dependency.
 */
export class FileDesktopGrantStore implements DesktopGrantStore {
  private readonly filePath: string;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, 'desktop-gateway-grants.json');
  }

  createGrant(grant: DesktopPermissionGrant): DesktopPermissionGrant {
    const grants = this.readAll();
    grants.push(grant);
    this.writeAll(grants);
    return grant;
  }

  listActiveGrants(filter: {
    context: DesktopGatewayContext;
    appId: string;
    now: number;
  }): DesktopPermissionGrant[] {
    return this.readAll().filter((grant) =>
      isActiveGrant(grant, filter.appId, filter.context, filter.now),
    );
  }

  listGrants(filter: DesktopGrantListFilter): DesktopPermissionGrant[] {
    const matched = this.readAll()
      .filter((grant) => matchesInstance(grant, filter))
      .sort((a, b) => b.createdAt - a.createdAt);
    return typeof filter.limit === 'number' ? matched.slice(0, filter.limit) : matched;
  }

  revokeGrant(grantId: string, revokedAt: number): DesktopPermissionGrant | null {
    const grants = this.readAll();
    const index = grants.findIndex((grant) => grant.id === grantId);
    if (index === -1) {
      return null;
    }
    const revoked = { ...grants[index], revokedAt };
    grants[index] = revoked;
    this.writeAll(grants);
    return revoked;
  }

  private readAll(): DesktopPermissionGrant[] {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as DesktopPermissionGrant[]) : [];
    } catch {
      return [];
    }
  }

  private writeAll(grants: DesktopPermissionGrant[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(grants), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    fs.renameSync(tmpPath, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
  }
}

export function grantAllowsInput(grant: DesktopPermissionGrant): boolean {
  return grant.capability === 'input' || grant.capability === 'observeAndInput';
}

export function grantAllowsObservation(grant: DesktopPermissionGrant): boolean {
  return grant.capability === 'observe' || grant.capability === 'observeAndInput';
}
