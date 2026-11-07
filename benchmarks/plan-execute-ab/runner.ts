import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { readConfig, type CliOptions } from './config';
export { readConfig, type CliOptions } from './config';
import { cmdMine, cmdSelfTest, cmdSpeedGate, cmdVerifyTask } from './runner-tools';
export { cmdSpeedGate };
import { runClaudeAgent, runCodexAgent } from './agent-cli';
import {
  ARMS,
  CLAUDE_OPS_MODEL,
  OPTIONAL_PILOT_ARMS,
  PILOT_ARMS,
  coderPrompt,
  localEndpointEnv,
  plannerPrompt,
  runsPerArmFor,
  summarizeAgentResult,
  takeoverPrompt,
} from './arms';
import { loadTaskBank, selectArms, selectTasks } from './task-bank';
import { applyHiddenTests, capturePatch, exportWorkspace, writePlanFile } from './task-export';
import { scoreRun } from './scorer';
import { prepareScoringDependencies, scoringEnvironment } from './scoring-setup';
import { claudeJudgeRunner, codexJudgeRunner, judgePair, stripIdentifyingText } from './judge';
import { buildReport, writeReport } from './report';
import { COMPLETE_TASKS } from './decision-rules';
import { readCostEvidence } from './cost';
import { ModelControl, isModelControlConfigured } from './model-control';
import { createTakeoverMonitor } from './monitor';
import { loadSpeedGateLog, probeLocalSpeed, speedGateDecisionFromEntries, speedGateLogPath } from './speed-gate';
import { log, parseArgs } from './cli-util';
import { bestEffortCleanup, finalizeScoredRun, loadRunRecords, openSession, runCellKey, type Session } from './session';
import type {
  ArmId,
  BenchmarkReport,
  JudgePairResult,
  RunRecord,
  TaskDefinition,
  TokenUsage,
} from './types';
import { emptyUsage } from './types';

const DEFAULT_CONFIG_PATH = new URL('./runner.config.json', import.meta.url).pathname;

async function ensureFrozenPlan(
  task: TaskDefinition,
  session: Session,
  config: ReturnType<typeof readConfig>,
  wallClockMs: number,
  plannerCwd: string,
): Promise<{ planText: string; usage: TokenUsage; logPath: string; plannedFresh: boolean }> {
  const planPath = join(session.plansDir, `${task.id}.md`);
  const usagePath = join(session.plansDir, `${task.id}.usage.json`);
  if (existsSync(planPath)) {
    const usage = existsSync(usagePath)
      ? JSON.parse(readFileSync(usagePath, 'utf8')) as TokenUsage
      : emptyUsage();
    return { planText: readFileSync(planPath, 'utf8'), usage, logPath: planPath, plannedFresh: false };
  }
  if (config.frozenPlansOnly) throw new Error(`local-only mode requires an existing frozen plan: ${planPath}`);
  // The planner reads the task's parent-commit workspace only — never the live
  // repository — so it cannot see the solution or its commit message.
  const result = await runClaudeAgent({
    prompt: plannerPrompt(task),
    cwd: plannerCwd,
    logPath: join(session.plansDir, `${task.id}.planner.log`),
    timeoutMs: wallClockMs,
    model: ARMS.A.coderModel,
    maxTurns: config.turnCap,
    readOnly: true,
  });
  // Only a completed planner run may become a frozen plan: error/exit 1/timeout
  // outcomes (and empty or turn-capped text) must never persist, or every plan
  // arm silently reuses the failed invocation's partial output as its plan.
  if (result.error !== undefined || result.hitTurnCap || result.finalText.trim() === '') {
    throw new Error(
      `planner failed for ${task.id} — no frozen plan saved: `
      + (result.error ?? (result.hitTurnCap ? 'planner hit its turn cap before finishing' : 'empty plan text')),
    );
  }
  writeFileSync(planPath, result.finalText);
  writeFileSync(usagePath, JSON.stringify(result.usage, null, 2));
  return { planText: result.finalText, usage: result.usage, logPath: planPath, plannedFresh: true };
}

