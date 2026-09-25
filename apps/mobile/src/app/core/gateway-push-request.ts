import { authFailureMessage } from './connection-status';
import { friendlyRequestError, withRequestDeadline } from './gateway-request-state';
import type { MobileRespondRequest, PairedHost } from './models';

interface PushResponseRequest {
  hosts: PairedHost[];
  hostDeviceId: string | undefined;
  hostName: string | undefined;
  instanceId: string;
  body: MobileRespondRequest;
  onUnauthorized: (hostId: string) => void;
}

/** Send a notification action to exactly the host named by its payload. */
export async function sendPushResponse(request: PushResponseRequest): Promise<string> {
  const { hosts, hostDeviceId, hostName } = request;
  const legacyMatches = hostDeviceId || !hostName
    ? []
    : hosts.filter((host) => host.name.toLowerCase() === hostName.toLowerCase());
  const target = hostDeviceId
    ? hosts.find((host) => host.id === hostDeviceId)
    : legacyMatches.length === 1 ? legacyMatches[0] : undefined;
  if (!target) throw new Error('The sending host is not paired on this phone.');

  const scheme = target.secure ? 'https' : 'http';
  await withRequestDeadline(async (signal) => {
    let response: Response;
    try {
      response = await fetch(
        `${scheme}://${target.host}:${target.port}/api/instances/${encodeURIComponent(request.instanceId)}/respond`,
        {
          method: 'POST', signal,
          headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(request.body),
        },
      );
    } catch {
      throw new Error('The connection to this host was interrupted. Check the connection before trying again.');
    }
    if (response.ok) return;
    const error = (await response.json().catch(() => ({}))) as { error?: string };
    if (response.status === 401) {
      request.onUnauthorized(target.id);
      throw new Error(authFailureMessage());
    }
    throw new Error(friendlyRequestError(error.error, response.status));
  });
  return target.id;
}
