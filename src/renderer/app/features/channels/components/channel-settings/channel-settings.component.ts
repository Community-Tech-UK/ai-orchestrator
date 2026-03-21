import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { ChannelStore } from '../../../../core/state/channel.store';

@Component({
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-channel-settings',
  template: `
    <div class="channels-page">
      <div class="page-header">
        <h2>Channel Settings</h2>
        <p class="subtitle">Manage access policies and paired accounts</p>
        <div class="nav-links">
          <button class="nav-btn" type="button" (click)="router.navigate(['/channels'])">Connections</button>
          <button class="nav-btn" type="button" (click)="router.navigate(['/channels/messages'])">Messages</button>
          <button class="nav-btn active" type="button">Settings</button>
        </div>
      </div>

      @for (platform of platforms; track platform.id) {
        <div class="settings-section">
          <h3>{{ platform.name }}</h3>

          <div class="setting-group">
            <label class="setting-label" [for]="'pair-code-' + platform.id">Pairing Code</label>
            <div class="pair-row">
              <input
                type="text"
                class="pair-input"
                maxlength="6"
                [id]="'pair-code-' + platform.id"
                [value]="platform.id === 'discord' ? discordPairCode() : whatsappPairCode()"
                (input)="platform.id === 'discord'
                  ? discordPairCode.set($any($event.target).value)
                  : whatsappPairCode.set($any($event.target).value)"
                placeholder="Enter 6-char code..."
              />
              <button
                class="btn btn-primary btn-sm"
                type="button"
                (click)="pair(platform.id, platform.id === 'discord' ? discordPairCode() : whatsappPairCode())"
                [disabled]="(platform.id === 'discord' ? discordPairCode() : whatsappPairCode()).length !== 6">
                Pair
              </button>
            </div>
            @if (pairResult()) {
              <div class="pair-result" [class.success]="pairResult() === 'success'" [class.error]="pairResult() === 'error'">
                {{ pairResult() === 'success' ? 'Sender paired successfully!' : 'Pairing failed. Check the code and try again.' }}
              </div>
            }
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .channels-page { padding: 1.5rem; max-width: 800px; }
    .page-header { margin-bottom: 1.5rem; }
    .page-header h2 { margin: 0 0 0.25rem; font-size: 1.5rem; }
    .subtitle { color: var(--text-muted, #888); margin: 0 0 1rem; font-size: 0.875rem; }
    .nav-links { display: flex; gap: 0.5rem; }
    .nav-btn {
      padding: 0.375rem 0.75rem; border: 1px solid var(--border-color, #333);
      border-radius: 4px; background: transparent; color: var(--text-primary, #ccc);
      cursor: pointer; font-size: 0.8125rem;
    }
    .nav-btn.active { background: var(--primary-color, #3b82f6); color: white; border-color: transparent; }
    .nav-btn:hover:not(.active) { background: var(--bg-tertiary, #2a2a2a); }

    .settings-section {
      border: 1px solid var(--border-color, #333); border-radius: 8px;
      padding: 1rem; margin-bottom: 1rem; background: var(--bg-secondary, #1e1e1e);
    }
    .settings-section h3 { margin: 0 0 0.75rem; font-size: 1.125rem; }

    .setting-group { margin-bottom: 0.75rem; }
    .setting-label { display: block; font-size: 0.8125rem; color: var(--text-muted, #888); margin-bottom: 0.375rem; }
    .pair-row { display: flex; gap: 0.5rem; }
    .pair-input {
      flex: 1; padding: 0.375rem 0.5rem; border: 1px solid var(--border-color, #333);
      border-radius: 4px; background: var(--bg-primary, #2a2a2a);
      color: var(--text-primary, #ccc); font-size: 0.875rem;
      font-family: var(--font-family-mono, monospace); text-transform: lowercase; letter-spacing: 0.1em;
    }
    .btn {
      padding: 0.375rem 0.75rem; border: none; border-radius: 4px;
      cursor: pointer; font-size: 0.8125rem; font-weight: 500;
    }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: var(--primary-color, #3b82f6); color: white; }
    .btn-sm { padding: 0.375rem 0.625rem; }
    .pair-result { padding: 0.375rem 0.5rem; border-radius: 4px; font-size: 0.8125rem; margin-top: 0.375rem; }
    .pair-result.success { background: color-mix(in srgb, var(--success-color, #22c55e) 10%, transparent); color: var(--success-color, #22c55e); }
    .pair-result.error { background: color-mix(in srgb, var(--error-color, #ef4444) 10%, transparent); color: var(--error-color, #ef4444); }
  `],
})
export class ChannelSettingsComponent {
  protected store = inject(ChannelStore);
  protected router = inject(Router);

  protected discordPairCode = signal('');
  protected whatsappPairCode = signal('');
  protected pairResult = signal<'success' | 'error' | null>(null);

  protected platforms = [
    { id: 'discord' as const, name: 'Discord' },
    { id: 'whatsapp' as const, name: 'WhatsApp' },
  ];

  async pair(platform: 'discord' | 'whatsapp', code: string): Promise<void> {
    this.pairResult.set(null);
    const success = await this.store.pairSender(platform, code);
    this.pairResult.set(success ? 'success' : 'error');
    if (success) {
      if (platform === 'discord') {
        this.discordPairCode.set('');
      } else {
        this.whatsappPairCode.set('');
      }
    }
  }
}
