import type { Browser } from 'puppeteer-core';
import type { BrowserProcessRuntime } from './browser-process-launcher';
import { BrowserProfileStore, getBrowserProfileStore } from './browser-profile-store';
import { getRemoteCdpTunnelClient } from '../remote-node/remote-cdp-tunnel';
import { getLogger } from '../logging/logger';

const logger = getLogger('RemoteBrowserConnector');

/**
 * Connects, holds, and releases a puppeteer `Browser` that drives a REMOTE
 * node's Chrome over the CDP tunnel (Path 2). The gateway's driver treats this
 * Browser identically to a locally-launched one — all governance stays on the
 * coordinator. We `disconnect()` (never `close()`) on teardown so the node's
 * Chrome (owned by its WorkerBrowserManager) keeps running.
 */
export interface RemoteCdpTunnelClientLike {
  connectBrowser(nodeId: string): Promise<Browser>;
}

export interface RemoteBrowserConnectorDeps {
  tunnelClient?: RemoteCdpTunnelClientLike;
  profileStore?: Pick<BrowserProfileStore, 'setRuntimeState'>;
}

export class RemoteBrowserConnector {
  private readonly tunnelClient: RemoteCdpTunnelClientLike;
  private readonly profileStore: Pick<BrowserProfileStore, 'setRuntimeState'>;
  private readonly browsers = new Map<string, Browser>();

  constructor(deps: RemoteBrowserConnectorDeps = {}) {
    this.tunnelClient = deps.tunnelClient ?? getRemoteCdpTunnelClient();
    this.profileStore = deps.profileStore ?? getBrowserProfileStore();
  }

  async connect(
    profileId: string,
    nodeId: string,
    startUrl?: string,
  ): Promise<BrowserProcessRuntime> {
    if (this.browsers.has(profileId)) {
      await this.close(profileId);
    }
    const browser = await this.tunnelClient.connectBrowser(nodeId);
    this.browsers.set(profileId, browser);
    this.attachDisconnectHandler(profileId, browser);

    if (startUrl) {
      try {
        const pages = await browser.pages();
        const page = pages[0] ?? (await browser.newPage());
        await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      } catch (error) {
        logger.warn('Remote profile start URL navigation failed', {
          profileId,
          nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const runtime: BrowserProcessRuntime = {
      debugPort: 0,
      debugEndpoint: `remote://${nodeId}`,
    };
    const now = Date.now();
    this.setRuntimeStateSafe(profileId, {
      status: 'running',
      debugPort: undefined,
      debugEndpoint: runtime.debugEndpoint,
      processId: undefined,
      lastLaunchedAt: now,
      lastUsedAt: now,
    });
    return runtime;
  }

  getBrowser(profileId: string): Browser | null {
    return this.browsers.get(profileId) ?? null;
  }

  async close(profileId: string): Promise<void> {
    const browser = this.browsers.get(profileId);
    this.browsers.delete(profileId);
    if (browser) {
      try {
        // Detach our transport; do NOT close — the node's Chrome lives on.
        await (browser as unknown as { disconnect(): Promise<void> | void }).disconnect();
      } catch {
        /* already gone */
      }
    }
    this.markStopped(profileId);
  }

  async closeAll(): Promise<void> {
    for (const profileId of [...this.browsers.keys()]) {
      await this.close(profileId);
    }
  }

  private setRuntimeStateSafe(
    profileId: string,
    patch: Parameters<BrowserProfileStore['setRuntimeState']>[1],
  ): void {
    try {
      this.profileStore.setRuntimeState(profileId, patch);
    } catch (error) {
      // The profile may have been deleted; runtime-state bookkeeping is best-effort.
      logger.debug('Remote profile runtime-state update skipped', {
        profileId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private attachDisconnectHandler(profileId: string, browser: Browser): void {
    const onDisconnected = (): void => {
      if (this.browsers.get(profileId) !== browser) return;
      this.browsers.delete(profileId);
      this.markStopped(profileId);
    };
    const eventSource = browser as unknown as {
      once?: (event: string, listener: () => void) => void;
      on?: (event: string, listener: () => void) => void;
    };
    if (typeof eventSource.once === 'function') {
      eventSource.once('disconnected', onDisconnected);
    } else {
      eventSource.on?.('disconnected', onDisconnected);
    }
  }

  private markStopped(profileId: string): void {
    this.setRuntimeStateSafe(profileId, {
      status: 'stopped',
      debugPort: undefined,
      debugEndpoint: undefined,
      processId: undefined,
    });
  }
}
