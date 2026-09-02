import type { DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { ActivatedRoute } from '@angular/router';
import type { BrowserApprovalRequest } from '@contracts/types/browser';
import type { BrowserPageView } from './browser-page-view.utils';

interface WritableValue<T> { set(value: T): void }
const MAX_FOCUS_ATTEMPTS = 8;

export class BrowserApprovalFocus {
  private requestId: string | null = null;
  private attempts = 0;
  private completed = false;

  constructor(private readonly host: HTMLElement) {}

  reset(): void {
    this.requestId = null;
    this.attempts = 0;
    this.completed = false;
  }

  apply(requestId: string | null): void {
    if (!requestId) return;
    if (requestId !== this.requestId) {
      this.requestId = requestId;
      this.attempts = 0;
      this.completed = false;
    }
    if (this.completed || this.attempts >= MAX_FOCUS_ATTEMPTS) return;
    this.attempts += 1;
    const expectedId = `browser-approval-${requestId}`;
    const card = Array.from(this.host.querySelectorAll<HTMLElement>('[id]'))
      .find((element) => element.id === expectedId);
    if (!card) return;
    card.focus();
    this.completed = true;
  }
}

export function bindBrowserApprovalDeepLink(input: {
  route: ActivatedRoute | null;
  destroyRef: DestroyRef;
  activeView: WritableValue<BrowserPageView>;
  focusedRequestId: WritableValue<string | null>;
  focus: BrowserApprovalFocus;
  refresh: () => void;
}): void {
  input.route?.queryParamMap.pipe(takeUntilDestroyed(input.destroyRef)).subscribe((params) => {
    if (params.get('view') !== 'permissions') return;
    input.activeView.set('permissions');
    input.focusedRequestId.set(params.get('requestId'));
    input.focus.reset();
    input.refresh();
  });
}

export function browserApprovalExactOnly(approval: BrowserApprovalRequest): boolean {
  return approval.actionClass === 'credential' || approval.actionClass === 'unknown';
}

export function browserApprovalPosition(
  approval: BrowserApprovalRequest,
  approvals: BrowserApprovalRequest[],
): number {
  return approvals.findIndex((item) => item.requestId === approval.requestId) + 1;
}

export function shortBrowserApprovalId(approval: BrowserApprovalRequest): string {
  return approval.requestId.length <= 12 ? approval.requestId : approval.requestId.slice(0, 8);
}

export function browserApprovalReceivedAt(approval: BrowserApprovalRequest): string {
  return new Date(approval.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
