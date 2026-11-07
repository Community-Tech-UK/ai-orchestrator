import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { readConfig, type CliOptions } from './config';
import { log } from './cli-util';
import { appendSpeedGateRecord, applySpeedGate, measureSpeed, REAL_PROMPT_MIN_TOKENS, speedGateLogPath } from './speed-gate';
import { renderSelfTest, runSelfTest } from './self-test';
import type { TaskDefinition } from './types';

/**
 * Side tools of the plan/execute benchmark CLI (`speed-gate`, `self-test`,
 * `mine`, `verify-task`), split out of runner.ts so the run/plan/report
 * pipeline stays readable and under the repo's file-size ratchet.
 */

export async function cmdSpeedGate(options: CliOptions): Promise<number> {
  const config = readConfig(options.configPath);
  const endpoints = config.localArms;
  if (endpoints.length === 0) {
    log('no local endpoints configured in runner.config.json (localArms)');
    return 1;
  }
  let gateExit = 0;
  let promptText: string | undefined;
  let promptPath: string | undefined;
  if (options.promptFile) {
    promptPath = resolve(options.promptFile);
    promptText = readFileSync(promptPath, 'utf8');
    log(`probe prompt: ${promptText.length} chars from ${promptPath}`);
  }
  for (const endpoint of endpoints) {
    log(`probing ${endpoint.modelKey} at ${endpoint.baseUrl}`);
    const apiKey = process.env[endpoint.apiKeyEnv] ?? 'local-benchmark-key';
    let sample;
    try {
      sample = await measureSpeed({ endpoint, apiKey, promptText });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`- probe failed for ${endpoint.modelKey}: ${message}`);
      if (endpoint.modelKey === 'qwen3.8-flash-next') gateExit = 1;
      continue;
    }
    log(
      `prompt ${sample.promptTokensPerSec.toFixed(0)} tok/s (measured ${sample.measuredPromptSpeed}, source ${sample.source ?? 'unknown'}), `
      + `write ${sample.writeTokensPerSec.toFixed(1)} tok/s`,
    );
    // The C2 gate decides only on a real 30k-token prompt (the plan's workload).
    // applySpeedGate returns null — withholding the verdict — when the measured
    // prompt is smaller: a short --prompt-file must never bank a keep/drop.
    const gateRequested = endpoint.modelKey === 'qwen3.8-flash-next' && promptText !== undefined;
    const decision = gateRequested ? applySpeedGate(sample) : null;
    const logPath = speedGateLogPath(config.resultsRoot);
    appendSpeedGateRecord(logPath, {
      modelKey: endpoint.modelKey,
      measuredAt: new Date().toISOString(),
      sample,
      decision,
      note: gateRequested
        ? decision
          ? `real-prompt probe (${promptPath ?? ''})`
          : `real-prompt probe (${promptPath ?? ''}) — C2 gate WITHHELD: measured prompt ${sample.promptTokens} tokens is below the real ${REAL_PROMPT_MIN_TOKENS}-token protocol size`
        : promptText !== undefined
          ? `real-prompt probe (${promptPath ?? ''}) — setup reading (the keep/drop gate is for qwen3.8-flash-next only)`
          : 'synthetic probe prompt (setup reading; the C2 gate requires a real agent prompt via --prompt-file)',
    });
    log(`recorded to ${logPath}`);
    if (decision) {
      for (const reason of decision.reasons) log(`- ${reason}`);
      log(decision.keepC2 ? 'SPEED GATE PASS — keep C2' : 'SPEED GATE FAIL — drop C2');
      if (!decision.keepC2) gateExit = 1;
    } else if (gateRequested) {
      log(`- SPEED GATE WITHHELD: measured prompt ${sample.promptTokens} tokens; the C2 gate decides only on a real ${REAL_PROMPT_MIN_TOKENS}-token prompt — nothing keep/drop was banked`);
      gateExit = 1;
    } else if (endpoint.modelKey === 'qwen3.8-flash-next') {
      log('- C2 gate decision withheld: probe used the synthetic prompt; pass --prompt-file for the real-prompt gate');
    } else {
      log('- measurement recorded; the 300/15 tok/s gate is for C2 (Flash-Next) only');
    }
  }
  return gateExit;
}

export async function cmdSelfTest(options: CliOptions): Promise<number> {
  const config = readConfig(options.configPath);
  const result = await runSelfTest(config.workRoot);
  log(renderSelfTest(result));
  return result.passed ? 0 : 1;
}

export async function cmdMine(options: CliOptions): Promise<number> {
  const { listCandidates, draftPrompt, leakageCheck } = await import('./mine-tasks');
  const config = readConfig(options.configPath);
  const repoId = options.repoId;
  const repoPath = repoId ? config.repoPaths[repoId] : undefined;
  if (!repoId || !repoPath) {
    log(`usage: mine --repo-id <id> [--since YYYY-MM-DD] [--limit N]  (known repos: ${Object.keys(config.repoPaths).join(', ')})`);
    return 1;
  }
  const candidates = listCandidates({
    repoPath,
    repoId,
    since: options.since,
    limit: options.limit ?? 40,
  });
  const outDir = join(resolve(config.resultsRoot), 'mining');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `candidates-${repoId}.json`);
  const enriched = candidates.map((candidate) => {
    const prompt = draftPrompt(candidate);
    return { ...candidate, draftPrompt: prompt, leakageIssues: leakageCheck(prompt, candidate) };
  });
  writeFileSync(outFile, JSON.stringify(enriched, null, 2));
  log(`${candidates.length} candidates written to ${outFile}`);
  for (const entry of enriched.slice(0, 15)) {
    log(`- ${entry.commitSha.slice(0, 8)} [${entry.size}] ${entry.commitMessage} | tests: ${entry.testFiles.length} sources: ${entry.sourceFiles.length}`);
  }
  return 0;
}

export async function cmdVerifyTask(options: CliOptions): Promise<number> {
  const { verifyTask } = await import('./mine-tasks');
  const config = readConfig(options.configPath);
  if (!options.taskFile) {
    log('usage: verify-task --task-file <task.json>');
    return 1;
  }
  const task = JSON.parse(readFileSync(resolve(options.taskFile), 'utf8')) as TaskDefinition;
  const repoPath = config.repoPaths[task.repoId];
  if (!repoPath) {
    log(`unknown repo ${task.repoId}`);
    return 1;
  }
  if (process.argv.some(arg => arg === '--setup' || arg.startsWith('--setup='))) {
    throw new Error('verify-task no longer accepts --setup; it always uses frozen dependency setup');
  }
  const result = await verifyTask({
    task,
    repoPath,
    evidenceDir: join(resolve(config.resultsRoot), 'mining', task.id),
    workRoot: config.workRoot,
    timeoutMs: (options.wallMinutes ?? 20) * 60_000,
  });
  log(`failOnParent ${result.failOnParent} (exit ${result.parentExit}), passOnCommit ${result.passOnCommit} (exit ${result.commitExit})`);
  log(`evidence: ${result.evidenceDir}`);
  return result.failOnParent && result.passOnCommit ? 0 : 1;
}
