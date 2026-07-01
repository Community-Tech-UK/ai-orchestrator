/**
 * Settings Nav Icon - curated icon set for the settings workspace.
 *
 * Each settings section maps to a recognizable stroke icon, giving the nav
 * and section headers visual "information scent" (copilot_todo.md items 1/12).
 * Icons are sized via `font-size` on the host (svg is 1em square).
 */

import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-settings-nav-icon',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (name()) {
      @case ('general') {
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="4" y1="9" x2="20" y2="9" /><line x1="4" y1="15" x2="20" y2="15" />
          <circle cx="9" cy="9" r="2.5" /><circle cx="15" cy="15" r="2.5" />
        </svg>
      }
      @case ('connections') {
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M9 12h6" /><path d="M8 8H6a4 4 0 0 0 0 8h2" /><path d="M16 8h2a4 4 0 0 1 0 8h-2" />
        </svg>
      }
      @case ('network') {
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" /><line x1="3" y1="12" x2="21" y2="12" />
          <path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18" />
        </svg>
      }
      @case ('display') {
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="12" rx="1.5" />
          <line x1="8" y1="20" x2="16" y2="20" /><line x1="12" y1="16" x2="12" y2="20" />
        </svg>
      }
      @case ('keyboard') {
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="2" y="6" width="20" height="12" rx="2" />
          <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
        </svg>
      }
      @case ('permissions') {
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z" /><path d="M9 12l2 2 4-4" />
        </svg>
      }
      @case ('orchestration') {
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" />
          <line x1="8.2" y1="10.8" x2="15.8" y2="7.2" /><line x1="8.2" y1="13.2" x2="15.8" y2="16.8" />
        </svg>
      }
      @case ('review') {
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M2 13l4 4 8-9" /><path d="M12 16l1.5 1.5L22 8" />
        </svg>
      }
      @case ('memory') {
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <ellipse cx="12" cy="6" rx="8" ry="3" />
          <path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6" /><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
        </svg>
      }
      @case ('models') {
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" />
        </svg>
      }
      @case ('mcp') {
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="7" rx="1.5" /><rect x="3" y="13" width="18" height="7" rx="1.5" />
          <path d="M7 7.5h.01M7 16.5h.01" />
        </svg>
      }
      @case ('hooks') {
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="5" r="2.5" /><line x1="12" y1="7.5" x2="12" y2="21" />
          <path d="M5 12a7 7 0 0 0 14 0" /><line x1="3" y1="12" x2="6" y2="12" /><line x1="18" y1="12" x2="21" y2="12" />
        </svg>
      }
      @case ('worktrees') {
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" />
          <path d="M6 8.5v7" /><path d="M18 10.5v1c0 2.8-2.2 5-5 5H9" />
        </svg>
      }
      @case ('snapshots') {
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 7h3l2-2h6l2 2h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" />
          <circle cx="12" cy="13" r="3.5" />
        </svg>
      }
      @case ('archive') {
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="4" rx="1" />
          <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" /><line x1="10" y1="12" x2="14" y2="12" />
        </svg>
      }
      @case ('remote-config') {
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M7 18a4 4 0 0 1 0-8 6 6 0 0 1 11.5 2A3.5 3.5 0 0 1 18 18z" />
        </svg>
      }
      @case ('cli-health') {
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 12h4l3 8 4-16 3 8h4" />
        </svg>
      }
      @case ('doctor') {
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" />
        </svg>
      }
      @case ('provider-quota') {
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 18a9 9 0 1 1 16 0" /><path d="M12 14l4-4" /><circle cx="12" cy="14" r="1.4" />
        </svg>
      }
      @case ('rtk-savings') {
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M13 2L4 14h6l-1 8 9-12h-6z" />
        </svg>
      }
      @case ('remote-nodes') {
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="2.5" />
          <path d="M7.5 7.5a7 7 0 0 0 0 9" /><path d="M16.5 7.5a7 7 0 0 1 0 9" />
          <path d="M4.5 4.5a11 11 0 0 0 0 15" /><path d="M19.5 4.5a11 11 0 0 1 0 15" />
        </svg>
      }
      @case ('voice') {
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z" />
          <path d="M5 11a7 7 0 0 0 14 0" />
          <path d="M12 18v3" />
          <path d="M8 21h8" />
        </svg>
      }
      @case ('ecosystem') {
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
      }
      @case ('advanced') {
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M5 7l5 5-5 5" /><line x1="12" y1="17" x2="19" y2="17" />
        </svg>
      }
      @case ('search') {
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" /><line x1="16" y1="16" x2="21" y2="21" />
        </svg>
      }
      @case ('back') {
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
        </svg>
      }
      @default {
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="8" />
        </svg>
      }
    }
  `,
  styleUrl: './settings-nav-icon.component.scss',
})
export class SettingsNavIconComponent {
  /** The settings section id, or a utility name (search, back). */
  readonly name = input.required<string>();
}
