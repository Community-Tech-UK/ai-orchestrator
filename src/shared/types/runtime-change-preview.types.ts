import type { RuntimeChangeCostNote } from '../utils/runtime-change-cost';

/** What the main process answers when asked what a runtime change would cost. */
export interface RuntimeChangePreview {
  /** Null when the change costs nothing worth saying. */
  note: RuntimeChangeCostNote | null;
}
