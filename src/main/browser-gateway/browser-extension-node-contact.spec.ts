import { describe, expect, it } from 'vitest';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import {
  classifyRemoteExtensionContact,
  isRemoteExtensionContactFresh,
  remoteExtensionContactSummary,
  type RemoteExtensionContactDeps,
} from './browser-extension-node-contact';

const MINUTE = 60_000;
const NOW = 200 * MINUTE;

function deps(options: {
  coordinatorPollAt?: number;
  relayContactAt?: number;
  connectedAt?: number;
  disconnect?: { at: number; reason: string };
  commandsAnswered?: boolean;
}): RemoteExtensionContactDeps {
  const node = {
    id: 'node-1',
    name: 'windows-pc',
    ...(options.connectedAt !== undefined ? { connectedAt: options.connectedAt } : {}),
    capabilities: { extensionRelay: { enabled: true, running: true, lastExtensionContactAt: options.relayContactAt } },
  } as unknown as WorkerNodeInfo;
  return {
    extensionContactState: {
      getLastExtensionContactAt: () => options.coordinatorPollAt,
      isExtensionContactFresh: () =>
        options.coordinatorPollAt !== undefined && NOW - options.coordinatorPollAt <= 90_000,
      describeExtensionContact: (nodeId) => ({ nodeId, silent: true }),
      getContactGapStats: () => ({ gapCount: 0, longestGapMs: 0 }),
      getLastDisconnect: () => options.disconnect,
    },
    workerNodeRegistry: { getNode: () => node },
    // Explicit so these cases never depend on the shared command-store singleton.
    deliveryHealth: () => ({
      commandsAnswered: options.commandsAnswered ?? true,
      consecutiveUnanswered: options.commandsAnswered === false ? 3 : 0,
    }),
    now: () => NOW,
  };
}

describe('remote extension contact clocks', () => {
  it('classifies fresh, relay_not_forwarding and silent from the two clocks', () => {
    expect(classifyRemoteExtensionContact({ coordinatorPollAt: NOW - 5_000, relayContactAt: NOW, now: NOW }).state)
      .toBe('fresh');
    expect(classifyRemoteExtensionContact({ coordinatorPollAt: NOW - 67 * MINUTE, relayContactAt: NOW - 15_000, now: NOW }))
      .toEqual({
        state: 'relay_not_forwarding',
        lastContactAt: NOW - 15_000,
        coordinatorPollAt: NOW - 67 * MINUTE,
        coordinatorPollAgeMs: 67 * MINUTE,
        relayContactAt: NOW - 15_000,
        relayContactAgeMs: 15_000,
      });
    expect(classifyRemoteExtensionContact({ coordinatorPollAt: NOW - 5 * MINUTE, relayContactAt: NOW - 4 * MINUTE, now: NOW }).state)
      .toBe('silent');
    expect(classifyRemoteExtensionContact({ now: NOW }).state).toBe('silent');
  });

  it('demotes a polling channel that answers nothing, without disturbing the other states', () => {
    // Both clocks fresh — the windows-pc 2026-09-20 incident. Delivery is fine;
    // execution is dead, and only the command window can see the difference.
    expect(classifyRemoteExtensionContact({
      coordinatorPollAt: NOW - 1_000,
      relayContactAt: NOW - 1_000,
      commandsAnswered: false,
      now: NOW,
    }).state).toBe('commands_unanswered');

    // Absent signal must not invent an incident.
    expect(classifyRemoteExtensionContact({ coordinatorPollAt: NOW - 1_000, now: NOW }).state)
      .toBe('fresh');
    expect(classifyRemoteExtensionContact({
      coordinatorPollAt: NOW - 1_000,
      commandsAnswered: true,
      now: NOW,
    }).state).toBe('fresh');

    // A stalled coordinator clock is still the worker's fault, not the
    // extension's: unanswered commands must not mask relay_not_forwarding.
    expect(classifyRemoteExtensionContact({
      coordinatorPollAt: NOW - 67 * MINUTE,
      relayContactAt: NOW - 15_000,
      commandsAnswered: false,
      now: NOW,
    }).state).toBe('relay_not_forwarding');

    // Nor silent.
    expect(classifyRemoteExtensionContact({
      coordinatorPollAt: NOW - 5 * MINUTE,
      relayContactAt: NOW - 4 * MINUTE,
      commandsAnswered: false,
      now: NOW,
    }).state).toBe('silent');
  });

  it('reports an unanswered channel as unusable and says why', () => {
    const incident = deps({
      coordinatorPollAt: NOW - 1_000,
      relayContactAt: NOW - 1_000,
      commandsAnswered: false,
    });
    // The regression this guards: a fast path on the raw contact clock returned
    // true here, so tabs on a dead channel were served as freshly confirmed.
    expect(isRemoteExtensionContactFresh('node-1', incident)).toBe(false);

    const summary = remoteExtensionContactSummary('node-1', incident);
    expect(summary).toContain('has not answered');
    expect(summary).toContain('browser.recover_extension');
  });

  it('does not treat a fresh relay clock as delivery freshness', () => {
    const incident = deps({ coordinatorPollAt: NOW - 67 * MINUTE, relayContactAt: NOW - 15_000 });
    expect(isRemoteExtensionContactFresh('node-1', incident)).toBe(false);
    expect(isRemoteExtensionContactFresh('node-1', deps({ coordinatorPollAt: NOW - 5_000 }))).toBe(true);
    // Just registered, no poll seen yet: still inside the grace window.
    expect(isRemoteExtensionContactFresh('node-1', deps({ relayContactAt: NOW - 1_000, connectedAt: NOW - 5_000 }))).toBe(true);
  });

  it('names both ages when polls reach the relay but not the coordinator', () => {
    expect(remoteExtensionContactSummary('node-1', deps({
      coordinatorPollAt: NOW - 67 * MINUTE,
      relayContactAt: NOW - 15_000,
    }))).toBe(
      'extension polled the relay 15s ago; the coordinator has not received a poll for 67m'
      + ' (worker is not forwarding polls; browser.recover_extension resets the node connection)',
    );
    expect(remoteExtensionContactSummary('node-1', deps({
      relayContactAt: NOW - 15_000,
      connectedAt: NOW - 10 * MINUTE,
    }))).toContain('the coordinator has not received a poll since the node registered');
  });

  it('keeps the existing wording for healthy and silent channels', () => {
    expect(remoteExtensionContactSummary('node-1', deps({ coordinatorPollAt: NOW - 42_000 })))
      .toBe('extension last contacted 42s ago');
    expect(remoteExtensionContactSummary('node-1', deps({
      disconnect: { at: NOW - 3_000, reason: 'native_host_stdin_eof' },
    }))).toBe('no extension contact recorded; channel disconnected 3s ago (native_host_stdin_eof)');
  });
});
