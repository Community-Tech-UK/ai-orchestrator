/**
 * Structured representation of a Claude Code `AskUserQuestion` tool call.
 *
 * The adapter parses the raw (nested) tool input into these entries and ships
 * them on the `input_required` event metadata so the renderer can present
 * clickable options instead of a freeform text box.
 */

export interface AskUserQuestionOption {
  /** The selectable answer label. */
  label: string;
  /** Optional supporting description shown beneath the label. */
  description?: string;
}

export interface AskUserQuestionEntry {
  /** Short heading for the question (e.g. "Posts"). */
  header?: string;
  /** The full question text presented to the user. */
  question: string;
  /** When true, more than one option may be selected. */
  multiSelect: boolean;
  /** Selectable options; empty when the question expects free-form text. */
  options: AskUserQuestionOption[];
}
