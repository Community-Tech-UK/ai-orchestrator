import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export const MOBILE_ICON_PATHS = {
  menu: 'M5 8h14M5 16h10',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  folder: 'M3 7.5h7l2 2h9v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7.5Z',
  compose:
    'm13.5 5.5 5-5a2.12 2.12 0 0 1 3 3l-5 5-3-3ZM12 7H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7',
  'chevron-down': 'm7 9 5 5 5-5',
  'chevron-left': 'm15 18-6-6 6-6',
  search: 'm21 21-4.35-4.35M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z',
  plus: 'M12 5v14M5 12h14',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  pause: 'M9 5v14M15 5v14',
  play: 'm8 5 11 7-11 7V5Z',
  host: 'M4 5h16v11H4V5ZM2 20h20M9 16v4M15 16v4',
  provider: 'm12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z',
  settings:
    'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6V20h-4v-.08a1.7 1.7 0 0 0-1-.52 1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1H4v-4h.08a1.7 1.7 0 0 0 .52-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06L7.06 4.2l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6V4h4v.08a1.7 1.7 0 0 0 1 .52 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 .6 1h.08v4H20a1.7 1.7 0 0 0-.6 1Z',
  microphone:
    'M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3ZM19 11a7 7 0 0 1-14 0M12 18v4',
  'arrow-up': 'm6 10 6-6 6 6M12 4v16',
  attachment:
    'm20 11-8.5 8.5a5 5 0 0 1-7-7L14 3a3.5 3.5 0 0 1 5 5l-9.5 9.5a2 2 0 0 1-3-3L15 6',
  clipboard:
    'M9 4h6a2 2 0 0 1 2 2v1h1a2 2 0 0 1 2 2v10H8a2 2 0 0 1-2-2V7H5a2 2 0 0 1-2-2h3M8 7h10v12H8V7Z',
  close: 'm6 6 12 12M18 6 6 18',
  check: 'm5 12 4 4L19 6',
  lock: 'M6 10h12v11H6V10ZM8 10V7a4 4 0 0 1 8 0v3M12 14v3',
  tool: 'm14.7 6.3 3-3a5 5 0 0 1-6.2 6.2L5 16l3 3 6.5-6.5a5 5 0 0 1 6.2-6.2l-3 3-3-3Z',
  warning: 'M12 3 2.5 20h19L12 3ZM12 9v5M12 18h.01',
  error: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM8 8l8 8M16 8l-8 8',
  qr: 'M3 3h7v7H3V3ZM14 3h7v7h-7V3ZM3 14h7v7H3v-7ZM14 14h3v3h-3v-3ZM18 14h3v7h-3M14 19h3v2h-3v-2Z',
} as const;

export const MOBILE_ICON_NAMES = Object.keys(MOBILE_ICON_PATHS) as (keyof typeof MOBILE_ICON_PATHS)[];
export type MobileIconName = keyof typeof MOBILE_ICON_PATHS;

@Component({
  standalone: true,
  selector: 'app-mobile-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true' },
  template: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path [attr.d]="path()" />
    </svg>
  `,
  styles: [
    `
      :host,
      svg {
        display: block;
        width: 1em;
        height: 1em;
      }

      path {
        stroke-width: 1.8;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
    `,
  ],
})
export class MobileIconComponent {
  readonly name = input.required<MobileIconName>();
  protected readonly path = computed(() => MOBILE_ICON_PATHS[this.name()]);
}
