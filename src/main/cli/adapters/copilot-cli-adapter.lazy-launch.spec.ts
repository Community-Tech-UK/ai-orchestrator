/**
 * Regression cover for the Copilot launch-discovery cost.
 *
 * `getDefaultCopilotCliLaunch()` runs up to three synchronous child processes
 * (`which copilot`, `which gh`, and a `gh copilot --help` probe bounded at
 * 5000ms). It used to run inside the adapter constructor, so on any machine
 * without the standalone `copilot` binary — every CI runner — merely
 * constructing an adapter blocked for as long as that probe took, and blocked
 * the Electron main thread in production. It was measured at 5007ms, which
 * timed out the first test in each Copilot adapter spec file.
 *
 * The contract these tests lock in: construction performs no discovery, and
 * discovery happens exactly once, at the point a child process is actually
 * spawned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const launchMock = vi.hoisted(() =>
  vi.fn(() => ({
    command: '/usr/local/bin/copilot',
    argsPrefix: ['copilot', '--'],
    displayCommand: 'copilot',
  })),
);

vi.mock('../copilot-cli-launch', () => ({
  getDefaultCopilotCliLaunch: launchMock,
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { BaseCliAdapter } from './base-cli-adapter';
import { CopilotCliAdapter } from './copilot-cli-adapter';

/** Reach the protected `spawnProcess` without spawning anything real. */
type SpawnProcessCallable = { spawnProcess(args: string[]): unknown };

describe('CopilotCliAdapter launch discovery', () => {
  beforeEach(() => {
    launchMock.mockClear();
  });

  // The prototype spies below are on the SHARED base class. A failed assertion
  // would skip a manual restore and leak the stub into the next test, so the
  // teardown owns restoration rather than each test's last line.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not discover the CLI while constructing the adapter', () => {
    const adapter = new CopilotCliAdapter();

    expect(launchMock).not.toHaveBeenCalled();
    // The placeholder must stay inert: no argsPrefix leaks into a turn before
    // discovery has actually chosen `gh copilot --` over the bare binary.
    expect(adapter.getName()).toBe('copilot-cli');
  });

  it('does not discover the CLI while parsing output', () => {
    const adapter = new CopilotCliAdapter();

    const response = adapter.parseOutput('{"type":"assistant.message","data":{"content":"hi"}}\n');

    expect(response.content).toBe('hi');
    expect(launchMock).not.toHaveBeenCalled();
  });

  it('discovers the CLI once, on the first spawned child process', () => {
    const baseSpawn = vi
      .spyOn(BaseCliAdapter.prototype as unknown as SpawnProcessCallable, 'spawnProcess')
      .mockReturnValue({} as never);

    const adapter = new CopilotCliAdapter();
    const callable = adapter as unknown as SpawnProcessCallable;

    callable.spawnProcess(['--version']);
    expect(launchMock).toHaveBeenCalledTimes(1);

    callable.spawnProcess(['-p', 'hello']);
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(baseSpawn).toHaveBeenCalledTimes(2);
  });

  it('applies the discovered command and argsPrefix before the child is spawned', () => {
    let commandAtSpawn: string | undefined;
    let argsAtSpawn: string[] | undefined;

    const baseSpawn = vi
      .spyOn(BaseCliAdapter.prototype as unknown as SpawnProcessCallable, 'spawnProcess')
      .mockImplementation(function (this: { config: { command: string; args?: string[] } }) {
        commandAtSpawn = this.config.command;
        argsAtSpawn = this.config.args;
        return {} as never;
      });

    const adapter = new CopilotCliAdapter();
    (adapter as unknown as SpawnProcessCallable).spawnProcess(['--version']);

    expect(commandAtSpawn).toBe('/usr/local/bin/copilot');
    expect(argsAtSpawn).toEqual(['copilot', '--']);
    expect(baseSpawn).toHaveBeenCalledTimes(1);
  });
});