interface RunArmOptions {
  task: TaskDefinition;
  armId: ArmId;
  runNumber: number;
  session: Session;
  config: ReturnType<typeof readConfig>;
  wallClockMs: number;
  modelControl: ModelControl | null;
}

async function runArm(options: RunArmOptions): Promise<RunRecord> {
  const { task, armId, runNumber, session, config, wallClockMs, modelControl } = options;
  const arm = ARMS[armId];
  const startedAt = new Date();
  const repoPath = config.repoPaths[task.repoId];
  if (!repoPath) {
    throw new Error(`no repoPath configured for repo ${task.repoId}`);
  }

  let plannerUsage = emptyUsage();
  let frozenPlan: string | null = null;

  const localModelKey = armId === 'F' ? (config.fLocalModelKey ?? 'qwen3.8-27b') : arm.localModelKey;
  const isLocal = arm.coderKind === 'local-claude-code';
  const endpoint = isLocal
    ? config.localArms.find((candidate) => candidate.modelKey === localModelKey)
    : undefined;
  if (isLocal && !endpoint) {
    throw new Error(`arm ${armId} needs a local endpoint (model ${localModelKey}) in runner.config.json`);
  }
  const workspace = await exportWorkspace({
    repoPath,
    commitSha: task.parentSha,
    workRoot: config.workRoot,
    workspaceName: `${task.id}-${armId}-${runNumber}`,
  });
  try {
    const scoringDir = join(session.dir, 'scoring', `${task.id}-${armId}-run${runNumber}`);
    const dependencies = await prepareScoringDependencies(workspace.dir, scoringDir);
    if (arm.usesFrozenPlan) {
      const plan = await ensureFrozenPlan(task, session, config, wallClockMs, workspace.dir);
      frozenPlan = plan.planText;
      // A reused plan keeps its recorded planner usage: every preplanned workflow
      // (C1/C2/D/E/F) stands alone as plan+code, so its run must carry the task's
      // full Opus planning tokens (same per-task accounting as cost.ts) or the
      // report's Claude-token saving is inflated by silently free plans.
      plannerUsage = plan.usage;
    }
    if (frozenPlan) {
      writePlanFile(workspace.dir, frozenPlan);
    }

    const logPath = join(session.dir, `${task.id}-${armId}-run${runNumber}.agent.log`);
    const prompt = coderPrompt(task, frozenPlan, arm.label);
    const monitor = armId === 'F'
      ? createTakeoverMonitor({ maxFailedTestRuns: 2, maxTurnsWithoutProgress: 15 })
      : null;
    let takeoverReason = '';
    const onEvent = monitor
      ? (event: Record<string, unknown>): 'abort' | undefined => {
          const decision = monitor.onEvent(event);
          if (decision.abort) {
            takeoverReason = decision.reason;
            return 'abort';
          }
          return undefined;
        }
      : undefined;

    // Per-run speed capture (plan: "prompt-read and write speeds" per run). Probed
    // after the model is loaded and before it can be unloaded; failures never hold up the run.
    let localSpeed: Awaited<ReturnType<typeof probeLocalSpeed>> | undefined;
    let agentResult;
    let modelLoaded = false;
    try {
      if (isLocal && modelControl && localModelKey) {
        const loaded = await modelControl.loadModel(localModelKey);
        if (!loaded.ok) {
          throw new Error(`model load failed for ${localModelKey}: ${loaded.error ?? 'unknown'}`);
        }
        modelLoaded = true;
      }
      localSpeed = endpoint
        ? await probeLocalSpeed(endpoint, process.env[endpoint.apiKeyEnv] ?? 'local-benchmark-key')
        : undefined;
      if (arm.coderKind === 'codex') {
        agentResult = await runCodexAgent({
          prompt,
          cwd: workspace.dir,
          logPath,
          timeoutMs: wallClockMs,
          // Same turn cap as every arm (plan fairness controls); `codex exec`
          // has no flag for it, so runCodexAgent enforces it on the stream.
          maxTurns: config.turnCap,
          env: scoringEnvironment(workspace.dir),
          onEvent,
        });
      } else {
        agentResult = await runClaudeAgent({
          prompt,
          cwd: workspace.dir,
          logPath,
          timeoutMs: wallClockMs,
          // Local arms must ask the server for the model name it actually serves;
          // cloud arms use the arm's cloud model id.
          model: isLocal
            ? (endpoint?.servedModelName ?? arm.coderModel ?? undefined)
            : (arm.coderModel || undefined),
          maxTurns: config.turnCap,
          env: scoringEnvironment(workspace.dir, endpoint ? localEndpointEnv(endpoint) : process.env),
          onEvent,
        });
      }
    } finally {
      if (modelLoaded && modelControl && localModelKey) {
        await modelControl.unloadModel(localModelKey);
      }
    }

    let takeoverUsage = emptyUsage();
    if (armId === 'F' && (takeoverReason !== '' || agentResult.error !== undefined)) {
      const reason = takeoverReason || agentResult.error || 'coder did not finish';
      // Fairness control ("same limits for every arm: 60-minute wall clock …
      // same turn cap"): the coder and the Opus takeover are one run, so the
      // takeover gets what the coder left, never a fresh full budget.
      const takeoverTimeoutMs = wallClockMs - agentResult.durationMs;
      const takeoverTurns = config.turnCap - agentResult.turns;
      if (takeoverTimeoutMs <= 0 || takeoverTurns <= 0) {
        const skipNote = `takeover skipped: no budget remained (wall-clock left ${takeoverTimeoutMs}ms, turns left ${takeoverTurns})`;
        agentResult = summarizeAgentResult({
          ...agentResult,
          error: agentResult.error ? `${agentResult.error} | ${skipNote}` : skipNote,
        });
      } else {
        const takeover = await runClaudeAgent({
          prompt: takeoverPrompt(task, agentResult.finalText, reason),
          cwd: workspace.dir,
          logPath: join(session.dir, `${task.id}-${armId}-run${runNumber}.takeover.log`),
          timeoutMs: takeoverTimeoutMs,
          model: CLAUDE_OPS_MODEL,
          maxTurns: takeoverTurns,
          env: scoringEnvironment(workspace.dir),
        });
        takeoverUsage = takeover.usage;
        agentResult = summarizeAgentResult({
          ...agentResult,
          finalText: takeover.finalText || agentResult.finalText,
          turns: agentResult.turns + takeover.turns,
          durationMs: agentResult.durationMs + takeover.durationMs,
          error: takeover.error,
        });
      }
    }

    const patch = await capturePatch(workspace);
    const patchPath = join(session.patchesDir, `${task.id}-${armId}-run${runNumber}.patch`);
    writeFileSync(patchPath, patch);

    applyHiddenTests(repoPath, task.commitSha, task.hiddenTests, workspace.dir);
    const score = await scoreRun(task, { workspaceDir: workspace.dir, timeoutMs: wallClockMs, logDir: scoringDir, dependencies });

    const record: RunRecord = {
      taskId: task.id,
      armId,
      runNumber,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: agentResult.durationMs,
      workspaceDir: workspace.dir,
      planUsed: arm.usesFrozenPlan,
      plannerUsage,
      coderUsage: agentResult.usage,
      takeoverUsage,
      turns: agentResult.turns,
      flags: {
        looped: agentResult.toolErrors.length >= 5 && agentResult.turns >= config.turnCap * 0.8,
        toolCallErrors: agentResult.toolErrors.length,
        hitTurnCap: agentResult.hitTurnCap,
        gaveUp: Boolean(agentResult.error) && agentResult.finalText.length < 200,
      },
      score,
      patchPath,
      error: agentResult.error,
      localSpeed,
      // Fairness control provenance: which serving stack backed a local coder,
      // so a mid-arm server/settings change is detectable in the report.
      servingSetupId: isLocal ? (endpoint?.servingSetup ?? 'unrecorded') : undefined,
    };
    finalizeScoredRun(session, record, workspace.dir);
    return record;
  } finally {
    bestEffortCleanup(workspace.dir);
  }
}

