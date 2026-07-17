import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { InstanceStore } from '../../core/state/instance/instance.store';
import type { Instance, InstanceStatus } from '../../core/state/instance/instance.types';

// ---------------------------------------------------------------------------
// Attention zones
// ---------------------------------------------------------------------------

const NEEDS_YOU_STATUSES = new Set<InstanceStatus>([
  'waiting_for_permission',
  'waiting_for_input',
  'error',
  'failed',
]);

const WORKING_STATUSES = new Set<InstanceStatus>([
  'busy',
  'processing',
  'thinking_deeply',
  'initializing',
  'respawning',
  'waking',
  'interrupting',
  'cancelling',
  'interrupt-escalating',
  'degraded',
]);

// Everything else (idle, ready, terminated, hibernated, superseded, cancelled, hibernating) → Idle/Done

/** Classify a single instance into one of the three attention zones. */
export function classifyInstance(status: InstanceStatus): 'needs-you' | 'working' | 'idle' {
  if (NEEDS_YOU_STATUSES.has(status)) return 'needs-you';
  if (WORKING_STATUSES.has(status)) return 'working';
  return 'idle';
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

export function relativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

export function basename(path: string): string {
  if (!path) return '';
  const trimmed = path.replace(/[/\\]+$/, '');
  const sep = trimmed.lastIndexOf('/') >= 0 ? '/' : '\\';
  const parts = trimmed.split(sep);
  return parts[parts.length - 1] ?? trimmed;
}

// ---------------------------------------------------------------------------
// Provider badge colour mapping
// ---------------------------------------------------------------------------

const PROVIDER_BADGE_CLASS: Record<string, string> = {
  claude: 'badge-claude',
  gemini: 'badge-gemini',
  codex: 'badge-codex',
  copilot: 'badge-copilot',
  cursor: 'badge-cursor',
  ollama: 'badge-ollama',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@Component({
  selector: 'app-fleet-dashboard',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    <div class="fleet-dashboard">
      <!-- Header -->
      <div class="fleet-header">
        <div class="fleet-header-left">
          <div class="fleet-heading">
            <span class="fleet-eyebrow">Fleet</span>
            <h1 class="fleet-title">Attention Zones</h1>
          </div>
        </div>
        <span class="fleet-total-badge">{{ store.instanceCount() }} total</span>
      </div>

      <!-- Empty state -->
      @if (store.instanceCount() === 0) {
        <div class="fleet-empty">
          <div class="fleet-empty-icon">⬡</div>
          <p class="fleet-empty-title">No instances running</p>
          <p class="fleet-empty-sub">Create an instance to get started.</p>
        </div>
      }

      @if (store.instanceCount() > 0) {
        <!-- Zone: Needs You -->
        <section class="zone zone-needs-you" [class.zone-empty]="needsYou().length === 0">
          <button class="zone-header" (click)="toggleZone('needs-you')" type="button">
            <span class="zone-dot dot-urgent"></span>
            <span class="zone-name">Needs You</span>
            <span class="zone-count">{{ needsYou().length }}</span>
            <span class="zone-chevron">{{ expandedZones().has('needs-you') ? '▾' : '▸' }}</span>
          </button>
          @if (expandedZones().has('needs-you')) {
            <div class="zone-cards">
              @for (inst of needsYou(); track inst.id) {
                <button
                  class="instance-card card-urgent"
                  [class.card-selected]="store.selectedInstanceId() === inst.id"
                  (click)="selectInstance(inst.id)"
                  type="button"
                >
                  <ng-container *ngTemplateOutlet="cardContent; context: { $implicit: inst }"></ng-container>
                </button>
              }
              @if (needsYou().length === 0) {
                <p class="zone-none">All clear</p>
              }
            </div>
          }
        </section>

        <!-- Zone: Working -->
        <section class="zone zone-working" [class.zone-empty]="working().length === 0">
          <button class="zone-header" (click)="toggleZone('working')" type="button">
            <span class="zone-dot dot-working"></span>
            <span class="zone-name">Working</span>
            <span class="zone-count">{{ working().length }}</span>
            <span class="zone-chevron">{{ expandedZones().has('working') ? '▾' : '▸' }}</span>
          </button>
          @if (expandedZones().has('working')) {
            <div class="zone-cards">
              @for (inst of working(); track inst.id) {
                <button
                  class="instance-card card-working"
                  [class.card-selected]="store.selectedInstanceId() === inst.id"
                  (click)="selectInstance(inst.id)"
                  type="button"
                >
                  <ng-container *ngTemplateOutlet="cardContent; context: { $implicit: inst }"></ng-container>
                </button>
              }
              @if (working().length === 0) {
                <p class="zone-none">Nothing active</p>
              }
            </div>
          }
        </section>

        <!-- Zone: Idle / Done -->
        <section class="zone zone-idle" [class.zone-empty]="idle().length === 0">
          <button class="zone-header" (click)="toggleZone('idle')" type="button">
            <span class="zone-dot dot-idle"></span>
            <span class="zone-name">Idle / Done</span>
            <span class="zone-count">{{ idle().length }}</span>
            <span class="zone-chevron">{{ expandedZones().has('idle') ? '▾' : '▸' }}</span>
          </button>
          @if (expandedZones().has('idle')) {
            <div class="zone-cards">
              @for (inst of idle(); track inst.id) {
                <button
                  class="instance-card card-idle"
                  [class.card-selected]="store.selectedInstanceId() === inst.id"
                  (click)="selectInstance(inst.id)"
                  type="button"
                >
                  <ng-container *ngTemplateOutlet="cardContent; context: { $implicit: inst }"></ng-container>
                </button>
              }
              @if (idle().length === 0) {
                <p class="zone-none">No idle instances</p>
              }
            </div>
          }
        </section>
      }
    </div>

    <!-- Shared card content template -->
    <ng-template #cardContent let-inst>
      <div class="card-row card-top">
        <span class="card-name" [title]="inst.displayName">{{ inst.displayName }}</span>
        <span class="card-provider-badge" [class]="providerBadgeClass(inst.provider)">
          {{ inst.provider }}
        </span>
      </div>
      <div class="card-row card-bottom">
        <span class="card-status-pill" [class]="statusPillClass(inst.status)">{{ inst.status }}</span>
        <span class="card-dir" [title]="inst.workingDirectory">{{ baseName(inst.workingDirectory) }}</span>
        <span class="card-time">{{ relTime(inst.lastActivity) }}</span>
      </div>
    </ng-template>
  `,
  styles: [`
    :host {
      display: block;
      height: 100%;
      overflow: auto;
    }

    .fleet-dashboard {
      display: flex;
      flex-direction: column;
      min-height: 100%;
      background: var(--bg-primary);
      color: var(--text-primary);
      padding: 0 0 24px;
    }

    /* ---- Header ---- */
    .fleet-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 24px 12px;
      border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.06));
      background: var(--bg-secondary);
      flex-shrink: 0;
    }

    .fleet-header-left {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      flex-wrap: wrap;
    }

    .fleet-heading {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .fleet-eyebrow {
      font-family: var(--font-mono, monospace);
      font-size: 9px;
      font-weight: 600;
      color: var(--text-muted, #9a9aa0);
    }

    .fleet-title {
      font-size: 16px;
      font-weight: 700;
      color: var(--text-primary);
      margin: 0;
    }

    .fleet-total-badge {
      font-family: var(--font-mono, monospace);
      font-size: 11px;
      color: var(--text-secondary, #c4c4c9);
      padding: 3px 10px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.07);
    }

    /* ---- Empty State ---- */
    .fleet-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      padding: 64px 24px;
      gap: 8px;
      color: var(--text-muted, #9a9aa0);
    }

    .fleet-empty-icon {
      font-size: 32px;
      opacity: 0.3;
      margin-bottom: 8px;
    }

    .fleet-empty-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-secondary, #c4c4c9);
      margin: 0;
    }

    .fleet-empty-sub {
      font-size: 12px;
      margin: 0;
    }

    /* ---- Zone Section ---- */
    .zone {
      margin: 12px 16px 0;
      border-radius: 10px;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.06);
      background: rgba(255, 255, 255, 0.015);
    }

    .zone-header {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 10px 14px;
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text-primary);
      text-align: left;
      transition: background 0.15s ease;

      &:hover {
        background: rgba(255, 255, 255, 0.03);
      }
    }

    .zone-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .dot-urgent {
      background: var(--error-color, #ef4444);
    }

    .dot-working {
      background: var(--warning-color, #f59e0b);
      animation: pulse-glow 1.8s ease-in-out infinite;
    }

    .dot-idle {
      background: var(--text-muted, #9a9aa0);
    }

    @keyframes pulse-glow {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    .zone-name {
      font-size: 12px;
      font-weight: 600;
      flex: 1;
    }

    .zone-count {
      font-family: var(--font-mono, monospace);
      font-size: 11px;
      min-width: 20px;
      padding: 2px 7px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.07);
      color: var(--text-secondary, #c4c4c9);
      text-align: center;
    }

    .zone-chevron {
      font-size: 10px;
      color: var(--text-muted, #9a9aa0);
      flex-shrink: 0;
    }

    .zone-needs-you > .zone-header {
      background: rgba(239, 68, 68, 0.06);

      &:hover {
        background: rgba(239, 68, 68, 0.1);
      }
    }

    .zone-needs-you > .zone-header .zone-count {
      background: rgba(239, 68, 68, 0.15);
      border-color: rgba(239, 68, 68, 0.3);
      color: var(--error-color, #ef4444);
    }

    /* ---- Cards Grid ---- */
    .zone-cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 8px;
      padding: 8px 12px 12px;
    }

    .zone-none {
      grid-column: 1 / -1;
      font-size: 12px;
      color: var(--text-muted, #9a9aa0);
      margin: 4px 0 0;
      padding: 4px 2px;
    }

    /* ---- Instance Card ---- */
    .instance-card {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 10px 12px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.025);
      border: 1px solid rgba(255, 255, 255, 0.06);
      cursor: pointer;
      text-align: left;
      color: inherit;
      transition: border-color 0.15s ease, background 0.15s ease;
      width: 100%;

      &:hover {
        background: rgba(255, 255, 255, 0.045);
        border-color: rgba(255, 255, 255, 0.12);
      }
    }

    .card-selected {
      border-color: var(--primary-color, #f59e0b) !important;
      background: rgba(var(--primary-rgb, 245 158 11), 0.06) !important;
    }

    .card-urgent {
      border-color: color-mix(in srgb, var(--error-color, #ef4444) 45%, transparent);
    }

    .card-working {
      border-color: color-mix(in srgb, var(--warning-color, #f59e0b) 45%, transparent);
    }

    .card-idle {
      opacity: 0.8;
    }

    .card-row {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }

    .card-top {
      justify-content: space-between;
    }

    .card-bottom {
      justify-content: flex-start;
    }

    .card-name {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    /* ---- Provider badges ---- */
    .card-provider-badge {
      font-family: var(--font-mono, monospace);
      font-size: 9px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      flex-shrink: 0;
    }

    .badge-claude   { background: rgba(204, 102, 51, 0.2);  color: #e0784a; }
    .badge-gemini   { background: rgba(66, 133, 244, 0.2);  color: #6fa8f5; }
    .badge-codex    { background: rgba(16, 185, 129, 0.2);  color: #34d399; }
    .badge-copilot  { background: rgba(184, 134, 95, 0.2);  color: #cba883; }
    .badge-cursor   { background: rgba(140, 165, 148, 0.2); color: #b3c9ba; }
    .badge-ollama   { background: rgba(156, 163, 175, 0.2); color: #d1d5db; }

    /* ---- Status pill ---- */
    .card-status-pill {
      font-family: var(--font-mono, monospace);
      font-size: 9px;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 999px;
      flex-shrink: 0;
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .pill-needs-you {
      background: rgba(239, 68, 68, 0.18);
      color: var(--error-color, #ef4444);
      border: 1px solid rgba(239, 68, 68, 0.3);
    }

    .pill-working {
      background: rgba(245, 158, 11, 0.15);
      color: var(--warning-color, #f59e0b);
      border: 1px solid rgba(245, 158, 11, 0.28);
    }

    .pill-idle {
      background: rgba(255, 255, 255, 0.04);
      color: var(--text-muted, #9a9aa0);
      border: 1px solid rgba(255, 255, 255, 0.07);
    }

    /* ---- Misc card fields ---- */
    .card-dir {
      font-family: var(--font-mono, monospace);
      font-size: 10px;
      color: var(--text-muted, #9a9aa0);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    .card-time {
      font-family: var(--font-mono, monospace);
      font-size: 10px;
      color: var(--text-muted, #9a9aa0);
      flex-shrink: 0;
    }
  `],
})
export class FleetDashboardComponent {
  protected readonly store = inject(InstanceStore);

  // Idle/Done zone is collapsed by default; the other two are expanded.
  protected readonly expandedZones = signal<Set<string>>(new Set(['needs-you', 'working']));

  // Partitioned instance lists
  readonly needsYou = computed<Instance[]>(() =>
    this.store.instances().filter((i) => classifyInstance(i.status) === 'needs-you')
  );

  readonly working = computed<Instance[]>(() =>
    this.store.instances().filter((i) => classifyInstance(i.status) === 'working')
  );

  readonly idle = computed<Instance[]>(() =>
    this.store.instances().filter((i) => classifyInstance(i.status) === 'idle')
  );

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  selectInstance(id: string): void {
    this.store.setSelectedInstance(id);
  }

  toggleZone(zone: string): void {
    this.expandedZones.update((set) => {
      const next = new Set(set);
      if (next.has(zone)) {
        next.delete(zone);
      } else {
        next.add(zone);
      }
      return next;
    });
  }

  // ---------------------------------------------------------------------------
  // Template helpers
  // ---------------------------------------------------------------------------

  protected baseName(path: string): string {
    return basename(path);
  }

  protected relTime(ts: number): string {
    return relativeTime(ts);
  }

  protected providerBadgeClass(provider: string): string {
    return PROVIDER_BADGE_CLASS[provider] ?? 'badge-ollama';
  }

  protected statusPillClass(status: InstanceStatus): string {
    const zone = classifyInstance(status);
    if (zone === 'needs-you') return 'card-status-pill pill-needs-you';
    if (zone === 'working') return 'card-status-pill pill-working';
    return 'card-status-pill pill-idle';
  }
}
