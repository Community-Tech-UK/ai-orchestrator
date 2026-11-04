export const PLAN_QUEUE_NOT_REACHED_LABEL = 'Not reached';

/** Cancellation never records a decision to skip an untouched document. */
export function isNotReachedItem(item: { state: string; detail: string | null }): boolean {
  return item.state === 'skipped' && (item.detail ?? '').startsWith('Run cancelled by');
}
