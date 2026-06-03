/**
 * PanelZoneComponent — right-docked collapsible panel shell.
 *
 * A generic VS-Code-style right sidebar that hosts one or more named panels.
 * The always-visible activity strip shows one icon button per panel; clicking
 * a button expands that panel's content area. Clicking the same button again
 * (or the close button inside the panel header) collapses it.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * USAGE
 * ──────────────────────────────────────────────────────────────────────────
 *
 * ```html
 * <app-panel-zone [panels]="panels">
 *   <ng-template appPanelZoneId="outline">
 *     <app-outline-panel />
 *   </ng-template>
 *
 *   <ng-template appPanelZoneId="search">
 *     <app-search-panel />
 *   </ng-template>
 * </app-panel-zone>
 * ```
 *
 * ```ts
 * readonly panels: PanelDescriptor[] = [
 *   { id: 'outline', label: 'Outline', icon: '<path d="M3 6h18M3 12h18M3 18h18"/>' },
 *   { id: 'search', label: 'Search',  icon: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/>' },
 * ];
 * ```
 *
 * The component renders the `<ng-template>` whose `panelZoneId` matches
 * `activePanelId`. When collapsed (`activePanelId === null`) only the
 * thin activity strip is shown.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * PANEL WIDTH
 * ──────────────────────────────────────────────────────────────────────────
 * Default expanded width is 280 px, controlled by the `--panel-zone-width`
 * CSS custom property. Override it on the host element or in a parent scope:
 *
 * ```css
 * app-panel-zone { --panel-zone-width: 320px; }
 * ```
 *
 * ──────────────────────────────────────────────────────────────────────────
 * READING ACTIVE PANEL FROM THE OUTSIDE
 * ──────────────────────────────────────────────────────────────────────────
 * The `activePanelId` output emits the new panel id (or `null`) on every
 * change, so a parent can react to expand/collapse events.
 */

import {
  ChangeDetectionStrategy,
  Component,
  contentChildren,
  Directive,
  inject,
  input,
  output,
  signal,
  TemplateRef,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';

// ─── Panel descriptor ────────────────────────────────────────────────────────

/** Metadata for a single panel hosted by PanelZoneComponent. */
export interface PanelDescriptor {
  /** Unique identifier; must match the `panelZoneId` on the companion `<ng-template>`. */
  id: string;
  /** Tooltip / accessible label shown on the activity-strip button. */
  label: string;
  /**
   * SVG path `d` string(s) — same convention as workspace-rail / sidebar-nav.
   * The icon is injected into a 16×16 `<svg>` viewport. Omit for a text fallback.
   *
   * @example '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/>'
   */
  icon?: string;
}

// ─── Content-projection directive ────────────────────────────────────────────

/**
 * Structural marker directive. Place it on an `<ng-template>` inside
 * `<app-panel-zone>` to register its content as the panel body for `id`.
 *
 * ```html
 * <ng-template appPanelZoneId="myPanel">…content…</ng-template>
 * ```
 */
@Directive({
  selector: '[appPanelZoneId]',
  standalone: true,
})
export class PanelZoneContentDirective {
  /** Must match the `id` of the corresponding `PanelDescriptor`. */
  readonly panelZoneId = input.required<string>({ alias: 'appPanelZoneId' });

  readonly templateRef = inject(TemplateRef<unknown>);
}

// ─── Component ───────────────────────────────────────────────────────────────

@Component({
  selector: 'app-panel-zone',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet],
  styleUrl: './panel-zone.component.scss',
  template: `
    <div
      class="panel-zone"
      [class.is-open]="activePanelId() !== null"
      [attr.aria-label]="'Right panel dock'"
      role="complementary"
    >
      <!-- ── Activity strip (always visible) ──────────────────────────── -->
      <div class="activity-strip" role="tablist" aria-orientation="vertical">
        @for (panel of panels(); track panel.id) {
          <button
            type="button"
            class="strip-btn"
            role="tab"
            [attr.aria-selected]="activePanelId() === panel.id"
            [attr.aria-controls]="'panel-content-' + panel.id"
            [attr.aria-label]="panel.label"
            [attr.title]="panel.label"
            [class.active]="activePanelId() === panel.id"
            (click)="togglePanel(panel.id)"
          >
            @if (panel.icon) {
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
                [innerHTML]="panel.icon"
              ></svg>
            } @else {
              <span class="strip-text-icon" aria-hidden="true">
                {{ panel.label.charAt(0).toUpperCase() }}
              </span>
            }
          </button>
        }
      </div>

      <!-- ── Panel content area (expanded when a panel is active) ──────── -->
      @if (activePanelId() !== null) {
        <div
          class="panel-content-area"
          [attr.id]="'panel-content-' + activePanelId()"
          role="tabpanel"
          [attr.aria-label]="activePanelLabel()"
        >
          <!-- Panel header -->
          <div class="panel-header">
            <span class="panel-title">{{ activePanelLabel() }}</span>
            <button
              type="button"
              class="panel-close-btn"
              aria-label="Close panel"
              title="Close"
              (click)="closePanel()"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <!-- Projected template content -->
          @for (slot of contentSlots(); track slot.panelZoneId()) {
            @if (slot.panelZoneId() === activePanelId()) {
              <div class="panel-body">
                <ng-container [ngTemplateOutlet]="slot.templateRef" />
              </div>
            }
          }
        </div>
      }
    </div>
  `,
})
export class PanelZoneComponent {
  // ── Inputs ──────────────────────────────────────────────────────────────

  /** Panel descriptors — drives both the activity strip and the header label. */
  readonly panels = input<PanelDescriptor[]>([]);

  // ── Content children ────────────────────────────────────────────────────

  /** Projected `<ng-template panelZoneId="…">` slots. */
  readonly contentSlots = contentChildren(PanelZoneContentDirective);

  // ── Outputs ─────────────────────────────────────────────────────────────

  /** Emits the new `id` whenever a panel opens, or `null` when collapsed. */
  readonly activePanelChanged = output<string | null>();

  // ── Internal state ──────────────────────────────────────────────────────

  /** Currently open panel id; `null` = dock is collapsed. */
  readonly activePanelId = signal<string | null>(null);

  // ── Derived ─────────────────────────────────────────────────────────────

  /** Label of the active panel for the header and aria-label. */
  activePanelLabel(): string {
    const id = this.activePanelId();
    return this.panels().find(p => p.id === id)?.label ?? '';
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  /**
   * Toggle the given panel open/closed.
   * - If already open: collapses the dock.
   * - If a different panel is open: switches to the new one without collapsing.
   * - If collapsed: opens the panel.
   */
  togglePanel(id: string): void {
    const next = this.activePanelId() === id ? null : id;
    this.activePanelId.set(next);
    this.activePanelChanged.emit(next);
  }

  /** Explicitly close/collapse the dock. */
  closePanel(): void {
    this.activePanelId.set(null);
    this.activePanelChanged.emit(null);
  }
}
