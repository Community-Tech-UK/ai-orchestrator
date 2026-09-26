import { ChangeDetectionStrategy, Component, DestroyRef, untracked, computed, effect, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { GatewayClient } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';
import { MobileBrowseStateStore } from '../../core/mobile-browse-state.store';
import { TranscriptStore } from '../../core/transcript-store';
import type { MobileHistorySessionDto } from '../../core/models';
import { MobileHeaderComponent } from '../../shared/mobile-header.component';
import { MobileIconComponent } from '../../shared/mobile-icon.component';
import { TranscriptViewComponent } from '../conversation/transcript-view.component';
import { newSessionPresetState } from '../new-session/new-session.navigation';

/** Archived sessions share the same windowed transcript as live conversations. */
@Component({
  standalone: true,
  selector: 'app-history-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MobileHeaderComponent, MobileIconComponent, TranscriptViewComponent],
  template: `
    <section class="screen">
      <app-mobile-header class="history-header" [title]="session()?.name || 'Past session'" [subtitle]="online() ? 'Read-only' : 'Read-only · Offline'">
        <button mobileHeaderLeading class="mobile-icon-button" type="button" (click)="back()"
          [attr.aria-label]="returnRoute() === '/projects' ? 'Back to projects' : 'Back to history'">
          <app-mobile-icon name="chevron-left" />
        </button>
        <span mobileHeaderTrailing aria-hidden="true"></span>
      </app-mobile-header>
      @if (identityLoading()) { <p class="identity-feedback" role="status">Loading session details…</p> }
      @if (identityError()) {
        <div class="identity-feedback" role="alert">{{ identityError() }}
          <button type="button" (click)="loadIdentity()" [disabled]="identityLoading()">Retry session details</button>
        </div>
      }
      <details class="session-identity">
        <summary>Session details</summary>
        <p>{{ session()?.name || 'Past session' }}</p>
        @if (session(); as info) {
          <p>{{ info.projectName }} · {{ info.archived ? 'Archived' : 'Past session' }}</p>
          <p>{{ info.workingDirectory }}</p>
          <p>{{ info.provider }} {{ info.model }}</p>
          @if (info.workingDirectory) {
            <button type="button" (click)="newSession()" [disabled]="!online()">Start a new session in this project</button>
          }
        }
        <p>{{ hostName() }} · {{ online() ? 'Connected' : 'Offline' }} · Read-only</p>
      </details>
      @if (!online() && messages().length) { <p class="identity-feedback">Showing the cached transcript.</p> }
      <app-transcript-view
        [transcriptKey]="transcriptKey()" [messages]="messages()" [state]="state()"
        [emptyText]="emptyText()" [hasEarlier]="hasEarlier()"
        [earlierLoading]="earlierState().status === 'loading'" [earlierError]="earlierState().error"
        [earlierDisabled]="!online()" (retryTranscript)="load()" (loadEarlier)="loadEarlier()"
      />
    </section>
  `,
  styles: [`
    :host {
      position: fixed; inset: 0; z-index: 0;
      display: flex; flex-direction: column; background: var(--bg);
      padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
    }
    .screen { display: flex; flex-direction: column; flex: 1; min-height: 0; }
    .history-header { flex: none; padding: var(--space-2) var(--mobile-gutter) 0; }
    .session-identity { flex: none; max-height: 35dvh; overflow: auto; padding-inline: var(--mobile-gutter); font-size: var(--font-size-sm); color: var(--text-secondary); overflow-wrap: anywhere; }
    .identity-feedback { flex: none; margin: var(--space-2) var(--mobile-gutter); color: var(--text-secondary); font-size: var(--font-size-sm); }
    .identity-feedback[role="alert"] { color: var(--accent-error); }
    .session-identity summary, .session-identity button, .identity-feedback button { min-height: var(--control-size); align-content: center; }
    .session-identity button, .identity-feedback button { border: 0; background: transparent; color: var(--accent-action); }
    .session-identity p { margin-block: var(--space-2); }
  `],
})
export class HistoryDetailComponent {
  private readonly gateway = inject(GatewayClient);
  private readonly router = inject(Router);
  private readonly hosts = inject(HostStore);
  private readonly browse = inject(MobileBrowseStateStore);
  private readonly transcripts = new TranscriptStore();
  private readonly origin = this.router.getCurrentNavigation()?.extras.state ?? window.history.state;
  private loadGeneration = 0;
  private identityGeneration = 0;
  protected readonly returnRoute = computed(() => this.browse.returnRoute(this.origin, '/history'));
  protected readonly online = this.gateway.online;
  protected readonly hostName = computed(() => this.hosts.activeHost()?.name || 'Host');
  protected readonly session = signal<MobileHistorySessionDto | null>(null);
  protected readonly identityLoading = signal(true);
  protected readonly identityError = signal<string | null>(null);
  readonly chatId = input<string>('');
  protected readonly transcriptKey = computed(() => JSON.stringify([this.hosts.activeHost()?.id ?? '', this.chatId()]));
  protected readonly messages = computed(() => this.transcripts.messagesFor(this.chatId()));
  protected readonly state = computed(() => this.transcripts.messageStateFor(this.chatId()));
  protected readonly earlierState = computed(() => this.transcripts.earlierStateFor(this.chatId()));
  protected readonly hasEarlier = computed(() => this.transcripts.hasEarlierFor(this.chatId()));
  protected readonly emptyText = computed(() => this.state().status === 'loading' ? 'Loading…'
    : this.state().status === 'error' ? 'The transcript could not be loaded.' : 'This session has no recorded messages.');

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.loadGeneration++; this.identityGeneration++; this.transcripts.reset();
    });
    effect(() => {
      this.chatId(); this.hosts.activeHost();
      untracked(() => {
        this.loadGeneration++;
        this.transcripts.reset();
        this.session.set(null);
        void this.load();
        void this.loadIdentity();
      });
    });
  }

  protected async load(): Promise<void> {
    const generation = ++this.loadGeneration;
    const hostId = this.hosts.activeHost()?.id;
    const chatId = this.chatId();
    await this.transcripts.loadMessages(chatId, async () => {
      try { return await this.gateway.historyMessagePage(chatId); }
      catch { throw new Error('The transcript could not be loaded. Check the host connection and try again.'); }
    }, () => generation === this.loadGeneration && hostId === this.hosts.activeHost()?.id && chatId === this.chatId());
  }

  protected async loadEarlier(): Promise<void> {
    const generation = this.loadGeneration;
    const key = this.transcriptKey();
    const id = this.chatId();
    await this.transcripts.loadEarlier(id, async beforeSeq => {
      const page = await this.gateway.historyMessagePage(id, beforeSeq);
      if (Array.isArray(page)) throw new Error('This host does not support earlier message pages. Update the host and try again.');
      return page;
    }, () => generation === this.loadGeneration && key === this.transcriptKey());
  }

  protected async loadIdentity(): Promise<void> {
    const generation = ++this.identityGeneration;
    const hostId = this.hosts.activeHost()?.id;
    const chatId = this.chatId();
    const current = () => generation === this.identityGeneration && hostId === this.hosts.activeHost()?.id && chatId === this.chatId();
    this.identityLoading.set(true);
    this.identityError.set(null);
    const cached = this.gateway.dataHostId() === hostId ? this.gateway.historySessions().find(item => item.id === chatId) : undefined;
    if (cached) this.session.set(cached);
    try {
      const sessions = await this.gateway.history();
      if (!current()) return;
      const session = sessions.find(item => item.id === chatId);
      if (session) this.session.set(session);
      else this.identityError.set('Session details could not be found on this host. Try refreshing them.');
    } catch {
      if (current()) this.identityError.set('Session details could not be loaded. Check the host connection and try again.');
    } finally {
      if (current()) this.identityLoading.set(false);
    }
  }

  protected newSession(): void {
    const directory = this.session()?.workingDirectory;
    if (!directory || !this.online()) return;
    void this.router.navigate(['/new-session'], {
      queryParams: { dir: directory },
      state: { ...this.browse.navigationState(this.returnRoute()), ...newSessionPresetState(this.hosts.activeHost()?.id, directory) },
    });
  }

  protected back(): void { void this.router.navigate([this.returnRoute()]); }
}
