import { describe, expect, it } from 'vitest';
import {
  RemoteNodeIssuePairingPayloadSchema,
  RemoteNodeRepairCommandPayloadSchema,
  RemoteNodeRepairDiagnosePayloadSchema,
} from '../remote-node.schemas';

describe('remote-node.schemas', () => {
  const nodeId = '11111111-1111-4111-8111-111111111111';

  it('keeps quick-pairing payload public-only', () => {
    expect(RemoteNodeIssuePairingPayloadSchema.safeParse({
      label: 'Laptop',
      ttlMs: 60_000,
      purpose: 'repair',
      allowedNodeId: nodeId,
    }).success).toBe(false);
  });

  it('validates repair diagnose payloads', () => {
    expect(RemoteNodeRepairDiagnosePayloadSchema.parse({ nodeId })).toEqual({ nodeId });
    expect(RemoteNodeRepairDiagnosePayloadSchema.safeParse({ nodeId: 'not-a-uuid' }).success).toBe(false);
  });

  it('requires explicit Windows confirmation shape when operatorConfirmedPlatform is set', () => {
    expect(RemoteNodeRepairCommandPayloadSchema.safeParse({
      nodeId,
      platform: 'win32',
      operatorConfirmedPlatform: true,
    }).success).toBe(true);

    expect(RemoteNodeRepairCommandPayloadSchema.safeParse({
      nodeId,
      operatorConfirmedPlatform: true,
    }).success).toBe(false);
  });
});
