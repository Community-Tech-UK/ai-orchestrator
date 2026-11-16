import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import type {
  PlanQueueLinearConnectionSnapshot,
  PlanQueueLinearConnectorChoice,
  PlanQueueLinearIdentity,
} from '@contracts/schemas/plan-queue';
import { PlanQueueIpcService } from '../../../core/services/ipc/plan-queue-ipc.service';
import { SettingsStore } from '../../../core/state/settings.store';
import { presentError } from '../../../../../shared/present-error';

interface StatusLine {
  readonly kind: 'success' | 'error' | 'info';
  readonly text: string;
}

type Busy = 'identify' | 'confirm' | 'test' | 'forget';

/** The reason a request failed, in the response's own words, or a plain fallback when it gave none. */
const failureText = (error: unknown): string => presentError(error).rawDetail || 'no answer';

/**
 * Which Harness connector Plan Queue reaches Linear through, and who it signs in as. Sign-in itself stays on the
 * Connectors page; this panel explains the connection and offers the one action that fixes a problem. Every call goes
 * to the main process, which checks the answer again: nothing is saved from here until the user confirms who the
 * connector signs in as and a second read agrees. Names and the email come from Linear and are shown as plain text.
 */
@Component({
  selector: 'app-plan-queue-linear-connection-panel',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './plan-queue-linear-connection-panel.component.html',
  styleUrl: './plan-queue-linear-connection-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueueLinearConnectionPanelComponent {
  private readonly ipc = inject(PlanQueueIpcService);
  private readonly settingsStore = inject(SettingsStore);

  /** Bumped by every load, so a slow older answer cannot overwrite a newer one. */
  private loadVersion = 0;

  protected readonly loaded = signal(false);
  protected readonly connectors = signal<readonly PlanQueueLinearConnectorChoice[]>([]);
  protected readonly connection = signal<PlanQueueLinearConnectionSnapshot | null>(null);
  protected readonly chosenId = signal('');
  /** Who the chosen connector signs in as, shown for the user to confirm. Nothing is saved while this is set. */
  protected readonly identity = signal<PlanQueueLinearIdentity | null>(null);
  protected readonly busy = signal<Busy | null>(null);
  protected readonly confirmingStop = signal(false);
  protected readonly status = signal<StatusLine | null>(null);

  /** The saved connection as a string, so the page reloads only when it really changed (here or elsewhere). */
  private readonly savedKey = computed(() => JSON.stringify(this.settingsStore.settings().planQueueLinearConnection ?? null));

  protected readonly usableChoices = computed(() => this.connectors().filter((choice) => choice.problem === null));
  protected readonly blockedChoices = computed(() => this.connectors().filter((choice) => choice.problem !== null));

  /** A saved connection whose connector still exists. A removed connector goes back to choosing one. */
  protected readonly isSetUp = computed(() => {
    const connection = this.connection();
    if (!connection || connection.state === 'not-set-up') return false;
    return !(connection.state === 'connector-changed' && connection.connectorProblem === 'gone');
  });

  /** The reason the connection is not usable. Not shown before anything is chosen: choosing is the whole page then. */
  protected readonly problem = computed(() => {
    const connection = this.connection();
    return connection && connection.state !== 'not-set-up' ? connection.reason : null;
  });

  /** The one action that fixes the current problem. */
  protected readonly fix = computed<'open-connectors' | 'check-who' | null>(() => {
    const connection = this.connection();
    switch (connection?.state) {
      case 'needs-sign-in':
        return 'open-connectors';
      case 'someone-else':
        return 'check-who';
      case 'connector-changed':
        return connection.connectorProblem === 'gone' ? null : 'open-connectors';
      default:
        return null;
    }
  });

  constructor() {
    // Load on first show, and again whenever the saved connection changes, so a change made elsewhere shows too.
    effect(() => {
      this.savedKey();
      untracked(() => void this.load());
    });
  }

  private async load(): Promise<void> {
    const version = ++this.loadVersion;
    const listed = await this.ipc.linearList();
    if (version !== this.loadVersion) return;
    if (!listed.success || !listed.data) {
      this.loaded.set(true);
      this.status.set({ kind: 'error', text: `Could not read the Linear connection: ${failureText(listed.error)}` });
      return;
    }
    this.connectors.set(listed.data.connectors);
    this.connection.set(listed.data.connection);
    this.loaded.set(true);
    const usable = listed.data.connectors.filter((choice) => choice.problem === null);
    if (!this.chosenId() && usable.length === 1) this.chosenId.set(usable[0].connectorId);
    // After a restart the first check is still running; wait for it so the page does not stay on "checking".
    if (listed.data.connection.state === 'checking') {
      const checked = await this.ipc.linearCheck();
      if (version === this.loadVersion && checked.success && checked.data) this.connection.set(checked.data);
    }
  }

  chooseConnector(connectorId: string): void {
    this.chosenId.set(connectorId);
    this.status.set(null);
  }

  /** Asks who the chosen connector (or, to fix a changed sign-in, the saved one) signs in as. Saves nothing. */
  async identify(connectorId: string | null): Promise<void> {
    if (!connectorId || this.busy()) return;
    this.busy.set('identify');
    this.status.set(null);
    try {
      const response = await this.ipc.linearIdentify(connectorId);
      if (response.success && response.data) this.identity.set(response.data);
      else this.status.set({ kind: 'error', text: `Could not check who this signs in as: ${failureText(response.error)}` });
    } finally {
      this.busy.set(null);
    }
  }

  async confirmIdentity(): Promise<void> {
    const who = this.identity();
    if (!who || this.busy()) return;
    this.busy.set('confirm');
    this.status.set(null);
    try {
      const response = await this.ipc.linearConfirm(who.connectorId, who.userId);
      // Either way the person shown is no longer what the connector is known to say, so ask again before trying again.
      this.identity.set(null);
      if (response.success && response.data) {
        this.connection.set(response.data);
        this.status.set({ kind: 'success', text: 'Saved. Linear work can use this connection.' });
      } else {
        this.status.set({ kind: 'error', text: `Could not save: ${failureText(response.error)}` });
      }
    } finally {
      this.busy.set(null);
    }
  }

  declineIdentity(): void {
    this.identity.set(null);
    this.status.set({ kind: 'info', text: 'Nothing was saved.' });
  }

  async test(): Promise<void> {
    if (this.busy()) return;
    this.busy.set('test');
    this.status.set(null);
    try {
      const response = await this.ipc.linearCheck();
      if (response.success && response.data) {
        this.connection.set(response.data);
        this.status.set(response.data.usable
          ? { kind: 'success', text: 'The connection works.' }
          : { kind: 'error', text: 'The connection is not working yet. The message above says what to do.' });
      } else {
        this.status.set({ kind: 'error', text: `Could not test the connection: ${failureText(response.error)}` });
      }
    } finally {
      this.busy.set(null);
    }
  }

  askToStop(): void {
    this.confirmingStop.set(true);
    this.status.set(null);
  }

  keepConnector(): void {
    this.confirmingStop.set(false);
  }

  async stop(): Promise<void> {
    if (this.busy()) return;
    this.busy.set('forget');
    this.status.set(null);
    try {
      const response = await this.ipc.linearForget();
      this.confirmingStop.set(false);
      if (response.success && response.data) {
        this.connection.set(response.data);
        this.status.set({ kind: 'success', text: 'Stopped. Linear work is paused until you choose a connector again.' });
      } else {
        this.status.set({ kind: 'error', text: `Could not stop using the connector: ${failureText(response.error)}` });
      }
    } finally {
      this.busy.set(null);
    }
  }
}
