/**
 * N9 — one line saying everything that is blocked on you right now.
 *
 * A pending approval showed only as a per-row chip in the instance list. That
 * works when someone is looking at the list; it means nothing when three
 * sessions have been sitting blocked for an hour behind a collapsed sidebar.
 * The overnight reminder (`pending-approval-watcher.ts`) covers the away case
 * with a desktop notification; this covers the at-the-keyboard case, where a
 * notification has long since been dismissed but the sessions are still stuck.
 *
 * **The text comes from main's digest, not from a second calculation here.**
 * The renderer tracks `pendingApprovalCount` per instance but has no approval
 * timestamps, so "the oldest has been waiting an hour" could not be computed
 * locally — and a banner that disagreed with the notification about how many
 * sessions are blocked would make both untrustworthy.
 */
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  HostListener,
  OnInit,
  inject,
  signal,
} from '@angular/core';

import { InstanceStore } from '../../core/state/instance.store';

/** Mirrors `PendingApprovalDigest` (`src/main/orchestration/pending-approval-digest.ts`). */
interface ApprovalDigest {
  instances: number;
  approvals: number;
  oldestAgeMs: number;
  oldestInstanceId: string;
  title: string;
  body: string;
}

interface ApprovalDigestApi {
  permissionGetApprovalDigest?: () => Promise<{
    success: boolean;
    data?: { digest?: ApprovalDigest | null };
  }>;
}

/**
 * Slow on purpose. An approval that has been waiting an hour is not more
 * urgent for being re-counted every second, and this polls a SQLite table.
 */
const POLL_MS = 30_000;

@Component({
  selector: 'app-approval-digest-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (digest(); as d) {
      <aside class="approval-digest" role="status" aria-live="polite">
        <span class="approval-digest__text">{{ d.body }}</span>
        <button
          type="button"
          class="approval-digest__go"
          (click)="goToOldest(d.oldestInstanceId)"
        >Show the oldest</button>
      </aside>
    }
  `,
  styleUrl: './approval-digest-banner.component.scss',
})
export class ApprovalDigestBannerComponent implements OnInit {
  private readonly instances = inject(InstanceStore);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly digest = signal<ApprovalDigest | null>(null);

  ngOnInit(): void {
    void this.refresh();
    const timer = window.setInterval(() => void this.refresh(), POLL_MS);
    this.destroyRef.onDestroy(() => window.clearInterval(timer));
  }

  /** Approvals arrive while you are away, so re-check the moment you come back. */
  @HostListener('window:focus')
  protected onFocus(): void {
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    const api = (window as unknown as { electronAPI?: ApprovalDigestApi }).electronAPI;
    // Absent in a browser-served dev build and in tests that do not stub it.
    // Showing nothing is right: the banner claims a fact it cannot check.
    if (!api?.permissionGetApprovalDigest) return;
    try {
      const response = await api.permissionGetApprovalDigest();
      this.digest.set(response.success ? response.data?.digest ?? null : null);
    } catch {
      // A failed poll must not leave a stale count on screen implying sessions
      // are still blocked when we no longer know.
      this.digest.set(null);
    }
  }

  protected goToOldest(instanceId: string): void {
    this.instances.setSelectedInstance(instanceId);
  }
}