async function judgeSession(
  session: Session,
  tasks: TaskDefinition[],
  config: ReturnType<typeof readConfig>,
  wallClockMs: number,
): Promise<JudgePairResult[]> {
  const runs = loadRunRecords(session);
  const pairs: JudgePairResult[] = [];
  for (const task of tasks) {
    const baseline = runs.find((run) => run.taskId === task.id && run.armId === 'A');
    if (!baseline || !existsSync(baseline.patchPath)) continue;
    const baselineDiff = stripIdentifyingText(readFileSync(baseline.patchPath, 'utf8'));
    for (const armId of Object.keys(ARMS) as ArmId[]) {
      if (armId === 'A') continue;
      const pairPath = join(session.judgeDir, `${task.id}-${armId}.json`);
      // Batches run one arm at a time (model swaps); never judge a pair twice.
      if (existsSync(pairPath)) continue;
      const subject = runs.find((run) => run.taskId === task.id && run.armId === armId);
      if (!subject || !existsSync(subject.patchPath)) continue;
      const subjectDiff = stripIdentifyingText(readFileSync(subject.patchPath, 'utf8'));
      // The pair compares THIS subject run's patch with THIS baseline run's
      // patch; record their identities so conflict metrics use the judged
      // patches' own test outcomes (never a majority of other repeats).
      const judgedRuns = { subjectRunNumber: subject.runNumber, baselineRunNumber: baseline.runNumber };
      const claudePair = await judgePair(
        'claude',
        claudeJudgeRunner(ARMS.A.coderModel, (name) => join(session.judgeDir, `${task.id}-${armId}-${name}.log`), wallClockMs),
        task,
        armId,
        subjectDiff,
        baselineDiff,
        judgedRuns,
      );
      pairs.push(claudePair);
      const codexPair = await judgePair(
        'codex',
        codexJudgeRunner((name) => join(session.judgeDir, `${task.id}-${armId}-${name}.log`), wallClockMs),
        task,
        armId,
        subjectDiff,
        baselineDiff,
        judgedRuns,
      );
      pairs.push(codexPair);
      writeFileSync(pairPath, JSON.stringify([claudePair, codexPair], null, 2));
    }
  }
  return pairs;
}

