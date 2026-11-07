import { DestroyRef, Injectable, Signal, computed, signal } from '@angular/core';

const NOTICES = {
  'permission-approvals': 'Approvals',
  'browser-approvals': 'Browser approvals',
  'paid-fallback-decision': 'Paid fallback decision',
  pause: 'Paused',
  'needs-you-strip': 'Needs you',
  startup: 'Startup checks',
  'browser-computer-offline': 'Browser computer offline',
  'computer-use-permission': 'Computer Use permissions',
  'session-recovery': 'Session recovery',
  'app-update': 'App update',
  'away-recap': 'While you were away',
  'getting-started': 'Getting started',
} as const;
export type NoticeId = keyof typeof NOTICES;
const ORDER = Object.keys(NOTICES) as NoticeId[];
const BLOCKING = new Set<NoticeId>(ORDER.slice(0, 3));
interface Notice { id: NoticeId; label: string; visible: Signal<boolean> }

/** One ordinary notice row; time-limited decisions always remain visible. */
@Injectable({ providedIn: 'root' })
export class NoticeSlotService {
  private readonly registrations = signal<Notice[]>([]);
  private readonly isExpanded = signal(false);
  readonly expanded = this.isExpanded.asReadonly();
  private readonly active = computed(() => this.registrations().filter(n => n.visible())
    .sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id)));
  private readonly collapsed = computed(() => {
    const active = this.active();
    return active.filter((notice, index) => !BLOCKING.has(notice.id) &&
      (active.some(n => BLOCKING.has(n.id)) || index > 0));
  });
  readonly overflow = computed(() => this.collapsed());
  readonly hidden = computed(() => this.expanded() ? [] : this.collapsed());

  register(id: NoticeId, visible: Signal<boolean>, destroyRef: DestroyRef): Signal<boolean> {
    const notice = { id, label: NOTICES[id], visible };
    this.registrations.update(all => [...all.filter(n => n.id !== id), notice]);
    destroyRef.onDestroy(() => this.registrations.update(all => all.filter(n => n !== notice)));
    return computed(() => visible() && (this.expanded() || !this.collapsed().includes(notice)));
  }

  toggle(): void { this.isExpanded.update(expanded => !expanded); }
}
