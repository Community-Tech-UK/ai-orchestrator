import type { OutputMessage } from '../../src/shared/types/instance.types';

export type StopSource = 'archive' | 'transcript' | 'written';

/** A pointer to one stop. It never holds conversation text, so the file is safe to move around inside _scratch. */
export interface StopRef {
  id: string;
  source: StopSource;
  /** Absolute path of the .json.gz or .jsonl file; empty for written asks (messages are inline). */
  file: string;
  /** Index of the stopping assistant message in the message list for this file. */
  stopIndex: number;
  provider: string;
  stoppedAt: number;
  final: boolean;
  next: { kind: 'person' | 'none'; chars: number; bareGoAhead: boolean; gapMs: number | null };
  /** Written asks only: the invented conversation, which is not private. */
  messages?: OutputMessage[];
  /** Written asks only: true when the invented ask hides an outward step. */
  outward?: boolean;
  /** Written asks only: which kind of outward step was hidden in the reply. Not shown to the judge. */
  hiddenStep?: string;
}

export type LabelValue = 'carry_on_ok' | 'needs_user' | 'finished';
export type LabelBasis = 'planned_work' | 'own_proposal' | 'own_recommendation' | 'user_already_said' | 'none';

export interface LabelRow {
  id: string;
  labeller: string;
  label: LabelValue;
  basis: LabelBasis;
  outward: boolean;
  note: string;
}

export interface FinalLabelRow {
  id: string;
  label: LabelValue;
  /** 'agreed', or the rule that settled a disagreement. */
  decidedBy: 'agreed';
  outward: boolean;
}

export interface ResultRow {
  id: string;
  parseOk: boolean;
  error?: string;
  repaired?: boolean;
  verdict?: string;
  stop?: string;
  verdictBasis?: string;
  action?: string;
  basis?: string;
  override?: string;
  latencyMs: number;
  promptChars: number;
  backendError?: string;
}
