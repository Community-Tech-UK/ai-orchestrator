import {
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  inject,
  input,
  OnInit,
  ViewChild,
} from '@angular/core';
import { RlmStorageMaintenanceStore } from '../../core/state/rlm-storage-maintenance.store';

@Component({
  selector: 'app-rlm-storage-maintenance',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.visible(); as visible) {
      <section class="rlm-storage-warning" [attr.data-level]="store.health()?.level">
        <div>
          <strong>{{ store.health()?.level === 'critical' ? 'RLM storage limit reached' : 'RLM storage needs maintenance' }}</strong>
          <span>
            {{ bytes(store.health()?.databaseSizeBytes ?? 0) }} is in use. Prune session stores unused for 60+ days
            and compact the database to keep loops running.
          </span>
        </div>
        <div class="warning-actions">
          <button type="button" class="primary" (click)="openPreview()" [disabled]="store.busy()">Review cleanup</button>
          <button type="button" (click)="store.dismiss()" [disabled]="store.busy()">Dismiss until restart</button>
        </div>
      </section>
    }

    @if (store.modalOpen()) {
      <div class="modal-backdrop" role="presentation">
        <section
          #dialog
          class="maintenance-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rlm-maintenance-title"
          tabindex="-1"
          (keydown.escape)="close()"
        >
          <header>
            <div>
              <span class="eyebrow">Storage maintenance</span>
              <h2 id="rlm-maintenance-title">Clean up stale RLM sessions</h2>
            </div>
            @if (!store.busy()) {
              <button type="button" class="icon-button" aria-label="Close" (click)="close()">×</button>
            }
          </header>

          @if (store.preview(); as preview) {
            <p>
              Harness will back up the database and external content, then remove session stores not used
              since {{ date(preview.cutoffTimestamp) }}. Live sessions and automatic codebase indexes are protected.
            </p>
            <div class="metrics">
              <div><span>Database size</span><strong>{{ bytes(preview.databaseSizeBytes) }}</strong></div>
              <div><span>External content</span><strong>{{ bytes(preview.externalContentSizeBytes) }}</strong></div>
              <div><span>Eligible stores</span><strong>{{ preview.eligibleStoreCount }}</strong></div>
              <div><span>Live protected</span><strong>{{ preview.protectedLiveStoreCount }}</strong></div>
              <div><span>Codebase protected</span><strong>{{ preview.protectedCodebaseAutoStoreCount }}</strong></div>
              <div><span>Reclaimable pages</span><strong>{{ bytes(preview.reclaimableDatabaseBytes) }}</strong></div>
            </div>
            <p>Backing up and compacting may take several minutes. Loops wait between iterations while maintenance runs.</p>
            <p class="backup-note">Backup destination: <code>{{ preview.backupDirectory }}</code></p>
            @if (!preview.canRun) {
              <p class="cleanup-warning">There are no stale session stores or free database pages that can be safely reclaimed.</p>
            }
          }

          @if (store.progress(); as progress) {
            <div class="progress" role="status" aria-live="polite">
              <span class="spinner" aria-hidden="true"></span>
              <div><strong>{{ stageLabel(progress.stage) }}</strong><span>{{ progress.message }}</span></div>
            </div>
          }

          @if (store.result(); as result) {
            @if (result.status === 'success') {
              <div class="result success" role="status">
                <strong>Cleanup completed and verified</strong>
                <span>{{ result.storesDeleted }} stores removed · {{ bytes(result.verifiedBytesReclaimed) }} reclaimed</span>
                <span>Database: {{ bytes(result.databaseSizeBeforeBytes) }} before · {{ bytes(result.databaseSizeAfterBytes) }} after</span>
                <span>External content: {{ bytes(result.externalContentSizeBeforeBytes) }} before · {{ bytes(result.externalContentSizeAfterBytes) }} after</span>
                <span>Backup: <code>{{ result.backupPath }}</code></span>
                @if (result.externalContentCleanupFailures > 0) {
                  <span class="cleanup-warning">{{ result.externalContentCleanupFailures }} external content files could not be removed.</span>
                }
                <span>
                  {{ result.loopResumed
                    ? 'The initiating loop resumed.'
                    : result.databaseHealthy
                      ? 'No paused initiating loop needed resuming.'
                      : 'The database is still at or above 12 GiB, so the loop remains paused.' }}
                </span>
              </div>
            } @else if (result.status === 'failed') {
              <div class="result failure" role="alert">
                <strong>Cleanup failed during {{ stageLabel(result.failedStage) }}</strong>
                <span>{{ result.error }}</span>
                @if (result.backupPath) { <span>Verified backup: <code>{{ result.backupPath }}</code></span> }
              </div>
            }
          }

          @if (store.error(); as error) {
            <div class="result failure" role="alert">{{ error }}</div>
          }

          <footer>
            @if (store.result()?.status === 'failed') {
              <button type="button" class="primary" (click)="retry()" [disabled]="store.busy()">Review retry</button>
            } @else if (store.result()?.status !== 'success') {
              <button
                type="button"
                class="primary"
                (click)="run()"
                [disabled]="store.busy() || !store.preview()?.canRun"
              >{{ store.busy() ? 'Maintenance running…' : 'Back up, prune & compact' }}</button>
            }
            @if (!store.busy()) {
              <button type="button" (click)="close()">Close</button>
            }
          </footer>
        </section>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .rlm-storage-warning { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:.8rem 1rem; border:1px solid color-mix(in srgb, var(--warning, #d89b22) 55%, transparent); border-radius:8px; background:color-mix(in srgb, var(--warning, #d89b22) 10%, var(--surface, #181a1f)); color:var(--text-primary, #f2f3f5); }
    .rlm-storage-warning[data-level='critical'] { border-color:color-mix(in srgb, var(--danger, #e05252) 65%, transparent); background:color-mix(in srgb, var(--danger, #e05252) 12%, var(--surface, #181a1f)); }
    .rlm-storage-warning div:first-child, .progress div, .result { display:flex; flex-direction:column; gap:.2rem; }
    .rlm-storage-warning span, .progress span, .result span { color:var(--text-secondary, #aeb3bd); font-size:.82rem; }
    .warning-actions, footer { display:flex; gap:.5rem; align-items:center; }
    button { border:1px solid var(--border-color, #3a3f49); border-radius:6px; background:var(--surface-raised, #252831); color:var(--text-primary, #f2f3f5); padding:.45rem .7rem; cursor:pointer; }
    button.primary { background:var(--accent-color, #6f7bf7); border-color:transparent; color:white; }
    button:disabled { cursor:not-allowed; opacity:.5; }
    button:focus-visible { outline:2px solid var(--accent-color, #8791ff); outline-offset:2px; }
    .modal-backdrop { position:fixed; inset:0; z-index:1200; display:grid; place-items:center; padding:1rem; background:rgba(4,5,8,.72); }
    .maintenance-modal { width:min(620px, 100%); max-height:min(760px, calc(100vh - 2rem)); overflow:auto; padding:1.2rem; border:1px solid var(--border-color, #363b45); border-radius:12px; background:var(--surface, #181a1f); box-shadow:0 24px 70px rgba(0,0,0,.42); color:var(--text-primary, #f2f3f5); }
    header { display:flex; justify-content:space-between; gap:1rem; align-items:flex-start; }
    h2 { margin:.15rem 0 .6rem; font-size:1.25rem; }
    .eyebrow { color:var(--accent-color, #8791ff); font-size:.72rem; font-weight:700; letter-spacing:.09em; text-transform:uppercase; }
    .icon-button { padding:.2rem .55rem; font-size:1.25rem; }
    p { color:var(--text-secondary, #aeb3bd); line-height:1.5; }
    .metrics { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:.6rem; margin:1rem 0; }
    .metrics div { display:flex; flex-direction:column; gap:.2rem; padding:.75rem; border-radius:8px; background:var(--surface-raised, #252831); }
    .metrics span { color:var(--text-secondary, #aeb3bd); font-size:.75rem; }
    .backup-note code, .result code { overflow-wrap:anywhere; }
    .progress, .result { display:flex; gap:.7rem; margin:1rem 0; padding:.8rem; border-radius:8px; background:var(--surface-raised, #252831); }
    .progress { flex-direction:row; align-items:center; }
    .spinner { width:1rem; height:1rem; flex:none; border:2px solid var(--border-color, #515764); border-top-color:var(--accent-color, #8791ff); border-radius:50%; animation:spin .8s linear infinite; }
    .success { border-left:3px solid var(--success, #48b77a); }
    .failure { border-left:3px solid var(--danger, #e05252); }
    .cleanup-warning { color:var(--warning, #e1a53a) !important; }
    footer { justify-content:flex-end; margin-top:1rem; }
    @keyframes spin { to { transform:rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation:none; } }
    @media (max-width: 560px) { .rlm-storage-warning { align-items:flex-start; flex-direction:column; } .metrics { grid-template-columns:1fr; } }
  `],
})
export class RlmStorageMaintenanceComponent implements OnInit {
  readonly loopRunId = input<string | null>(null);
  readonly refreshKey = input<string | null>(null);
  protected readonly store = inject(RlmStorageMaintenanceStore);
  private focusReturnTarget: HTMLElement | null = null;
  @ViewChild('dialog')
  private set dialog(element: ElementRef<HTMLElement> | undefined) {
    if (element) queueMicrotask(() => element.nativeElement.focus());
  }
  private readonly refreshOnLoopChange = effect(() => {
    this.loopRunId();
    this.refreshKey();
    void this.store.refreshHealth();
  });

  ngOnInit(): void {
    void this.store.restoreStatus();
  }

  protected openPreview(): void {
    this.focusReturnTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void this.store.openPreview(this.loopRunId() ?? undefined);
  }
  protected run(): void { void this.store.run(this.loopRunId() ?? undefined); }
  protected retry(): void { void this.store.openPreview(this.loopRunId() ?? undefined); }
  protected close(): void {
    this.store.closePreview();
    queueMicrotask(() => this.focusReturnTarget?.focus());
  }

  protected bytes(value: number): string {
    if (value < 1024) return `${value} B`;
    const units = ['KiB', 'MiB', 'GiB', 'TiB'];
    let amount = value;
    let unit = -1;
    do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1);
    return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
  }

  protected date(timestamp: number): string {
    return new Date(timestamp).toLocaleDateString();
  }

  protected stageLabel(stage: string): string {
    return stage.replace(/-/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
  }
}
