import * as path from 'path';
import { LOCAL_NETWORK_BLOCKED_PREFIX } from '../shared/types/pair-both.types';
import { isRouterUnreachable } from './router-reachability';
import { isLocalNetworkAddress } from './local-network-address';

export type LocalNetworkState = 'blocked' | 'reachable' | 'unknown';

/**
 * The plain-words cause when macOS Local Network privacy stops the worker
 * reaching the main Harness on the home network. `binary` is the program macOS
 * lists under the setting (`node` for a source checkout).
 */
export function localNetworkBlockedMessage(binary: string = path.basename(process.execPath)): string {
  return `${LOCAL_NETWORK_BLOCKED_PREFIX} Turn on ${binary} under System Settings > Privacy & Security > Local Network.`;
}

/**
 * Remembers whether macOS Local Network privacy is blocking the worker.
 *
 * On 7 November 2026 the test Mac's LaunchAgent got EHOSTUNREACH for the main
 * Mac's home-network address while the same connection from an SSH shell
 * worked, and the worker only logged that the network was not ready. macOS
 * reports a refused Local Network permission as EHOSTUNREACH, so that error on
 * a private-range address, on macOS, names the setting. A private address
 * answering clears it.
 */
export class LocalNetworkEvidence {
  private state: LocalNetworkState = 'unknown';
  /** A home-network address failed with EHOSTUNREACH since the last check. */
  private suspected = false;

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly routerBlocked: () => Promise<boolean | undefined> = isRouterUnreachable,
  ) {}

  noteFailure(url: string, error: NodeJS.ErrnoException): void {
    if (this.platform !== 'darwin' || error.code !== 'EHOSTUNREACH') {
      return;
    }
    const reported = (error as unknown as { address?: unknown }).address;
    const address = typeof reported === 'string' ? reported : hostOf(url);
    if (address && isLocalNetworkAddress(address)) {
      this.suspected = true;
    }
  }

  /** A coordinator address answered. Only a home-network one proves the permission is on. */
  noteReachable(url: string, resolvedAddress?: string): void {
    const address = resolvedAddress ?? hostOf(url);
    if (address && isLocalNetworkAddress(address)) {
      this.state = 'reachable';
      this.suspected = false;
    }
  }

  /**
   * Decide what a home-network EHOSTUNREACH meant. The same error comes back
   * when the main Mac is asleep or off on the same network, so it only counts
   * as a block when the router is unreachable too: Local Network privacy
   * stops every home-network address, a sleeping Mac only itself.
   */
  async settle(): Promise<void> {
    if (!this.suspected) {
      return;
    }
    this.suspected = false;
    const blocked = await this.routerBlocked();
    if (blocked === true) {
      this.state = 'blocked';
    } else if (blocked === false && this.state === 'blocked') {
      this.state = 'unknown';
    }
  }

  get current(): LocalNetworkState {
    return this.state;
  }

  /** The message to show while blocked, otherwise undefined. */
  notice(): string | undefined {
    return this.state === 'blocked' ? localNetworkBlockedMessage() : undefined;
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return undefined;
  }
}
