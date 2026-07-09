import type {
  DesktopGatewayContext,
  DesktopGrantCapability,
} from '../../shared/types/desktop-gateway.types';

export interface DesktopPermissionGrant {
  id: string;
  instanceId: string;
  provider?: string;
  appId: string;
  capability: DesktopGrantCapability;
  createdAt: number;
  expiresAt: number;
  decidedBy: string;
  reason?: string;
  revokedAt?: number;
}

export interface DesktopGrantStore {
  createGrant(grant: DesktopPermissionGrant): Promise<DesktopPermissionGrant> | DesktopPermissionGrant;
  listActiveGrants(filter: {
    context: DesktopGatewayContext;
    appId: string;
    now: number;
  }): Promise<DesktopPermissionGrant[]> | DesktopPermissionGrant[];
  revokeGrant(grantId: string, revokedAt: number): Promise<DesktopPermissionGrant | null> | DesktopPermissionGrant | null;
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
      grant.appId === filter.appId
      && grant.instanceId === filter.context.instanceId
      && (!grant.provider || !filter.context.provider || grant.provider === filter.context.provider)
      && grant.expiresAt > filter.now
      && !grant.revokedAt,
    );
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

export function grantAllowsInput(grant: DesktopPermissionGrant): boolean {
  return grant.capability === 'input' || grant.capability === 'observeAndInput';
}

export function grantAllowsObservation(grant: DesktopPermissionGrant): boolean {
  return grant.capability === 'observe' || grant.capability === 'observeAndInput';
}
