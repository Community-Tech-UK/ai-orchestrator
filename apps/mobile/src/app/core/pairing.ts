/** Pairing lifecycle: exchanging a one-time QR token for a device token, and giving it back. */
import type { PairedHost } from './models';

/** Pairing must reach the host over Tailscale; bound it so the UI can't hang forever. */
const PAIR_TIMEOUT_MS = 10000;
/** Unpairing is best-effort and must never hold up removing the host locally. */
const UNPAIR_TIMEOUT_MS = 5000;

export interface PairResult {
  deviceId: string;
  token: string;
  hostName: string;
  expiresAt: number;
}

/**
 * REST: exchange a one-time pairing token for a long-lived device token.
 *
 * The host is reached over the Tailscale tunnel; if Tailscale isn't connected
 * on the phone (or the Mac gateway is down) the request would otherwise hang
 * indefinitely, so we bound it with a timeout and surface a clear,
 * actionable error instead of spinning forever on "Pairing…".
 *
 * Deliberately not a method on GatewayClient: this runs once, before any device
 * token exists, and shares none of the live client's socket or REST state.
 */
export async function pairWithHost(
  host: string,
  port: number,
  pairingToken: string,
  label: string,
  secure = false,
): Promise<PairResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PAIR_TIMEOUT_MS);
  const scheme = secure ? 'https' : 'http';
  let res: Response;
  try {
    res = await fetch(`${scheme}://${host}:${port}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingToken, label }),
      signal: controller.signal,
    });
  } catch {
    // AbortError (timeout) or a network failure both mean we never reached the
    // gateway — almost always Tailscale not being connected on the phone. Unlike
    // a rejected device token, blaming the network really is right here.
    throw new Error(
      `Couldn't reach ${host}:${port}. Check that Tailscale is connected on this phone ` +
        `(same tailnet as the Mac) and the gateway is running, then try again.`,
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Pairing failed (HTTP ${res.status})`);
  }
  return (await res.json()) as PairResult;
}

/**
 * Ask the host to revoke this device's token — the inverse of pairing.
 *
 * Best-effort by design, and the caller removes the local entry either way: the
 * usual reasons to remove a host are that it is unreachable or that its token has
 * already expired, and in both cases there is nothing left to revoke. Returns
 * true only when the host confirmed it, so the caller can say so if it didn't.
 */
export async function unpairFromHost(host: PairedHost): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UNPAIR_TIMEOUT_MS);
  try {
    const scheme = host.secure ? 'https' : 'http';
    const res = await fetch(`${scheme}://${host.host}:${host.port}/api/devices/me`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${host.token}` },
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    // Unreachable host or aborted request: nothing was revoked.
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
