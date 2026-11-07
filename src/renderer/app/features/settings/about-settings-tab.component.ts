import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import type { AppBuildInfo } from '@contracts/schemas/observability';
import { AppIpcService } from '../../core/services/ipc/app-ipc.service';

@Component({
  selector: 'app-about-settings-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p>Details of the running Harness app.</p>
    @if (error(); as message) { <p role="alert">{{ message }}</p> }
    @if (info()) {
      <dl>@for (row of rows(); track row.label) { <dt>{{ row.label }}</dt><dd>{{ row.value }}</dd> }</dl>
      <button type="button" (click)="copy()">Copy build details</button>
      @if (copied()) { <p role="status">Copied build details.</p> }
      <h3>Migration levels</h3>
      @if (info()!.migrations.length) {
        <dl>@for (migration of info()!.migrations; track migration.name) { <dt>{{ migration.name }}</dt><dd>{{ migration.level ?? 'Unverified' }}</dd> }</dl>
      } @else { <p>Unverified. Migration levels could not be read.</p> }
    } @else if (!error()) { <p role="status">Loading build details…</p> }
  `,
  styles: ['dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 16px; } dd { margin: 0; overflow-wrap: anywhere; }'],
})
export class AboutSettingsTabComponent implements OnInit {
  private readonly ipc = inject(AppIpcService);
  readonly info = signal<AppBuildInfo | null>(null);
  readonly error = signal('');
  readonly copied = signal(false);
  readonly rows = computed(() => {
    const info = this.info();
    return info ? [
      { label: 'Version', value: info.version }, { label: 'Build', value: info.builtAt ?? 'Unverified' },
      { label: 'Branch', value: info.branch ?? 'Unverified' }, { label: 'Commit', value: info.commit ?? 'Unverified' },
      { label: 'Local changes at build', value: info.dirty === null ? 'Unverified' : info.dirty ? 'Yes' : 'No' },
      { label: 'Data folder', value: info.dataFolder },
    ] : [];
  });
  async ngOnInit(): Promise<void> {
    try {
      const info = await this.ipc.getBuildInfo();
      this.info.set(info);
      if (!info) this.error.set('Build details require the desktop app.');
    } catch { this.error.set('Build information could not be read.'); }
  }
  async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText([...this.rows().map(row => `${row.label}: ${row.value}`),
        ...(this.info()?.migrations ?? []).map(row => `${row.name}: ${row.level ?? 'Unverified'}`)].join('\n'));
      this.copied.set(true);
    } catch { this.error.set('Build details could not be copied.'); }
  }
}
