#!/usr/bin/env -S npx tsx
/**
 * Replays the frozen Phase 0 codex-44-call-incident manifest through the real
 * context-evidence capture -> card -> working-set -> retrieval -> accuracy-gate
 * pipeline against a temporary (or explicitly supplied) user-data directory.
 *
 * Shares 100% of its orchestration with
 * src/main/context-evidence/context-evidence-incident-replay.spec.ts via
 * src/main/context-evidence/__fixtures__/incident-replay-harness.ts — this
 * script never forks its own copy of the replay logic.
 *
 * Usage:
 *   npx tsx scripts/replay-context-evidence-incident.ts
 *   npx tsx scripts/replay-context-evidence-incident.ts --user-data /tmp/my-replay-dir
 *
 * Exit code is 0 only when every invariant below holds; nonzero otherwise.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createIncidentReplayServices,
  readIncidentManifest,
  runIncidentReplay,
} from '../src/main/context-evidence/__fixtures__/incident-replay-harness';

interface CliArgs {
  userDataPath: string;
  keepUserData: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const userDataIndex = args.indexOf('--user-data');
  const explicit = userDataIndex >= 0 ? args[userDataIndex + 1] : undefined;
  return {
    userDataPath: explicit ?? join(tmpdir(), `aio-context-evidence-replay-${Date.now()}`),
    keepUserData: explicit !== undefined,
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const { userDataPath, keepUserData } = parseArgs();
  const failures: string[] = [];
  await mkdir(userDataPath, { recursive: true });
  console.log(`Replaying the frozen incident manifest against: ${userDataPath}`);

  const { manifest } = readIncidentManifest();
  const services = createIncidentReplayServices({ userDataPath });
  const result = await runIncidentReplay(services, manifest);

  console.log('\n== Character accounting ==');
  console.log(`Total calls:            ${result.totalCalls} (expected 44)`);
  console.log(`Externalizable results: ${result.externalizableCount} (expected 25)`);
  console.log(`Total result characters: ${result.totalResultCharacters} (expected 900532)`);
  if (result.totalCalls !== 44) failures.push('Total call count is not 44.');
  if (result.externalizableCount !== 25) failures.push('Externalizable count is not 25.');
  if (result.totalResultCharacters !== 900_532) failures.push('Total result characters are not 900532.');

  console.log('\n== Byte-for-byte capture integrity ==');
  const preserved = result.captured.filter((call) => call.roundTripEqual).length;
  console.log(`Round-trip-equal captures: ${preserved}/${result.captured.length}`);
  console.log(`Cards built for externalizable results: ${result.cardsBuilt} (expected 25)`);
  if (preserved !== result.captured.length) failures.push('Not every captured result round-tripped byte-for-byte.');
  if (result.cardsBuilt !== 25) failures.push('Card count does not match the externalizable result count.');

  console.log('\n== Governed vs. baseline cumulative input ==');
  console.log(`Baseline (ungoverned) cumulative input tokens: ${result.workingSet.baselineCumulativeInputTokens}`);
  console.log(`Governed cumulative input tokens (estimated):  ${result.workingSet.governedCumulativeInputTokens}`);
  console.log(`Per-request reduction:  ${pct(result.workingSet.reductionPercent)}`);
  console.log(`Cumulative reduction:   ${pct(result.workingSet.cumulativeReductionPercent)}`);
  console.log(
    '(Cumulative figures scale the frozen real-incident session total by the measured '
    + 'per-request reduction ratio from this replay; they are a modeled projection, not a '
    + 'literal re-simulation of the original 45 provider requests.)',
  );
  if (result.workingSet.reductionPercent < 0.6) failures.push('Per-request reduction is below the required 60%.');
  if (result.workingSet.cumulativeReductionPercent < 0.6) {
    failures.push('Cumulative reduction is below the required 60%.');
  }

  console.log('\n== Retrieval / verification ==');
  const verify = await services.retrievalService.verify({
    requester: { id: 'replay-cli', path: 'local', localSensitiveAuthorized: true, localRestrictedAuthorized: true },
    conversationId: result.conversationId,
    evidenceId: result.sampleCitation.evidenceId,
    startByte: result.sampleCitation.startByte,
    endByte: result.sampleCitation.endByte,
    contentDigest: result.sampleCitation.contentDigest,
  });
  console.log(`Sample citation verified: ${verify.verified}`);
  console.log(`Accuracy-gate verdict for the cited claim: ${result.accuracyGateVerdict}`);
  if (!verify.verified) failures.push('Sample citation failed authenticated verification.');
  if (result.accuracyGateVerdict !== 'pass') failures.push('Accuracy gate did not pass the cited claim.');

  console.log('\n== Restart idempotency ==');
  // Fresh key manager + blob store over the same directory, same
  // (persisted-in-production) ledger — simulates an app restart.
  const restarted = createIncidentReplayServices({ userDataPath, ledger: services.ledger });
  const reconciliation = await restarted.maintenanceService.reconcileStartup();
  const replay = await restarted.captureService.capture({
    captureKey: `incident:${manifest.generator.groups[0]!.category}:0`,
    conversationId: result.conversationId,
    provider: 'codex',
    turnRef: 'turn-0',
    toolCallRef: 'call-0',
    toolName: manifest.generator.groups[0]!.toolName,
    sourceKind: 'web',
    mimeType: 'text/plain',
    sensitivity: 'normal',
    provenanceTrust: 'runtime-authenticated',
    captureMode: 'post-retention',
    captureCompleteness: 'complete',
    content: new TextEncoder().encode(result.captured[0]!.result),
    observedBoundary: 'after-provider-retention',
  });
  console.log(`Startup reconciliation: ${JSON.stringify(reconciliation)}`);
  console.log(`Re-capture of the first call returns: ${replay.status} (expected duplicate)`);
  if (replay.status !== 'duplicate') failures.push('Replaying an already-captured call did not report duplicate.');

  console.log('\n== Deletion / revocation ==');
  const deletion = await services.deletionService.revokeConversation(result.conversationId);
  const postDeletionRead = await services.retrievalService.read({
    requester: { id: 'replay-cli', path: 'local', localSensitiveAuthorized: true, localRestrictedAuthorized: true },
    conversationId: result.conversationId,
    evidenceId: result.sampleCitation.evidenceId,
    startByte: 0,
    endByte: 4,
    tokenLimit: 512,
  }).then(() => 'readable' as const, (error: unknown) => (error as { code?: string }).code ?? 'denied');
  const janitor = await services.deletionService.runJanitor(1000);
  console.log(`Deletion queued ${deletion.queuedBlobCount} blob(s); revoked read outcome: ${postDeletionRead}`);
  console.log(`Janitor result: ${JSON.stringify(janitor)}`);
  if (postDeletionRead === 'readable') failures.push('Evidence remained readable after conversation deletion.');
  if (janitor.failed > 0) failures.push('Deletion janitor reported failed removals.');

  if (!keepUserData) {
    await rm(userDataPath, { recursive: true, force: true });
  } else {
    await writeFile(
      join(userDataPath, 'replay-summary.json'),
      JSON.stringify({ result, reconciliation, deletion, janitor }, null, 2),
    );
    await readFile(join(userDataPath, 'replay-summary.json'), 'utf8').catch(() => undefined);
  }

  console.log('\n== Result ==');
  if (failures.length > 0) {
    console.error(`FAILED (${failures.length} invariant violation(s)):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('PASSED: all replay invariants hold.');
  process.exitCode = 0;
}

main().catch((error: unknown) => {
  console.error('Replay crashed:', error);
  process.exitCode = 1;
});