function buildSessionReport(
  session: Session,
  resultsRoot: string,
  phase: 'pilot' | 'full',
  notes: string[],
  expectedTaskIds?: readonly string[],
): BenchmarkReport {
  const runs = loadRunRecords(session);
  const pairs: JudgePairResult[] = [];
  for (const file of readdirSync(session.judgeDir)) {
    if (!file.endsWith('.json')) continue;
    const parsed = JSON.parse(readFileSync(join(session.judgeDir, file), 'utf8')) as JudgePairResult[];
    pairs.push(...parsed);
  }
  // Gate measurements live in the results root (written by `speed-gate`), so run
  // and report both retain them and the decision rules see the gate decision.
  const gateLog = loadSpeedGateLog(speedGateLogPath(resultsRoot));
  const speedGate = speedGateDecisionFromEntries(gateLog.entries);
  // Metered cost comes from the session's own agent logs (CLI-reported
  // total_cost_usd), so "cost per solved task" is measured, not estimated.
  const costEvidence = readCostEvidence(session.dir);
  const report = buildReport(session.dir, runs, pairs, speedGate, phase, notes, gateLog.entries, costEvidence, expectedTaskIds);
  writeReport(session.dir, report);
  return report;
}

/**
 * `--turn-cap` overrides the configured cap for both the run and planning
 * paths (the plan's shared turn cap is config.turnCap everywhere downstream).
 * Returns an error message for invalid overrides.
 */
function applyTurnCapOverride(config: ReturnType<typeof readConfig>, options: CliOptions): string | null {
  if (options.turnCap === undefined) return null;
  if (!Number.isInteger(options.turnCap) || options.turnCap < 1) {
    return `--turn-cap must be a positive integer (got ${options.turnCap})`;
  }
  config.turnCap = options.turnCap;
  return null;
}

