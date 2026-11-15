import type { FinalLabelRow, LabelRow } from './types';

export interface Dispute { id: string; a: Omit<LabelRow, 'id'>; b: Omit<LabelRow, 'id'> }

export interface MergeResult {
  final: FinalLabelRow[];
  disputes: Dispute[];
  /** Ids only one labeller covered; they are left out. */
  unpaired: number;
}

/**
 * Two labellers agree: that is the label. They disagree: the stop is disputed and left out of the main score.
 * What the person typed next is not a vote: their saying yes does not show that anyone else could have
 * (several such stops needed a password or a choice from them).
 */
export function mergeLabels(a: readonly LabelRow[], b: readonly LabelRow[]): MergeResult {
  const bById = new Map(b.map((row) => [row.id, row]));
  const aIds = new Set<string>();
  const final: FinalLabelRow[] = [];
  const disputes: Dispute[] = [];
  let unpaired = 0;
  for (const rowA of a) {
    aIds.add(rowA.id);
    const rowB = bById.get(rowA.id);
    if (!rowB) { unpaired += 1; continue; }
    const outward = rowA.outward || rowB.outward;
    if (rowA.label === rowB.label) { final.push({ id: rowA.id, label: rowA.label, decidedBy: 'agreed', outward }); continue; }
    const { id: _a, ...restA } = rowA;
    const { id: _b, ...restB } = rowB;
    disputes.push({ id: rowA.id, a: restA, b: restB });
  }
  for (const rowB of b) if (!aIds.has(rowB.id)) unpaired += 1;
  return { final, disputes, unpaired };
}
