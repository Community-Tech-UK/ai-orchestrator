import { describe, expect, it, vi } from 'vitest';
import { runMicrosoft365Cli } from './microsoft365-cli';
import { dispatchMicrosoft365CliRpc, isMicrosoft365CliRpcMethod, type Microsoft365CliOperations } from './orchestrator-tools-rpc-microsoft365';
import { isAioMcpSubcommand } from './aio-mcp-dispatcher';

const ADDED = { name: 'm365-example', username: 'person@example.test', mailEnabled: true, agentsMayWrite: false };

function operations(overrides: Partial<Microsoft365CliOperations> = {}) {
  return {
    assertNameAvailable: vi.fn(),
    requestApproval: vi.fn(async () => true),
    add: vi.fn(async () => ADDED),
    ...overrides,
  };
}

describe('aio-mcp microsoft365', () => {
  it('is a registered subcommand', () => {
    expect(isAioMcpSubcommand('microsoft365')).toBe(true);
  });

  it.each([
    [['remove', 'm365-example']],
    [['add']],
    [['add', '--mail']],
    [['add', 'm365_example']],
    [['add', 'm365-example', '--write']],
  ])('rejects %j before making a request', async argv => {
    const call = vi.fn();
    await expect(runMicrosoft365Cli(argv, { client: { call }, stdout: vi.fn() })).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });

  it('asks the parent to add the account and reports read-only access plainly', async () => {
    const call = vi.fn(async () => ADDED);
    const stdout = vi.fn();
    await runMicrosoft365Cli(['add', 'm365-example', '--mail'], { client: { call }, stdout });
    expect(call).toHaveBeenCalledWith('orchestrator_tools.microsoft365.add', { name: 'm365-example', mailEnabled: true }, { signal: expect.any(AbortSignal) });
    expect(stdout.mock.calls[0][0]).toContain('Added m365-example for person@example.test with email');
    expect(stdout.mock.calls[0][0]).toContain('Agents can read only');
  });

  it('explains that a late sign-in still adds the connector when it stops waiting', async () => {
    const deadline = new AbortController();
    const call = vi.fn(async () => { deadline.abort(); throw new Error('orchestrator-tools RPC request cancelled'); });
    await expect(runMicrosoft365Cli(['add', 'm365-example'], { client: { call }, stdout: vi.fn(), deadline: deadline.signal }))
      .rejects.toThrow('the connector appears once he does');
  });

  it('passes other failures through unchanged', async () => {
    const call = vi.fn(async () => { throw new Error('The Microsoft 365 account was not added: the request was not approved in Harness.'); });
    await expect(runMicrosoft365Cli(['add', 'm365-example'], { client: { call }, stdout: vi.fn() })).rejects.toThrow('not approved');
  });

  it('prints JSON on request', async () => {
    const stdout = vi.fn();
    await runMicrosoft365Cli(['add', 'm365-example', '--json'], { client: { call: vi.fn(async () => ADDED) }, stdout });
    expect(JSON.parse(stdout.mock.calls[0][0])).toEqual(ADDED);
  });
});

describe('microsoft365 RPC', () => {
  it('recognises only its own method', () => {
    expect(isMicrosoft365CliRpcMethod('orchestrator_tools.microsoft365.add')).toBe(true);
    expect(isMicrosoft365CliRpcMethod('orchestrator_tools.pause.hold')).toBe(false);
  });

  it('checks the name, asks for approval, then signs in', async () => {
    const ops = operations();
    const result = await dispatchMicrosoft365CliRpc('orchestrator_tools.microsoft365.add', 'session-1', { name: 'm365-example', mailEnabled: true }, undefined, ops);
    expect(result).toEqual(ADDED);
    expect(ops.assertNameAvailable).toHaveBeenCalledWith('m365-example');
    expect(ops.requestApproval).toHaveBeenCalledWith('session-1', { name: 'm365-example', mailEnabled: true }, undefined);
    expect(ops.add).toHaveBeenCalledWith({ name: 'm365-example', mailEnabled: true });
    const order = (fn: unknown) => vi.mocked(fn as () => unknown).mock.invocationCallOrder[0];
    expect(order(ops.assertNameAvailable)).toBeLessThan(order(ops.requestApproval));
    expect(order(ops.requestApproval)).toBeLessThan(order(ops.add));
  });

  it('never signs in without approval', async () => {
    const ops = operations({ requestApproval: vi.fn(async () => false) });
    await expect(dispatchMicrosoft365CliRpc('orchestrator_tools.microsoft365.add', 'session-1', { name: 'm365-example', mailEnabled: false }, undefined, ops))
      .rejects.toThrow('not approved');
    expect(ops.add).not.toHaveBeenCalled();
  });

  it('does not ask for approval when the name is taken', async () => {
    const ops = operations({ assertNameAvailable: vi.fn(() => { throw new Error('A connector already uses that name.'); }) });
    await expect(dispatchMicrosoft365CliRpc('orchestrator_tools.microsoft365.add', 'session-1', { name: 'm365-example', mailEnabled: false }, undefined, ops))
      .rejects.toThrow('already uses that name');
    expect(ops.requestApproval).not.toHaveBeenCalled();
    expect(ops.add).not.toHaveBeenCalled();
  });

  it('does not sign in when the agent gives up during approval', async () => {
    const controller = new AbortController();
    const ops = operations({ requestApproval: vi.fn(async () => { controller.abort(); return true; }) });
    await expect(dispatchMicrosoft365CliRpc('orchestrator_tools.microsoft365.add', 'session-1', { name: 'm365-example', mailEnabled: false }, controller.signal, ops))
      .rejects.toThrow();
    expect(ops.add).not.toHaveBeenCalled();
  });

  it('rejects extra fields such as a write grant', async () => {
    const ops = operations();
    await expect(dispatchMicrosoft365CliRpc('orchestrator_tools.microsoft365.add', 'session-1', { name: 'm365-example', mailEnabled: false, agentsMayWrite: true }, undefined, ops))
      .rejects.toThrow();
    expect(ops.requestApproval).not.toHaveBeenCalled();
  });
});
