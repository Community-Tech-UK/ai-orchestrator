import { tryParseWebUrl } from './browser-gateway-service-helpers';
import { portalPathMatches } from './browser-login-recipe-store';

export interface CredentialFillLivePage {
  origin: string;
  /** True only when a portal path was required and the live URL is not under it. */
  outsidePortal: boolean;
}

interface LivePageReaders {
  refreshTargetOrigin: (profileId: string, targetId: string) => Promise<string>;
  readTargetUrl?: (profileId: string, targetId: string) => Promise<string>;
}

interface LivePageTarget {
  profileId: string;
  targetId: string;
  requiredPortalPath?: string;
}

/**
 * One live read of the target. Without a required portal path this is the origin
 * refresh every fill already did; with one, the origin and the path come from the
 * same URL read, so the portal check cannot be separated from the origin check.
 * Buyers that share an origin differ only by path, so the origin alone cannot stop a
 * redirect into another buyer's portal.
 */
export async function readCredentialFillLivePage(
  readers: LivePageReaders,
  target: LivePageTarget,
): Promise<CredentialFillLivePage> {
  if (!target.requiredPortalPath) {
    return { origin: await readers.refreshTargetOrigin(target.profileId, target.targetId), outsidePortal: false };
  }
  if (!readers.readTargetUrl) {
    throw new Error('live_url_unavailable');
  }
  const url = tryParseWebUrl(await readers.readTargetUrl(target.profileId, target.targetId));
  if (!url) {
    return { origin: '', outsidePortal: true };
  }
  return { origin: url.origin, outsidePortal: !portalPathMatches(target.requiredPortalPath, url.pathname) };
}
