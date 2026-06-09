import type { Browser } from 'puppeteer-core';
import type {
  BrowserLaunchProfileOptions,
  BrowserProcessLauncher,
  BrowserProcessRuntime,
} from './browser-process-launcher';
import { RemoteBrowserConnector } from './remote-browser-connector';

/** The subset of the local launcher the driver depends on. */
type LocalLauncher = Pick<
  BrowserProcessLauncher,
  'launchProfile' | 'getBrowser' | 'closeProfile'
>;

export interface RoutingBrowserLauncherDeps {
  local: LocalLauncher;
  connector?: RemoteBrowserConnector;
}

/**
 * Routes browser launches per profile: a profile with `executionNodeId` is
 * driven on that remote node via the CDP tunnel; everything else launches Chrome
 * locally. Implements the exact `launchProfile`/`getBrowser`/`closeProfile`
 * surface the driver consumes, so it drops in transparently.
 */
export class RoutingBrowserLauncher {
  private readonly local: LocalLauncher;
  private readonly connector: RemoteBrowserConnector;
  private readonly remoteProfiles = new Set<string>();

  constructor(deps: RoutingBrowserLauncherDeps) {
    this.local = deps.local;
    this.connector = deps.connector ?? new RemoteBrowserConnector();
  }

  async launchProfile(options: BrowserLaunchProfileOptions): Promise<BrowserProcessRuntime> {
    const nodeId = options.profile.executionNodeId;
    if (nodeId) {
      this.remoteProfiles.add(options.profile.id);
      try {
        return await this.connector.connect(options.profile.id, nodeId, options.startUrl);
      } catch (error) {
        this.remoteProfiles.delete(options.profile.id);
        throw error;
      }
    }
    return this.local.launchProfile(options);
  }

  getBrowser(profileId: string): Browser | null {
    return this.remoteProfiles.has(profileId)
      ? this.connector.getBrowser(profileId)
      : this.local.getBrowser(profileId);
  }

  async closeProfile(profileId: string): Promise<void> {
    if (this.remoteProfiles.has(profileId)) {
      this.remoteProfiles.delete(profileId);
      await this.connector.close(profileId);
      return;
    }
    await this.local.closeProfile(profileId);
  }
}
