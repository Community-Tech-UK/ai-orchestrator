export interface DirtyOverlapInput {
  repoRoot: string;
  baseTip: string;
  integrationTip: string;
  overlaps: { path: string; status: string }[];
}
export type DirtyOverlapPreparation =
  | { ok: false; reason: string }
  | { ok: true; finish(): Promise<string[]>; undo(): Promise<void> };
export interface DirtyOverlapResolver { prepare(input: DirtyOverlapInput): Promise<DirtyOverlapPreparation> }
