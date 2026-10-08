/**
 * Browser Computer Offline Banner
 *
 * Shell-level warning shown while no paired browser computer (a worker node
 * that runs browser work, e.g. the Windows PC) can take browser work — the
 * same condition under which the Browser Gateway refuses to fall back to this
 * Mac (browser-remote-offload-policy.ts guardOfflineBrowserComputer). Deliberately
 * not dismissable and cleared only by the node reconnecting: on 2026-10-07 the
 * desktop notification for six such drops never reached the user, and browser
 * work silently moved onto this Mac instead. Presentation only — state comes
 * from {@link RemoteNodeStore}.
 */

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import type { RemoteNodeRosterEntry } from '../../../../shared/types/worker-node.types';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { isRemoteNodeOnline } from '../../core/state/remote-node-connectivity';
import { SettingsStore } from '../../core/state/settings.store';

@Component({
  selector: 'app-browser-computer-offline-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (unavailable().length > 0) {
      <section class="browser-offline-banner" role="status" aria-live="polite">
        <span class="status-dot" aria-hidden="true"></span>
        <div class="banner-copy">
          <strong>{{ title() }}</strong>
          <span>{{ detail() }}</span>
          @for (node of hinted(); track node.id) {
            <span class="hint">{{ node.connectivityHint }}</span>
          }
        </div>
      </section>
    }
  `,
  styles: [`
    .browser-offline-banner {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      min-height: 40px;
      padding: 0.55rem 1rem;
      border-top: 1px solid rgba(239, 68, 68, 0.38);
      border-bottom: 1px solid rgba(239, 68, 68, 0.38);
      background: rgba(239, 68, 68, 0.14);
      color: var(--text-primary, #e5e5e5);
      z-index: 1002;
    }

    .status-dot {
      width: 9px;
      height: 9px;
      flex: 0 0 auto;
      border-radius: 999px;
      background: #ef4444;
      box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.16);
    }

    .banner-copy {
      min-width: 0;
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      column-gap: 0.65rem;
      row-gap: 0.15rem;
      font-size: 0.84rem;
    }

    .banner-copy span {
      color: var(--text-secondary, #cbd5e1);
    }

    .banner-copy .hint {
      color: #fde68a;
    }
  `],
})
export class BrowserComputerOfflineBannerComponent {
  private readonly nodes = inject(RemoteNodeStore);
  private readonly settings = inject(SettingsStore);

  /**
   * Paired browser computers, when none of them can take browser work. One
   * healthy browser computer is enough for browser work, so then nothing shows.
   */
  protected readonly unavailable = computed<RemoteNodeRosterEntry[]>(() => {
    if (!this.settings.isInitialized() || !this.settings.get('remoteNodesEnabled')) return [];
    const browserComputers = this.nodes.nodes().filter((node) => node.browserComputer === true);
    // Usable exactly as the Browser Gateway guard judges it: connected and
    // currently reporting browser automation.
    return browserComputers.some((node) => node.status === 'connected' && node.hasBrowserMcp)
      ? []
      : browserComputers;
  });

  protected readonly hinted = computed(() => this.unavailable().filter((node) => node.connectivityHint));

  protected readonly title = computed(() => this.unavailable().map(describeNode).join('; '));

  protected readonly detail = computed(() =>
    this.settings.get('remoteNodesAutoOffloadBrowser')
      ? 'Agents will ask you before using this Mac’s browser.'
      : 'Browser work that needs it will not run until it reconnects.');
}

function describeNode(node: RemoteNodeRosterEntry): string {
  if (isRemoteNodeOnline(node)) {
    // Degraded or still connecting: registered, yet not taking work.
    if (node.status !== 'connected') return `${node.name} is not responding`;
    return `${node.name} is not ready for browser work`;
  }
  const lastSeen = lastSeenAt(node);
  return lastSeen
    ? `${node.name} is offline (last seen ${formatLastSeen(lastSeen)})`
    : `${node.name} is offline`;
}

function lastSeenAt(node: RemoteNodeRosterEntry): number | undefined {
  return node.lastHeartbeat ?? node.lastAuthenticatedAt;
}

function formatLastSeen(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return new Date(now).toDateString() === date.toDateString()
    ? time
    : `${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`;
}
