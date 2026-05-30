import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { GatewayClient } from '../../core/gateway-client.service';
import type { MobileRecentDirDto } from '../../core/models';

const PROVIDERS = ['auto', 'claude', 'codex', 'gemini', 'copilot', 'cursor'] as const;

/**
 * Start a new session on the host. The working directory is picked from the
 * host's recent dirs (never a local file picker — see plan §5.2), plus an
 * optional provider/model and an initial prompt.
 */
@Component({
  standalone: true,
  selector: 'app-new-session',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <section class="screen">
      <header class="top">
        <button class="back" (click)="cancel()">‹</button>
        <h2>New session</h2>
        <span></span>
      </header>

      <span class="lbl">Working directory</span>
      @if (loadingDirs()) {
        <p class="muted">Loading the host's recent directories…</p>
      } @else if (dirs().length === 0) {
        <p class="muted">No recent directories on the host. Open one on the Mac first.</p>
      } @else {
        <ul class="dirs">
          @for (d of dirs(); track d.path) {
            <li>
              <button class="dir" [class.sel]="selectedDir() === d.path" (click)="selectedDir.set(d.path)">
                <span class="dname">{{ d.displayName }}{{ d.isPinned ? ' 📌' : '' }}</span>
                <span class="dpath">{{ d.path }}</span>
              </button>
            </li>
          }
        </ul>
      }

      <span class="lbl">Provider</span>
      <div class="providers">
        @for (p of providers; track p) {
          <button class="prov" [class.sel]="provider() === p" (click)="provider.set(p)">{{ p }}</button>
        }
      </div>

      <span class="lbl">Model (optional)</span>
      <input [ngModel]="model()" (ngModelChange)="model.set($event)" placeholder="e.g. opus / gpt-5.3-codex" />

      <span class="lbl">First message</span>
      <textarea
        rows="4"
        [ngModel]="firstPrompt()"
        (ngModelChange)="firstPrompt.set($event)"
        placeholder="What should the agent do?"
      ></textarea>

      @if (error()) {
        <p class="error">{{ error() }}</p>
      }

      <button class="cta" (click)="create()" [disabled]="busy() || !canCreate()">
        {{ busy() ? 'Starting…' : 'Start session' }}
      </button>
    </section>
  `,
  styles: [
    `
      .screen { padding: 16px; display: flex; flex-direction: column; gap: 10px; }
      .top { display: flex; align-items: center; justify-content: space-between; }
      .back { background: none; border: none; color: var(--accent-action); font-size: 26px; line-height: 1; }
      .lbl { font-size: 13px; color: var(--text-secondary); margin-top: 6px; }
      .muted { color: var(--text-secondary); }
      .dirs { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; max-height: 240px; overflow-y: auto; }
      .dir {
        width: 100%; text-align: left; background: var(--surface); border: 1px solid transparent;
        border-radius: 12px; padding: 10px 12px; color: var(--text); display: flex; flex-direction: column; gap: 2px;
      }
      .dir.sel { border-color: var(--accent-action); }
      .dname { font-size: 15px; }
      .dpath { font-size: 12px; color: var(--text-secondary); word-break: break-all; }
      .providers { display: flex; flex-wrap: wrap; gap: 6px; }
      .prov {
        background: var(--surface); border: none; color: var(--text-secondary);
        border-radius: var(--radius-pill); padding: 8px 14px; font-size: 14px; text-transform: capitalize;
      }
      .prov.sel { background: var(--accent-action); color: #fff; }
      .error { color: var(--accent-error); font-size: 14px; }
      .cta {
        margin-top: 12px; background: #fff; color: #000; border: none;
        border-radius: var(--radius-pill); padding: 14px; font-size: 16px; font-weight: 600;
      }
      .cta:disabled { opacity: 0.4; }
    `,
  ],
})
export class NewSessionComponent implements OnInit {
  private readonly gateway = inject(GatewayClient);
  private readonly router = inject(Router);

  /** Optional working directory key passed from a project's "New" button. */
  readonly dir = input<string>('');

  protected readonly providers = PROVIDERS;
  protected readonly dirs = signal<MobileRecentDirDto[]>([]);
  protected readonly loadingDirs = signal(true);
  protected readonly selectedDir = signal('');
  protected readonly provider = signal<(typeof PROVIDERS)[number]>('auto');
  protected readonly model = signal('');
  protected readonly firstPrompt = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    // Preselect the directory passed in the query param, when valid.
    effect(() => {
      const passed = this.dir();
      if (passed && passed !== '__no_workspace__' && !this.selectedDir()) {
        this.selectedDir.set(passed);
      }
    });
  }

  async ngOnInit(): Promise<void> {
    try {
      const dirs = await this.gateway.recentDirs();
      this.dirs.set(dirs);
      if (!this.selectedDir() && dirs[0]) {
        this.selectedDir.set(dirs[0].path);
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loadingDirs.set(false);
    }
  }

  protected canCreate(): boolean {
    return this.selectedDir().trim().length > 0;
  }

  protected async create(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const instance = await this.gateway.createInstance({
        workingDirectory: this.selectedDir(),
        provider: this.provider(),
        model: this.model().trim() || undefined,
        initialPrompt: this.firstPrompt().trim() || undefined,
      });
      const key = instance.workingDirectory || '__no_workspace__';
      void this.router.navigate(['/projects', key, 'sessions', instance.id]);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected cancel(): void {
    void this.router.navigate(['/projects']);
  }
}
