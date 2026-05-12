import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildLoopControlEnv,
  commitImportedIntent,
  importLoopTerminalIntents,
  listArchivedImportedIntents,
  listArchivedImportedIntentsByLoop,
  LOOP_CONTROL_MAX_JSON_BYTES,
  prepareLoopControl,
  writeLoopControlFile,
  type LoopControlRuntime,
} from './loop-control';
import { runLoopControlCli } from './loop-control-cli';

let workspace: string;
let runtime: LoopControlRuntime;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-control-test-'));
  runtime = await prepareLoopControl(workspace, 'loop-test');
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('loop-control CLI contract', () => {
  it('records the current iteration from control.json rather than from immutable env', async () => {
    await writeLoopControlFile(runtime, 3);
    const stderr: string[] = [];
    const stdout: string[] = [];

    const code = await runLoopControlCli(
      ['node', 'aio-loop-control', 'complete', '--summary', 'implementation complete', '--evidence', 'test:npm test=passed'],
      buildLoopControlEnv(runtime),
      {
        stdout: { write: (chunk: string) => { stdout.push(chunk); return true; } },
        stderr: { write: (chunk: string) => { stderr.push(chunk); return true; } },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join('')).toContain('iteration 3');
    const imported = await importLoopTerminalIntents(runtime, {
      maxIterationSeq: 3,
      exactIterationSeq: 3,
      terminalEligible: true,
    });
    expect(imported.rejected).toEqual([]);
    expect(imported.accepted).toHaveLength(1);
    expect(imported.accepted[0]).toMatchObject({
      loopRunId: 'loop-test',
      iterationSeq: 3,
      kind: 'complete',
      summary: 'implementation complete',
      source: 'loop-control-cli',
      status: 'pending',
    });
    expect(imported.accepted[0]?.evidence).toEqual([
      { kind: 'test', label: 'npm test', value: 'passed' },
    ]);
  });

  it('rejects a control file path that resolves outside the workspace control directory', async () => {
    const outside = path.join(os.tmpdir(), `loop-control-outside-${Date.now()}.json`);
    fs.writeFileSync(outside, JSON.stringify({
      version: 1,
      promptVersion: 1,
      loopRunId: runtime.loopRunId,
      workspaceCwd: runtime.workspaceCwd,
      controlDir: runtime.controlDir,
      intentsDir: runtime.intentsDir,
      currentIterationSeq: 0,
      secret: runtime.secret,
      cliPath: runtime.cliPath,
      updatedAt: Date.now(),
    }));
    const stderr: string[] = [];

    const code = await runLoopControlCli(
      ['node', 'aio-loop-control', 'complete', '--summary', 'done'],
      {
        ...buildLoopControlEnv(runtime),
        ORCHESTRATOR_LOOP_CONTROL_FILE: outside,
      },
      {
        stdout: { write: () => true },
        stderr: { write: (chunk: string) => { stderr.push(chunk); return true; } },
      },
    );

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('outside the expected workspace control directory');
    fs.rmSync(outside, { force: true });
  });

  it('rejects oversized intent JSON before parse/import', async () => {
    fs.writeFileSync(
      path.join(runtime.intentsDir, 'oversized.json'),
      `${'{'}${' '.repeat(LOOP_CONTROL_MAX_JSON_BYTES + 1)}`,
    );

    const imported = await importLoopTerminalIntents(runtime, {
      maxIterationSeq: 0,
      exactIterationSeq: 0,
      terminalEligible: true,
    });

    expect(imported.accepted).toEqual([]);
    expect(imported.rejected).toHaveLength(1);
    expect(imported.rejected[0]?.reason).toContain('byte cap');
  });

  it('leaves accepted intent files in intents/ until the caller commits them (NB2 persist-before-archive)', async () => {
    await writeLoopControlFile(runtime, 1);
    const code = await runLoopControlCli(
      ['node', 'aio-loop-control', 'complete', '--summary', 'done'],
      buildLoopControlEnv(runtime),
      silentIo(),
    );
    expect(code).toBe(0);

    const beforeImport = fs.readdirSync(runtime.intentsDir).filter((name) => name.endsWith('.json'));
    expect(beforeImport).toHaveLength(1);

    const imported = await importLoopTerminalIntents(runtime, {
      maxIterationSeq: 1,
      exactIterationSeq: 1,
      terminalEligible: true,
    });
    expect(imported.accepted).toHaveLength(1);
    expect(imported.rejected).toEqual([]);

    // Crash window: imported but caller has NOT yet called
    // commitImportedIntent. The file must still be in `intents/`, the
    // archive dir must not yet exist for this file.
    const afterImport = fs.readdirSync(runtime.intentsDir).filter((name) => name.endsWith('.json'));
    expect(afterImport).toEqual(beforeImport);
    const archiveDir = path.join(runtime.controlDir, 'imported');
    expect(fs.existsSync(archiveDir)).toBe(false);

    // Now the caller commits — file moves out of intents/, archive
    // directory created with the source file inside.
    const accepted = imported.accepted[0]!;
    await commitImportedIntent(runtime, accepted.filePath!);
    expect(fs.readdirSync(runtime.intentsDir).filter((name) => name.endsWith('.json'))).toEqual([]);
    expect(fs.readdirSync(archiveDir).filter((name) => name.endsWith('.json'))).toHaveLength(1);
  });

  it('lists archived imported intents for orphan reconciliation', async () => {
    await writeLoopControlFile(runtime, 2);
    await runLoopControlCli(
      ['node', 'aio-loop-control', 'complete', '--summary', 'archived intent'],
      buildLoopControlEnv(runtime),
      silentIo(),
    );

    const imported = await importLoopTerminalIntents(runtime, {
      maxIterationSeq: 2,
      exactIterationSeq: 2,
      terminalEligible: true,
    });
    const accepted = imported.accepted[0]!;
    await commitImportedIntent(runtime, accepted.filePath!);

    // listArchivedImportedIntents returns the same intent the caller
    // would normally have persisted — the reconciler uses this to
    // recover orphans after a crash between archive and DB write.
    const archived = await listArchivedImportedIntents(runtime);
    expect(archived).toHaveLength(1);
    expect(archived[0]?.id).toBe(accepted.id);
    expect(archived[0]?.source).toBe('imported-file');
    expect(archived[0]?.summary).toBe('archived intent');

    // Boot-time variant (no in-memory runtime required) returns the same data.
    const archivedByLoop = await listArchivedImportedIntentsByLoop(workspace, runtime.loopRunId);
    expect(archivedByLoop.map((i) => i.id)).toEqual([accepted.id]);
  });

  it('returns an empty list when imported/ does not exist (no orphans)', async () => {
    const empty = await listArchivedImportedIntentsByLoop(workspace, runtime.loopRunId);
    expect(empty).toEqual([]);
  });
});

function silentIo() {
  return {
    stdout: { write: () => true },
    stderr: { write: () => true },
  };
}
