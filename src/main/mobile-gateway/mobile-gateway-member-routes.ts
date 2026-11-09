/**
 * People on the phone app: the owner of the Mac, and members who see only
 * their own sessions.
 *
 * Members are refused by default. Only the routes listed here answer, so a
 * phone feature added later stays closed to members until someone decides it
 * belongs here. A session that belongs to someone else is reported as not
 * found, so a guessed id reveals nothing.
 */
import type { ServerResponse } from 'http';
import type { Instance } from '../../shared/types/instance.types';
import {
  MOBILE_OWNER_PROFILE_ID,
  type MobilePauseDto,
  type MobileSnapshot,
} from '../../shared/types/mobile-gateway.types';
import { sendJsonResponse } from './mobile-gateway-http-utils';
import { sessionProfileId } from './mobile-gateway-session-visibility';

/** Which person each session belongs to, remembered after the session is removed. */
export class MobileSessionOwners {
  private readonly lastKnown = new Map<string, string>();

  constructor(
    private readonly getInstance: (instanceId: string) => Instance | undefined,
    private readonly hasProfile: (profileId: string) => boolean,
  ) {}

  /**
   * Events about a just-removed session still reach its person; unknown ids
   * are the owner's. A session left behind by a person who was removed passes
   * to the owner, so it can still be seen and stopped from the owner's phone.
   */
  profileOf(instanceId: string): string {
    const instance = this.getInstance(instanceId);
    if (!instance) return this.lastKnown.get(instanceId) ?? MOBILE_OWNER_PROFILE_ID;
    const stamped = sessionProfileId(instance);
    const profileId = this.hasProfile(stamped) ? stamped : MOBILE_OWNER_PROFILE_ID;
    this.lastKnown.set(instanceId, profileId);
    return profileId;
  }

  /** A live session that belongs to this person. */
  owns(profileId: string, instanceId: string): boolean {
    return this.getInstance(instanceId) !== undefined && this.profileOf(instanceId) === profileId;
  }

  forget(instanceId: string): void {
    this.lastKnown.delete(instanceId);
  }

  clear(): void {
    this.lastKnown.clear();
  }
}

export interface MobilePersonViewDeps {
  /** This person's own snapshot: their sessions and the prompts on them. */
  buildSnapshot(): MobileSnapshot;
  pauseState(): MobilePauseDto;
}

/** Read-only views of one person's own state, answered the same way for everyone. */
export function handleMobilePersonView(
  deps: MobilePersonViewDeps,
  res: ServerResponse,
  segments: string[],
  method: string,
): boolean {
  if (segments[0] !== 'api' || segments.length !== 2 || method !== 'GET') return false;
  switch (segments[1]) {
    case 'snapshot':
      sendJsonResponse(res, 200, deps.buildSnapshot());
      return true;
    case 'projects':
      sendJsonResponse(res, 200, deps.buildSnapshot().projects);
      return true;
    case 'prompts':
      sendJsonResponse(res, 200, deps.buildSnapshot().prompts);
      return true;
    case 'instances':
      sendJsonResponse(res, 200, deps.buildSnapshot().instances);
      return true;
    // Pausing stops a member's work too, so everyone may see it.
    case 'pause':
      sendJsonResponse(res, 200, deps.pauseState());
      return true;
    default:
      return false;
  }
}

export interface MobileMemberRouteDeps extends MobilePersonViewDeps {
  ownsInstance(instanceId: string): boolean;
  /** The shared `/api/models` and `/api/instances/:id/...` routes. */
  handleInstanceRoute(): Promise<boolean>;
  /** The phone's own pairing, push and Live Activity registrations. */
  handleDeviceRoute(): Promise<boolean>;
}

export async function handleMobileMemberRequest(
  deps: MobileMemberRouteDeps,
  res: ServerResponse,
  segments: string[],
  method: string,
): Promise<void> {
  if (handleMobilePersonView(deps, res, segments, method)) return;
  const resource = segments[0] === 'api' ? segments[1] : undefined;

  if (resource === 'models' && segments.length === 2 && method === 'GET') {
    if (await deps.handleInstanceRoute()) return;
  }
  if (resource === 'instances' && segments.length >= 4) {
    if (!deps.ownsInstance(decodeURIComponent(segments[2]))) {
      sendJsonResponse(res, 404, { error: 'Instance not found' });
      return;
    }
    if (await deps.handleInstanceRoute()) return;
  }
  if (resource === 'devices' && (await deps.handleDeviceRoute())) return;

  sendJsonResponse(res, 403, { error: 'This is not available on your profile.' });
}
