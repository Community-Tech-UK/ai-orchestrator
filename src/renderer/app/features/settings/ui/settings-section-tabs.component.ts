/**
 * Settings Section Tabs - shared in-page section switcher.
 *
 * Every overloaded Settings page (Remote Nodes, Permissions, Auxiliary
 * Models, …) reorganises around a small set of task-based sections. Rather
 * than each page re-implementing tab semantics, this component owns the
 * ARIA `tablist`/`tab` roles, the visible selected state, and roving-focus
 * keyboard movement (ArrowLeft/ArrowRight/Home/End). It does not own routing
 * or persistence — per the plan's shared interaction rules, internal
 * sections are page-local UI state chosen once at initialisation.
 */

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  output,
  viewChildren,
} from '@angular/core';

import type { SettingsSectionTab } from '../settings-navigation';

@Component({
  selector: 'app-settings-section-tabs',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="section-tabs" role="tablist" [attr.aria-label]="ariaLabel()">
      @for (tab of tabs(); track tab.id; let index = $index) {
        <button
          #tabButton
          type="button"
          class="section-tab"
          role="tab"
          [id]="tab.id"
          [attr.aria-selected]="tab.id === activeId()"
          [attr.aria-controls]="tab.panelId"
          [attr.tabindex]="tab.id === activeId() ? 0 : -1"
          [class.active]="tab.id === activeId()"
          (click)="activate(tab.id)"
          (keydown)="onKeydown($event, index)"
        >
          <span class="section-tab-label">{{ tab.label }}</span>
          @if (tab.badge) {
            <span class="section-tab-badge">{{ tab.badge }}</span>
          }
        </button>
      }
    </div>
  `,
  styleUrl: './settings-section-tabs.component.scss',
})
export class SettingsSectionTabsComponent {
  /** The tabs to render, in display order. Accepts a readonly list so callers
   *  can pass a frozen constant. */
  readonly tabs = input.required<readonly SettingsSectionTab[]>();
  /** The currently selected tab id. */
  readonly activeId = input.required<string>();
  /** Accessible name for the `tablist`. */
  readonly ariaLabel = input('Section');
  /** Emitted when the user selects a different tab (click or keyboard). */
  readonly activeIdChange = output<string>();

  private readonly tabButtons = viewChildren<ElementRef<HTMLButtonElement>>('tabButton');

  activate(id: string): void {
    if (id !== this.activeId()) {
      this.activeIdChange.emit(id);
    }
  }

  /**
   * Roving-focus keyboard model: Arrow keys move by one (wrapping at the
   * ends), Home/End jump to the first/last tab. The focused tab is always
   * activated immediately — there is no separate "focus without select"
   * step, matching the plan's "arrow/Home/End keyboard movement" requirement.
   */
  onKeydown(event: KeyboardEvent, index: number): void {
    const list = this.tabs();
    if (list.length === 0) {
      return;
    }

    let nextIndex: number | null = null;
    switch (event.key) {
      case 'ArrowRight':
        nextIndex = (index + 1) % list.length;
        break;
      case 'ArrowLeft':
        nextIndex = (index - 1 + list.length) % list.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = list.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const next = list[nextIndex];
    if (!next) {
      return;
    }
    this.activate(next.id);
    queueMicrotask(() => {
      this.tabButtons()[nextIndex]?.nativeElement.focus();
    });
  }
}
