/**
 * Remote Node Detail — the "detail" half of the Computers list/detail
 * workspace (Task 4). Owns the capability chips, repair panel, browser/Android
 * automation editors, connection commands, and revoke action for exactly one
 * selected node. All async operations and authoritative state stay in the
 * parent tab; this component only owns transient drafting UI state (which
 * config panel is open, the in-progress form values) and emits typed intents.
 */
import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal } from '@angular/core';
import type { RemoteNodeRosterEntry } from '../../../../shared/types/worker-node.types';
import type { BrowserAutomationConfigInput } from '../../core/services/ipc/remote-node-ipc.service';
import {
  type NodeHealthEntry,
  buildNodeHealthEntries,
  browserAutomationState,
  browserAutomationLabel,
  extensionRelayState,
  extensionRelayLabel,
  androidAutomationState,
  androidAutomationLabel,
  loginCommandPreview,
} from './remote-nodes-browser-automation';
import {
  buildNodeDiagnostics,
  formatNodeCapacity,
  formatNodePlatformLabel,
  formatRelativeTime,
} from './remote-nodes-pairing-ui';
import {
  RemoteNodeAndroidConfigComponent,
  type AndroidAutomationConfigDraft,
} from './remote-node-android-config.component';
import { RemoteNodeRepairPanelComponent } from './remote-node-repair-panel.component';

/** Typed user intents the parent tab performs (owns IPC calls + confirmations). */
export type RemoteNodeDetailAction =
  | { type: 'repair'; nodeId: string }
  | { type: 'revoke'; nodeId: string }
  | { type: 'reset-connection'; nodeId: string }
  | {
      type: 'configure-browser';
      nodeId: string;
      config: BrowserAutomationConfigInput;
      extensionRelayEnabled: boolean;
    }
  | { type: 'configure-android'; nodeId: string; config: AndroidAutomationConfigDraft }
  | { type: 'run-login'; nodeId: string; url: string }
  | { type: 'copy'; value: string; description: string };

@Component({
  standalone: true,
  selector: 'app-remote-node-detail',
  imports: [RemoteNodeAndroidConfigComponent, RemoteNodeRepairPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './remote-node-detail.component.html',
  styleUrl: './remote-node-detail.component.scss',
})
export class RemoteNodeDetailComponent {
  readonly node = input.required<RemoteNodeRosterEntry>();
  /** Whether a browser/Android-automation apply or a login launch is in flight (parent-owned). */
  readonly baBusy = input(false);
  readonly aaBusy = input(false);
  readonly loginBusy = input(false);
  readonly loginNotice = input<string | null>(null);

  readonly backRequested = output<void>();
  readonly actionRequested = output<RemoteNodeDetailAction>();

  protected readonly healthEntry = computed<NodeHealthEntry>(
    () => buildNodeHealthEntries([this.node()])[0],
  );

  protected readonly formatNodePlatformLabel = formatNodePlatformLabel;
  protected readonly formatNodeCapacity = formatNodeCapacity;
  protected readonly formatRelativeTime = formatRelativeTime;
  protected readonly browserAutomationState = browserAutomationState;
  protected readonly browserAutomationLabel = browserAutomationLabel;
  protected readonly extensionRelayState = extensionRelayState;
  protected readonly extensionRelayLabel = extensionRelayLabel;
  protected readonly androidAutomationState = androidAutomationState;
  protected readonly androidAutomationLabel = androidAutomationLabel;

  // Browser-automation drafting — seeded only when the panel is opened (never
  // reactively resynced from live data, so in-progress edits are never
  // clobbered by a background roster refresh).
  protected readonly browserConfigOpen = signal(false);
  protected readonly baDraftEnabled = signal(false);
  protected readonly baDraftProfileDir = signal('');
  protected readonly baDraftHeadless = signal(false);
  protected readonly baDraftExtensionRelayEnabled = signal(false);

  protected readonly androidConfigOpen = signal(false);

  protected readonly loginUrlDraft = signal('https://www.facebook.com');

  private previousNodeId: string | null = null;

  constructor() {
    // Switching the selected node closes any open drafting panel for the
    // previous node rather than showing it against the newly-selected one.
    effect(() => {
      const id = this.node().id;
      if (id !== this.previousNodeId) {
        this.previousNodeId = id;
        this.browserConfigOpen.set(false);
        this.androidConfigOpen.set(false);
        this.loginUrlDraft.set('https://www.facebook.com');
      }
    });
  }

  protected toggleBrowserConfig(): void {
    if (this.browserConfigOpen()) {
      this.browserConfigOpen.set(false);
      return;
    }
    const entry = this.healthEntry();
    this.baDraftEnabled.set(entry.browserAutomation?.enabled ?? entry.browserAutomationReady);
    this.baDraftProfileDir.set(entry.browserAutomation?.profileDir ?? '');
    this.baDraftHeadless.set(entry.browserAutomation?.headless ?? false);
    this.baDraftExtensionRelayEnabled.set(entry.extensionRelay?.enabled ?? entry.extensionRelayReady);
    this.browserConfigOpen.set(true);
  }

  protected submitBrowserConfig(): void {
    const profileDir = this.baDraftProfileDir().trim();
    this.actionRequested.emit({
      type: 'configure-browser',
      nodeId: this.node().id,
      config: {
        enabled: this.baDraftEnabled(),
        headless: this.baDraftHeadless(),
        ...(profileDir ? { profileDir } : {}),
      },
      extensionRelayEnabled: this.baDraftExtensionRelayEnabled(),
    });
  }

  protected toggleAndroidConfig(): void {
    this.androidConfigOpen.update((open) => !open);
  }

  protected submitAndroidConfig(payload: AndroidAutomationConfigDraft): void {
    this.actionRequested.emit({ type: 'configure-android', nodeId: this.node().id, config: payload });
  }

  protected requestRevoke(): void {
    this.actionRequested.emit({ type: 'revoke', nodeId: this.node().id });
  }

  protected requestReset(): void {
    this.actionRequested.emit({ type: 'reset-connection', nodeId: this.node().id });
  }

  protected requestRunLogin(): void {
    this.actionRequested.emit({ type: 'run-login', nodeId: this.node().id, url: this.loginUrlDraft() });
  }

  protected copyDiagnostics(): void {
    this.actionRequested.emit({
      type: 'copy',
      value: JSON.stringify(buildNodeDiagnostics(this.healthEntry()), null, 2),
      description: 'remote node diagnostics',
    });
  }

  protected copyLoginCommand(): void {
    const command = this.loginCommandPreview();
    if (command) {
      this.actionRequested.emit({ type: 'copy', value: command, description: 'remote node login command' });
    }
  }

  protected loginCommandPreview(): string {
    return loginCommandPreview(this.healthEntry(), this.loginUrlDraft());
  }
}
