import { z } from 'zod';
import { InstanceCreatePayloadSchema } from '@contracts/schemas/instance';
import type { NodePlacementPrefs } from '../../shared/types/worker-node.types';

const placement = InstanceCreatePayloadSchema.shape.nodePlacement.unwrap().extend({
  prefersCopilotAccountProfileId: z.string().max(200).optional(),
  prefersAccountProfile: z.object({ provider: z.enum(['claude', 'codex', 'opencode']), profileId: z.string().max(200) }).optional(),
});
/** Restore the validated constraint, never infer its absence from a retained folder list. */
export function normalizeRecoveryNodePlacement(value: unknown): NodePlacementPrefs | undefined {
  if (value === undefined) return undefined;
  const parsed = placement.safeParse(value);
  if (!parsed.success) throw new Error('Invalid recovery node placement.');
  return parsed.data;
}
