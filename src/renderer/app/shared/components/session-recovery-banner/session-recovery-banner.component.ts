import { ChangeDetectionStrategy, Component, OnInit, computed, inject, output } from '@angular/core';
import type {
  SessionRecoveryCandidate,
  SessionRecoveryReason,
} from '../../../../../shared/types/session-recovery.types';
import { SessionRecoveryDismissalStore } from '../../../core/state/session-recovery-dismissal.store';
import { SessionRecoveryStore } from '../../../core/state/session-recovery.store';

function newestRecoveryCandidate(candidates: readonly SessionRecoveryCandidate[]): SessionRecoveryCandidate | null {
  return [...candidates].sort((left, right) =>
    right.lastActivityAt - left.lastActivityAt || left.recoveryKey.localeCompare(right.recoveryKey)
  )[0] ?? null;
}

function candidateTitle(candidate: SessionRecoveryCandidate): string {
  return candidate.displayName
    ?? candidate.historyThreadId
    ?? candidate.sourceInstanceId;
}

function reasonLabel(reason: SessionRecoveryReason): string {
  switch (reason) {
    case 'newer-than-history':
      return 'newer than history';
    case 'unarchived':
      return 'not in history';
    case 'draft-only':
      return 'draft only';
  }

  const exhaustive: never = reason;
  return exhaustive;
}

function messageCountLabel(count: number): string {
  return `${count} autosaved message${count === 1 ? '' : 's'}`;
}

@Component({
  selector: 'app-session-recovery-banner',
  standalone: true,
  templateUrl: './session-recovery-banner.component.html',
  styleUrl: './session-recovery-banner.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionRecoveryBannerComponent implements OnInit {
  protected readonly store = inject(SessionRecoveryStore);
  private readonly dismissalStore = inject(SessionRecoveryDismissalStore);
  readonly openRecoveryRequested = output<void>();

  protected readonly candidates = this.store.candidates;
  protected readonly primaryCandidate = computed(() => newestRecoveryCandidate(this.candidates()));
  protected readonly candidateCount = computed(() => this.candidates().length);
  protected readonly candidateFingerprint = computed(() =>
    this.candidates()
      .map(candidate => `${candidate.recoveryKey}:${candidate.sourceInstanceId}`)
      .sort()
      .join('|')
  );
  protected readonly visible = computed(() => {
    const fingerprint = this.candidateFingerprint();
    return this.candidates().length > 0 && !this.dismissalStore.isDismissed(fingerprint);
  });
  protected readonly title = computed(() => {
    const count = this.candidateCount();
    return count === 1 ? 'Autosaved session available' : `${count} autosaved sessions available`;
  });
  protected readonly summary = computed(() => {
    const candidate = this.primaryCandidate();
    if (!candidate) {
      return '';
    }

    const count = messageCountLabel(candidate.recoveredMessageCount);
    const reason = reasonLabel(candidate.reason);
    return `${candidateTitle(candidate)} · ${count} · ${reason}`;
  });

  ngOnInit(): void {
    void this.store.refresh();
  }

  protected openRecoveryPicker(): void {
    this.openRecoveryRequested.emit();
  }

  protected dismissForSession(): void {
    this.dismissalStore.dismiss(this.candidateFingerprint());
  }
}
