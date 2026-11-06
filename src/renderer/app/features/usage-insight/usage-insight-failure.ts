/**
 * Words for "Harness couldn't read your usage".
 *
 * Whatever went wrong while asking for the report is evidence, not copy: a failed read
 * can carry file paths and account names. The sentences shown come from the shared error
 * presenter; the raw text travels beside them in `rawDetail` and belongs only in a
 * closed Details block.
 */

import { presentError } from '../../../../shared/present-error';

export interface UsageFailure {
  headline: string;
  /** What the reader can do about it ("What to do: ..."). */
  whatToDo: string;
  /** Raw text from the system. Show it only inside a closed Details block. */
  rawDetail: string;
}

/**
 * The shared presenter's wording for an unrecognised failure talks about a chat message
 * being kept, which this card doesn't have. Recognised kinds use the shared wording as it is.
 */
const UNREADABLE: Pick<UsageFailure, 'headline' | 'whatToDo'> = {
  headline: "Harness couldn't work out where your usage went.",
  whatToDo: 'What to do: Check Details, then try again.',
};

export function presentUsageFailure(failure: unknown): UsageFailure {
  // Plain text from the main process is a description, never an error code.
  const source = typeof failure === 'string' ? { message: failure } : failure;
  const presented = presentError(source, { provider: 'claude' });
  return presented.category === 'unknown'
    ? { ...UNREADABLE, rawDetail: presented.rawDetail }
    : { headline: presented.headline, whatToDo: presented.whatToDo, rawDetail: presented.rawDetail };
}
