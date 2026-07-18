import { describe, expect, it } from 'vitest';
import {
  PairBothCandidateSchema,
  RemoteNodeIssuePairingPayloadSchema,
  RemoteNodeRepairCommandPayloadSchema,
  RemoteNodeRepairDiagnosePayloadSchema,
  RemoteNodeRosterChangedEventSchema,
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

  it('validates pair-both candidates without accepting credentials', () => {
    const candidate = {
      id: 'pair-both:session:127.0.0.1:49152',
      product: 'Harness',
      protocol: 'aio-worker-pair-v1',
      protocolVersion: '1',
      pairingSessionId: 'session',
      friendlyName: 'James MacBook',
      namespace: 'default',
      port: 49152,
      coordinatorPublicKey: 'public-key-material',
      expiresAt: Date.now() + 60_000,
      host: '127.0.0.1',
      addresses: ['127.0.0.1'],
    };

    expect(PairBothCandidateSchema.safeParse(candidate).success).toBe(true);
    expect(PairBothCandidateSchema.safeParse({
      ...candidate,
      authToken: 'secret-token',
    }).success).toBe(false);
  });

  it('validates renderer-bound remote-node roster events', () => {
    const entry = {
      id: nodeId,
      name: 'Worker Mac',
      status: 'connected',
      address: '127.0.0.1',
      connected: true,
      supportedClis: ['claude'],
      hasBrowserRuntime: true,
      hasBrowserMcp: true,
      hasAndroidMcp: false,
      hasDocker: false,
      activeInstances: 1,
      maxConcurrentInstances: 4,
      workingDirectories: ['/tmp/project'],
      capabilities: {
        platform: 'darwin',
        arch: 'arm64',
        cpuCores: 10,
        totalMemoryMB: 32_768,
        availableMemoryMB: 16_384,
        supportedClis: ['claude'],
        hasBrowserRuntime: true,
        hasBrowserMcp: true,
        hasAndroidMcp: false,
        hasDocker: false,
        maxConcurrentInstances: 4,
        workingDirectories: ['/tmp/project'],
        browsableRoots: ['/tmp'],
        discoveredProjects: [],
      },
    };

    expect(RemoteNodeRosterChangedEventSchema.safeParse([entry]).success).toBe(true);
    expect(RemoteNodeRosterChangedEventSchema.safeParse([{ id: nodeId }]).success).toBe(false);
    expect(RemoteNodeRosterChangedEventSchema.safeParse(null).success).toBe(false);
  });
});