export async function cmdRun(options: CliOptions): Promise<number> {
  const config = readConfig(options.configPath);
  const turnCapError = applyTurnCapOverride(config, options);
  if (turnCapError) {
    log(turnCapError);
    return 1;
  }
  // `--bank` overrides the configured bank (a 30-task full-run bank is a
  // different file; editing runner.config.json to switch it invites mistakes).
  const bank = loadTaskBank(options.bankPath ?? config.bankPath);
  const wallClockMs = (options.wallMinutes ?? config.wallClockMinutes) * 60_000;
  const phase = options.phase;
  // The full run's matrix is the plan's 30 tasks (steps 12-13). A smaller bank
  // is a pilot bank: running it as "full" would spend the full run's repeat
  // counts on the wrong matrix and could support recommendations the plan never
  // authorized. Batch a real full run with `--tasks` subsets of its 30-task bank.
  if (phase === 'full' && bank.tasks.length < COMPLETE_TASKS.full) {
    log(
      `--phase full needs a task bank of at least ${COMPLETE_TASKS.full} tasks (plan steps 12-13); `
      + `${options.bankPath ?? config.bankPath} has ${bank.tasks.length} — pass --bank <30-task bank> or use --phase pilot`,
    );
    return 1;
  }

  // Full-run matrix (plan step 12 / livetest B3): cloud arms A, D, G (E only
  // when its sharing call is approved) plus the local arms and F. The pilot
  // default is A,B,C1,C2,D with E/G behind --include-optional.
  const defaultArms: ArmId[] = phase === 'full'
    ? options.includeOptional
      ? [...PILOT_ARMS, ...OPTIONAL_PILOT_ARMS, 'F']
      : [...PILOT_ARMS, 'G', 'F']
    : options.includeOptional
      ? [...PILOT_ARMS, ...OPTIONAL_PILOT_ARMS]
      : [...PILOT_ARMS];
  const armIds = selectArms(
    [...PILOT_ARMS, ...OPTIONAL_PILOT_ARMS, 'F'],
    options.arms ?? defaultArms,
  ).filter((armId) => phase === 'full' || ARMS[armId].phase === 'pilot');
  const tasks = selectTasks(bank, options.tasks);
  config.frozenPlansOnly = options.localOnly;
  if (options.localOnly) {
    if (options.phase !== 'pilot' || armIds.length === 0 ||
        (options.arms ?? armIds).some((id) => !['B', 'C1', 'C2'].includes(id.toUpperCase()))) {
      log('local-only mode accepts pilot arms B/C1/C2 only');
      return 1;
    }
    const plansDir = join(resolve(config.resultsRoot), options.session ?? '', 'plans');
    if (armIds.some((id) => ARMS[id].usesFrozenPlan) &&
        (!options.session || tasks.some((task) => !existsSync(join(plansDir, `${task.id}.md`))))) {
      log('local-only mode requires every existing frozen plan in an explicit --session');
      return 1;
    }
  }
  const runsForArm = (armId: ArmId): number => runsPerArmFor(phase, armId, options.runs);

  if (options.dryRun) {
    for (const task of tasks) {
      for (const armId of armIds) {
        for (let runNumber = 1; runNumber <= runsForArm(armId); runNumber += 1) {
          log(`would run ${task.id} arm ${armId} run ${runNumber} (repo ${task.repoId})`);
        }
      }
    }
    return 0;
  }

  const session = openSession(config.resultsRoot, options.session);
  log(`session: ${session.dir}`);
  const modelControl = isModelControlConfigured(config.modelControl) ? new ModelControl(config.modelControl) : null;
  if (!modelControl && armIds.some((armId) => ARMS[armId].coderKind === 'local-claude-code')) {
    log('WARNING: local arms selected but no modelControl config — model load/unload will not run');
  }

  const notes: string[] = options.localOnly
    ? ['Local-only mode: existing frozen plans required; judges deferred; no cloud coder or takeover.']
    : [];
  let failedRuns = 0;
  let interrupted = false;
  const stop = async (): Promise<void> => {
    if (interrupted) return;
    interrupted = true;
    log('stop requested — reloading helper models (decision 8) and exiting');
    if (modelControl) await modelControl.reloadHelperModels();
    process.exit(130);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());

  // Resume semantics: a run cell (task + arm + numbered slot) with a record is
  // DONE. Re-running it would duplicate the evidence (records are reconciled to
  // one per cell, and appendRunRecord rejects the duplicate anyway) and waste
  // metered spend; re-run a slot only after quarantining its record.
  const recordedCells = new Set(
    loadRunRecords(session).map((run) => runCellKey(run.taskId, run.armId, run.runNumber)),
  );
  for (const task of tasks) {
    for (const armId of armIds) {
      for (let runNumber = 1; runNumber <= runsForArm(armId); runNumber += 1) {
        const cell = runCellKey(task.id, armId, runNumber);
        if (recordedCells.has(cell)) {
          log(`skipping ${task.id} arm ${armId} run ${runNumber} — already recorded (quarantine its record to re-run)`);
          continue;
        }
        log(`running ${task.id} arm ${armId} run ${runNumber}`);
        try {
          await runArm({ task, armId, runNumber, session, config, wallClockMs, modelControl });
          recordedCells.add(cell);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log(`run failed: ${message}`);
          notes.push(`${task.id}/${armId}/run${runNumber} failed before scoring: ${message}`);
          failedRuns += 1;
        }
      }
    }
    // Judge after every task in every batch: pairs whose baseline arrived
    // later (arm A in another batch) get judged here, and already-judged pairs
    // are skipped. Costs nothing when no new pair exists.
    if (!options.localOnly) {
      log(`judging ${task.id} against arm A`);
      await judgeSession(session, [task], config, wallClockMs);
    }
  }

  if (modelControl) {
    const reloaded = await modelControl.reloadHelperModels();
    if (!reloaded.ok) notes.push(`helper model reload failed: ${reloaded.error ?? 'unknown'}`);
  }

  const report = buildSessionReport(
    session,
    config.resultsRoot,
    phase,
    notes,
    // The session's complete matrix is the whole bank; `--tasks` only schedules
    // a subset of it, and the decision rules must not recommend on partial ones.
    bank.tasks.map((task) => task.id),
  );
  log(`report: ${join(session.dir, 'report.md')}`);
  for (const rule of report.decisionRules) {
    log(`[${rule.triggered ? 'TRIGGERED' : 'not triggered'}] ${rule.rule}`);
  }
  if (failedRuns > 0) {
    // A run that died before scoring leaves a hole in the matrix; the report is
    // still written (with the failure notes) but the batch must not look green.
    log(`batch incomplete: ${failedRuns} run(s) failed before scoring — exiting nonzero`);
    return 1;
  }
  return 0;
}

