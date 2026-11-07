export interface DirtyOverlapInput {
  repoRoot: string;
  baseTip: string;
  integrationTip: string;
  overlaps: { path: string; status: string }[];
}
export type DirtyOverlapPreparation =
  /** `keptEdits`: the refusal came after resetting a file, so `reason` says where the edit is and someone must act now. */
  | { ok: false; reason: string; keptEdits?: boolean }
  | { ok: true; finish(): Promise<string[]>; undo(): Promise<void> };
export interface DirtyOverlapResolver { prepare(input: DirtyOverlapInput): Promise<DirtyOverlapPreparation> }
