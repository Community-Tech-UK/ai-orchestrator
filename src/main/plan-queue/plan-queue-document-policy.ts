/**
 * A plan this big would compact over and over under the 272K machine-work window cap, so the queue marks the
 * session and Codex keeps its own window for it (see `planQueueLargeDocument`).
 */
import { statSync } from 'node:fs';
export function isLargeQueueDocument(documentPath: string): boolean {
  try { return statSync(documentPath).size > 100_000; } catch { return false; }
}
