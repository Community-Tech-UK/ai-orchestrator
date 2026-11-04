import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  assertNameAvailable: vi.fn(),
  add: vi.fn(),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('./microsoft365-connector-add', () => ({
  assertMicrosoft365ConnectorNameAvailable: state.assertNameAvailable,
  addMicrosoft365Connector: state.add,
}));

import { PermissionRegistry, getPermissionRegistry } from '../orchestration/permission-registry';
import type { PermissionDecision, PermissionRequest } from '../../shared/types/permission-registry.types';
import { dispatchMicrosoft365CliRpc } from './orchestrator-tools-rpc-microsoft365';

const METHOD = 'orchestrator_tools.microsoft365.add';
const PAYLOAD = { name: 'm365-example', mailEnabled: true };
const ADDED = { name: 'm365-example', username: 'person@example.test', mailEnabled: true, agentsMayWrite: false };

/** Answers the next approval request the way the given decision source would. */
function answerNextRequest(granted: boolean, decidedBy: PermissionDecision['decidedBy']): Promise<PermissionRequest> {
  return new Promise((resolve) => {
    getPermissionRegistry().once('permission:requested', (request: PermissionRequest) => {
      getPermissionRegistry().resolve(request.id, granted, decidedBy);
      resolve(request);
    });
  });
}

describe('microsoft365 RPC approval through the real approval queue', () => {
  beforeEach(() => {
    PermissionRegistry._resetForTesting();
    state.assertNameAvailable.mockReset();
    state.add.mockReset().mockResolvedValue(ADDED);
  });
  afterEach(() => { PermissionRegistry._resetForTesting(); });

  it('adds the account after James approves, describing the request plainly', async () => {
    const asked = answerNextRequest(true, 'user');
    await expect(dispatchMicrosoft365CliRpc(METHOD, 'session-1', PAYLOAD)).resolves.toEqual(ADDED);
    const request = await asked;
    expect(request).toMatchObject({ instanceId: 'session-1', action: 'microsoft365_add_account', details: { connectorName: 'm365-example', mailEnabled: true } });
    expect(request.description).toContain('m365-example, with email');
    expect(state.add).toHaveBeenCalledWith(PAYLOAD);
  });

  it.each<[boolean, PermissionDecision['decidedBy']]>([
    [true, 'auto_approve'],
    [false, 'user'],
    [false, 'timeout'],
    [false, 'parent_deny'],
    [false, 'cancelled'],
  ])('does not sign in when the decision is granted=%s by %s', async (granted, decidedBy) => {
    void answerNextRequest(granted, decidedBy);
    await expect(dispatchMicrosoft365CliRpc(METHOD, 'session-1', PAYLOAD)).rejects.toThrow('not approved');
    expect(state.add).not.toHaveBeenCalled();
  });

  it('withdraws the pending request when the agent disconnects', async () => {
    const controller = new AbortController();
    getPermissionRegistry().once('permission:requested', () => { controller.abort(); });
    await expect(dispatchMicrosoft365CliRpc(METHOD, 'session-1', PAYLOAD, controller.signal)).rejects.toThrow();
    expect(getPermissionRegistry().getPendingCount()).toBe(0);
    expect(state.add).not.toHaveBeenCalled();
  });

  it('does not ask James when the name is already taken', async () => {
    state.assertNameAvailable.mockImplementation(() => { throw new Error('A connector already uses that name.'); });
    const requested = vi.fn();
    getPermissionRegistry().on('permission:requested', requested);
    await expect(dispatchMicrosoft365CliRpc(METHOD, 'session-1', PAYLOAD)).rejects.toThrow('already uses that name');
    expect(requested).not.toHaveBeenCalled();
  });
});
