#!/usr/bin/env node
/**
 * cli-fixture-runner.mjs — a tiny, deterministic out-of-process "CLI" used by
 * {@link OutOfProcessFixtureAdapter} to exercise the REAL subprocess spawn +
 * stdout-stream + parse pipeline in `BaseCliAdapter` (backlog A6: the
 * out-of-process tail of the scripted-mock-adapter work; the in-process
 * `ScriptedCliAdapter` covers event consumers but never actually spawns).
 *
 * It is intentionally dependency-free (Node builtins only) and ESM (.mjs) so it
 * runs identically under `process.execPath` regardless of the repo's module
 * type. Behaviour is driven entirely by a scenario JSON file whose path is
 * argv[2], so the spawning test controls every byte and exit code:
 *
 *   {
 *     "steps": [
 *       { "stream": "stdout", "data": "{...ndjson...}\n", "delayMs": 0 },
 *       { "stream": "stderr", "data": "a warning\n" }
 *     ],
 *     "exitCode": 0
 *   }
 *
 * Each step is written to the named stream after awaiting `delayMs` (default 0),
 * then the process exits with `exitCode` (default 0). No scenario / unreadable
 * scenario → exit 2 with a diagnostic on stderr.
 */

import { readFileSync } from 'node:fs';

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function writeStream(stream, data) {
  return new Promise((resolve) => {
    const target = stream === 'stderr' ? process.stderr : process.stdout;
    // Honour backpressure so large payloads stream in multiple chunks (which is
    // exactly the line-buffering condition the adapter must handle correctly).
    if (target.write(data)) {
      resolve();
    } else {
      target.once('drain', resolve);
    }
  });
}

async function main() {
  const scenarioPath = process.argv[2];
  if (!scenarioPath) {
    process.stderr.write('cli-fixture-runner: missing scenario path argument\n');
    process.exit(2);
    return;
  }

  let scenario;
  try {
    scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
  } catch (err) {
    process.stderr.write(`cli-fixture-runner: cannot read scenario: ${String(err)}\n`);
    process.exit(2);
    return;
  }

  const steps = Array.isArray(scenario.steps) ? scenario.steps : [];
  for (const step of steps) {
    await sleep(typeof step.delayMs === 'number' ? step.delayMs : 0);
    await writeStream(step.stream === 'stderr' ? 'stderr' : 'stdout', String(step.data ?? ''));
  }

  const exitCode = Number.isInteger(scenario.exitCode) ? scenario.exitCode : 0;
  process.exit(exitCode);
}

main().catch((err) => {
  process.stderr.write(`cli-fixture-runner: fatal ${String(err)}\n`);
  process.exit(3);
});
