/**
 * Where agent-created logins are saved: the Bitwarden organisation and
 * collection named in settings. A plain `bw create item` that names no
 * organisation lands in the personal vault, which James never wants.
 */
export interface VaultOrganization {
  organizationId: string;
  collectionId: string;
}

/** The item fields that place a new login in the organisation; undefined while either id is unset. */
export function organizationPlacement(
  organization: VaultOrganization | undefined,
): { organizationId: string; collectionIds: [string] } | undefined {
  const organizationId = organization?.organizationId.trim();
  const collectionId = organization?.collectionId.trim();
  return organizationId && collectionId ? { organizationId, collectionIds: [collectionId] } : undefined;
}