export async function cmdPlan(options: CliOptions): Promise<number> {
  if (options.localOnly) {
    log('local-only mode cannot create cloud plans; use run with an existing session');
    return 1;
  }
  const config = readConfig(options.configPath);
  const turnCapError = applyTurnCapOverride(config, options);
  if (turnCapError) {
    log(turnCapError);
    return 1;
  }
  const bank = loadTaskBank(options.bankPath ?? config.bankPath);
  const tasks = selectTasks(bank, options.tasks);
  const session = openSession(config.resultsRoot, options.session ?? `plans-${Date.now()}`);
  const wallClockMs = (options.wallMinutes ?? config.wallClockMinutes) * 60_000;
  for (const task of tasks) {
    log(`planning ${task.id}`);
    const repoPath = config.repoPaths[task.repoId];
    if (!repoPath) {
      log(`no repoPath configured for repo ${task.repoId}`);
      return 1;
    }
    const workspace = await exportWorkspace({
      repoPath,
      commitSha: task.parentSha,
      workRoot: config.workRoot,
      workspaceName: `${task.id}-plan-only`,
    });
    let plan;
    try {
      plan = await ensureFrozenPlan(task, session, config, wallClockMs, workspace.dir);
    } catch (error) {
      // A failed planner run must not leave a frozen plan behind; report it and
      // stop so the batch is not silently half-planned.
      log(`plan failed: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    } finally {
      bestEffortCleanup(workspace.dir);
    }
    log(`plan written: ${plan.logPath} (${plan.usage.outputTokens} output tokens${plan.plannedFresh ? '' : ', cached'})`);
  }
  return 0;
}

function cmdReport(options: CliOptions): number {
  const config = readConfig(options.configPath);
  if (!options.session) {
    log('usage: report --session <session-dir-name>');
    return 1;
  }
  const session: Session = {
    dir: join(resolve(config.resultsRoot), options.session),
    runsPath: join(resolve(config.resultsRoot), options.session, 'runs.jsonl'),
    patchesDir: join(resolve(config.resultsRoot), options.session, 'patches'),
    plansDir: join(resolve(config.resultsRoot), options.session, 'plans'),
    judgeDir: join(resolve(config.resultsRoot), options.session, 'judge'),
  };
  // Same expected-matrix source as `run` (the bank), so `report` cannot
  // recommend on a partial matrix that `run` would have withheld.
  let expectedTaskIds: readonly string[] | undefined;
  try {
    const bank = loadTaskBank(options.bankPath ?? config.bankPath);
    expectedTaskIds = bank.tasks.map((task) => task.id);
  } catch (error) {
    log(`note: task bank unavailable (${error instanceof Error ? error.message : String(error)}) — decision rules need complete coverage to trigger`);
  }
  const report = buildSessionReport(session, config.resultsRoot, options.phase, [], expectedTaskIds);
  log(`report: ${join(session.dir, 'report.md')}`);
  log(`arms summarised: ${report.arms.map((arm) => arm.armId).join(', ') || '(none)'}`);
  return 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const options: CliOptions = {
    command: args.positional[0] ?? 'help',
    session: args.flags['session'],
    tasks: args.flags['tasks']?.split(',').map((s) => s.trim()),
    arms: args.flags['arms']?.split(',').map((s) => s.trim()),
    runs: args.flags['runs'] ? Number(args.flags['runs']) : undefined,
    dryRun: args.flags['dry-run'] !== undefined,
    localOnly: args.flags['local-only'] !== undefined,
    includeOptional: args.flags['include-optional'] !== undefined,
    configPath: args.flags['config'] ?? DEFAULT_CONFIG_PATH,
    wallMinutes: args.flags['wall-minutes'] ? Number(args.flags['wall-minutes']) : undefined,
    turnCap: args.flags['turn-cap'] ? Number(args.flags['turn-cap']) : undefined,
    phase: args.flags['phase'] === 'full' ? 'full' : 'pilot',
    repoId: args.flags['repo-id'],
    since: args.flags['since'],
    limit: args.flags['limit'] ? Number(args.flags['limit']) : undefined,
    bankPath: args.flags['bank'],
    taskFile: args.flags['task-file'],
    promptFile: args.flags['prompt-file'],
  };

  switch (options.command) {
    case 'run':
      process.exit(await cmdRun(options));
      break;
    case 'plan':
      process.exit(await cmdPlan(options));
      break;
    case 'speed-gate':
      process.exit(await cmdSpeedGate(options));
      break;
    case 'self-test':
      process.exit(await cmdSelfTest(options));
      break;
    case 'mine':
      process.exit(await cmdMine(options));
      break;
    case 'verify-task':
      process.exit(await cmdVerifyTask(options));
      break;
    case 'report':
      process.exit(cmdReport(options));
      break;
    default:
      log('commands: run | plan | speed-gate | self-test | mine | verify-task | report');
      log('flags: --session --tasks --arms --runs --dry-run --include-optional --config --wall-minutes --turn-cap --phase pilot|full');
      log('       --local-only (pilot B/C1/C2, existing plans, no judges or cloud calls)');
      log('       --bank <task-bank.json> --task-file <task.json> --repo-id <id> --since YYYY-MM-DD --limit N');
      log('       --prompt-file <text> (speed-gate: real agent prompt; the C2 gate only decides on real prompts)');
      process.exit(options.command === 'help' ? 0 : 1);
  }
}

// Executed as a CLI only — specs import cmdRun/cmdPlan without side effects.
if (process.argv[1]?.endsWith('runner.ts')) {
  void main();
}
