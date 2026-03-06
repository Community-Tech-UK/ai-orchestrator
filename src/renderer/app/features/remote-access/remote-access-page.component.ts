import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { RemoteObserverIpcService } from '../../core/services/ipc/remote-observer-ipc.service';
import type { RemoteObserverStatus } from '../../../../shared/types/remote-observer.types';

@Component({
  selector: 'app-remote-access-page',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="hero">
        <div>
          <button class="back-btn" type="button" (click)="goBack()">← Back</button>
          <p class="eyebrow">Read-only Access</p>
          <h1>Remote Access</h1>
          <p class="subtitle">
            Start a tokenized observer URL so another device can watch running instances, repo jobs, and prompts in read-only mode.
          </p>
        </div>

        <button class="ghost" type="button" (click)="refresh()" [disabled]="loading()">
          Refresh
        </button>
      </header>

      @if (error()) {
        <div class="banner error">{{ error() }}</div>
      }

      @if (info()) {
        <div class="banner info">{{ info() }}</div>
      }

      <section class="panel control-panel">
        <label class="field">
          <span>Host</span>
          <input type="text" [value]="host()" (input)="host.set(getInputValue($event))" />
        </label>

        <label class="field">
          <span>Port</span>
          <input type="number" [value]="port().toString()" (input)="port.set(getNumberValue($event, 4877))" />
        </label>

        <div class="button-row">
          <button class="primary" type="button" (click)="start()" [disabled]="loading() || status()?.running">
            Start Observer
          </button>
          <button class="ghost" type="button" (click)="stop()" [disabled]="loading() || !status()?.running">
            Stop
          </button>
          <button class="ghost" type="button" (click)="rotateToken()" [disabled]="loading() || !status()?.running">
            Rotate Token
          </button>
        </div>
      </section>

      <section class="stats-grid">
        <article class="stat-card">
          <span class="stat-label">Status</span>
          <strong>{{ status()?.running ? 'Running' : 'Stopped' }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">Mode</span>
          <strong>{{ status()?.mode || 'read-only' }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">Instances</span>
          <strong>{{ status()?.instanceCount ?? 0 }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">Repo Jobs</span>
          <strong>{{ status()?.jobCount ?? 0 }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">Pending Prompts</span>
          <strong>{{ status()?.pendingPromptCount ?? 0 }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">Last Event</span>
          <strong>{{ formatDate(status()?.lastEventAt) }}</strong>
        </article>
      </section>

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Observer URLs</h2>
            <p>Each URL includes the current access token.</p>
          </div>
          <span class="token">{{ status()?.token || 'no token' }}</span>
        </div>

        @if (!status()?.observerUrls?.length) {
          <p class="empty">Start the observer to generate access URLs.</p>
        } @else {
          <ul class="url-list">
            @for (url of status()!.observerUrls; track url) {
              <li>
                <a [href]="url" target="_blank" rel="noreferrer">{{ url }}</a>
              </li>
            }
          </ul>
        }
      </section>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      min-height: 100%;
      background:
        radial-gradient(circle at top right, rgba(56, 189, 248, 0.12), transparent 28rem),
        linear-gradient(180deg, #07111c 0%, #091521 100%);
      color: #e5eef6;
    }

    .page {
      max-width: 72rem;
      margin: 0 auto;
      padding: 2rem 1.25rem 3rem;
      display: grid;
      gap: 1rem;
    }

    .hero,
    .button-row,
    .panel-header {
      display: flex;
      gap: 1rem;
      justify-content: space-between;
    }

    .hero {
      align-items: flex-end;
    }

    h1,
    h2,
    p {
      margin: 0;
    }

    h1 {
      font-size: clamp(2rem, 4vw, 3rem);
      line-height: 0.98;
    }

    .back-btn,
    button {
      border: 0;
      border-radius: 999px;
      padding: 0.72rem 1rem;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }

    .back-btn,
    .ghost {
      background: rgba(148, 163, 184, 0.14);
      color: #f8fafc;
    }

    .primary {
      background: linear-gradient(135deg, #38bdf8 0%, #0ea5e9 100%);
      color: #04131e;
    }

    button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .eyebrow,
    .stat-label,
    .field span {
      text-transform: uppercase;
      letter-spacing: 0.12em;
      font-size: 0.72rem;
      color: #8dc5ff;
    }

    .subtitle,
    .panel-header p,
    .empty {
      color: #9fb3c7;
    }

    .panel,
    .stat-card,
    .banner {
      border: 1px solid rgba(148, 163, 184, 0.18);
      background: rgba(7, 18, 30, 0.86);
      backdrop-filter: blur(10px);
      border-radius: 1rem;
      box-shadow: 0 1rem 2rem rgba(0, 0, 0, 0.18);
    }

    .panel,
    .banner {
      padding: 1rem;
    }

    .banner.error {
      color: #fecaca;
      border-color: rgba(248, 113, 113, 0.28);
    }

    .banner.info {
      color: #bbf7d0;
      border-color: rgba(34, 197, 94, 0.28);
    }

    .control-panel {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(10rem, 14rem) auto;
      gap: 1rem;
      align-items: end;
    }

    .field {
      display: grid;
      gap: 0.45rem;
    }

    input {
      width: 100%;
      border-radius: 0.85rem;
      border: 1px solid rgba(148, 163, 184, 0.22);
      background: rgba(15, 23, 42, 0.72);
      color: #f8fafc;
      padding: 0.8rem 0.9rem;
      font: inherit;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
      gap: 0.9rem;
    }

    .stat-card {
      padding: 1rem 1.1rem;
      display: grid;
      gap: 0.25rem;
    }

    .panel-header {
      align-items: flex-start;
      margin-bottom: 0.85rem;
    }

    .token {
      font-family: var(--font-family-mono, monospace);
      font-size: 0.8rem;
      color: #bae6fd;
      word-break: break-all;
      text-align: right;
    }

    .url-list {
      margin: 0;
      padding-left: 1.15rem;
      display: grid;
      gap: 0.55rem;
    }

    a {
      color: #7dd3fc;
      word-break: break-all;
    }

    @media (max-width: 860px) {
      .hero,
      .button-row,
      .panel-header {
        flex-direction: column;
        align-items: stretch;
      }

      .control-panel {
        grid-template-columns: 1fr;
      }
    }
  `],
})
export class RemoteAccessPageComponent {
  private readonly router = inject(Router);
  private readonly observerIpc = inject(RemoteObserverIpcService);

  readonly host = signal('127.0.0.1');
  readonly port = signal(4877);
  readonly status = signal<RemoteObserverStatus | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly info = signal<string | null>(null);

  constructor() {
    void this.refresh();
  }

  goBack(): void {
    void this.router.navigate(['/']);
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    try {
      const response = await this.observerIpc.getStatus();
      if (!response.success || !response.data) {
        throw new Error(response.error?.message || 'Failed to load observer status.');
      }

      this.status.set(response.data);
      if (response.data.host) {
        this.host.set(response.data.host);
      }
      if (response.data.port) {
        this.port.set(response.data.port);
      }
    } catch (error) {
      this.error.set((error as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  async start(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.info.set(null);

    try {
      const response = await this.observerIpc.start(this.host().trim() || undefined, this.port());
      if (!response.success || !response.data) {
        throw new Error(response.error?.message || 'Failed to start remote observer.');
      }

      this.status.set(response.data);
      this.info.set('Remote observer started.');
    } catch (error) {
      this.error.set((error as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  async stop(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.info.set(null);

    try {
      const response = await this.observerIpc.stop();
      if (!response.success || !response.data) {
        throw new Error(response.error?.message || 'Failed to stop remote observer.');
      }

      this.status.set(response.data);
      this.info.set('Remote observer stopped.');
    } catch (error) {
      this.error.set((error as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  async rotateToken(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.info.set(null);

    try {
      const response = await this.observerIpc.rotateToken();
      if (!response.success || !response.data) {
        throw new Error(response.error?.message || 'Failed to rotate observer token.');
      }

      this.status.set(response.data);
      this.info.set('Observer token rotated.');
    } catch (error) {
      this.error.set((error as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  getInputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  getNumberValue(event: Event, fallback: number): number {
    const value = Number((event.target as HTMLInputElement).value);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  formatDate(timestamp: number | undefined): string {
    if (!timestamp) {
      return 'n/a';
    }
    return new Date(timestamp).toLocaleString();
  }
}
