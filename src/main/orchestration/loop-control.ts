import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import type {
  LoopControlMetadata,
  LoopTerminalIntent,
  LoopTerminalIntentEvidence,
  LoopTerminalIntentKind,
  LoopTerminalIntentStatus,
} from '../../shared/types/loop.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('LoopControl');

export const LOOP_CONTROL_DIR_NAME = '.aio-loop-control';
export const LOOP_CONTROL_FILE_NAME = 'control.json';
export const LOOP_CONTROL_VERSION = 1 as const;
export const LOOP_CONTROL_PROMPT_VERSION = 1 as const;
export const LOOP_CONTROL_MAX_JSON_BYTES = 16 * 1024;

export interface LoopControlRuntime extends LoopControlMetadata {
  secret: string;
}

export interface LoopControlFile {
  version: 1;
  promptVersion: 1;
  loopRunId: string;
  workspaceCwd: string;
  controlDir: string;
  intentsDir: string;
  currentIterationSeq: number;
  secret: string;
  cliPath: string;
  updatedAt: number;
}

interface RawIntentFile {
  version: 1;
  id: string;
  loopRunId: string;
  iterationSeq: number;
  kind: LoopTerminalIntentKind;
  summary: string;
  evidence?: LoopTerminalIntentEvidence[];
  source?: 'loop-control-cli' | 'imported-file';
  createdAt: number;
  secret: string;
}

export interface ImportedLoopIntentResult {
  accepted: LoopTerminalIntent[];
  rejected: {
    filePath: string;
    reason: string;
    receivedAt: number;
    loopRunId?: string;
    iterationSeq?: number;
  }[];
}

export interface LoopControlEnv {
  ORCHESTRATOR_LOOP_RUN_ID: string;
  ORCHESTRATOR_LOOP_CONTROL_FILE: string;
  ORCHESTRATOR_LOOP_CONTROL_SECRET: string;
  ORCHESTRATOR_LOOP_CLI: string;
}

export async function prepareLoopControl(
  workspaceCwd: string,
  loopRunId: string,
  activeLoopRunIds: Iterable<string> = [loopRunId],
): Promise<LoopControlRuntime> {
  const workspace = path.resolve(workspaceCwd);
  await fs.mkdir(workspace, { recursive: true });
  await ensureGitignoreEntry(workspace, `${LOOP_CONTROL_DIR_NAME}/`);
  await pruneStaleLoopControlDirs(workspace, new Set(activeLoopRunIds));

  const controlDir = path.join(workspace, LOOP_CONTROL_DIR_NAME, loopRunId);
  const intentsDir = path.join(controlDir, 'intents');
  await fs.mkdir(intentsDir, { recursive: true, mode: 0o700 });

  const createdAt = Date.now();
  const runtime: LoopControlRuntime = {
    version: LOOP_CONTROL_VERSION,
    loopRunId,
    workspaceCwd: workspace,
    controlDir,
    controlFile: path.join(controlDir, LOOP_CONTROL_FILE_NAME),
    intentsDir,
    currentIterationSeq: 0,
    cliPath: await resolveLoopControlCliPath(controlDir),
    createdAt,
    updatedAt: createdAt,
    secret: randomBytes(32).toString('base64url'),
  };
  await writeLoopControlFile(runtime, 0);
  return runtime;
}

export async function writeLoopControlFile(
  runtime: LoopControlRuntime,
  currentIterationSeq: number,
): Promise<void> {
  runtime.currentIterationSeq = currentIterationSeq;
  runtime.updatedAt = Date.now();
  const controlFile: LoopControlFile = {
    version: LOOP_CONTROL_VERSION,
    promptVersion: LOOP_CONTROL_PROMPT_VERSION,
    loopRunId: runtime.loopRunId,
    workspaceCwd: runtime.workspaceCwd,
    controlDir: runtime.controlDir,
    intentsDir: runtime.intentsDir,
    currentIterationSeq,
    secret: runtime.secret,
    cliPath: runtime.cliPath,
    updatedAt: runtime.updatedAt,
  };
  await writeJsonAtomic(runtime.controlFile, controlFile, 0o600);
}

export function publicLoopControlMetadata(runtime: LoopControlRuntime): LoopControlMetadata {
  return {
    version: runtime.version,
    loopRunId: runtime.loopRunId,
    workspaceCwd: runtime.workspaceCwd,
    controlDir: runtime.controlDir,
    controlFile: runtime.controlFile,
    intentsDir: runtime.intentsDir,
    currentIterationSeq: runtime.currentIterationSeq,
    cliPath: runtime.cliPath,
    createdAt: runtime.createdAt,
    updatedAt: runtime.updatedAt,
  };
}

export function buildLoopControlEnv(runtime: LoopControlRuntime): LoopControlEnv {
  return {
    ORCHESTRATOR_LOOP_RUN_ID: runtime.loopRunId,
    ORCHESTRATOR_LOOP_CONTROL_FILE: runtime.controlFile,
    ORCHESTRATOR_LOOP_CONTROL_SECRET: runtime.secret,
    ORCHESTRATOR_LOOP_CLI: runtime.cliPath,
  };
}

export async function importLoopTerminalIntents(
  runtime: LoopControlRuntime,
  options: {
    maxIterationSeq: number;
    exactIterationSeq?: number;
    terminalEligible: boolean;
  },
): Promise<ImportedLoopIntentResult> {
  const accepted: LoopTerminalIntent[] = [];
  const rejected: ImportedLoopIntentResult['rejected'] = [];
  await fs.mkdir(runtime.intentsDir, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(runtime.intentsDir, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(runtime.intentsDir, entry.name))
    .sort();

  for (const filePath of files) {
    const receivedAt = Date.now();
    try {
      const raw = await readIntentFileForImport(filePath);
      validateIntentAgainstRuntime(raw, runtime, options);
      const intent: LoopTerminalIntent = {
        id: raw.id,
        loopRunId: raw.loopRunId,
        iterationSeq: raw.iterationSeq,
        kind: raw.kind,
        summary: raw.summary,
        evidence: normalizeEvidence(raw.evidence ?? []),
        source: raw.source ?? 'loop-control-cli',
        createdAt: raw.createdAt,
        receivedAt,
        status: 'pending',
        filePath,
      };
      accepted.push(intent);
      // NB2: do NOT archive accepted files here. The caller must persist
      // the intent to durable storage first and then call
      // `commitImportedIntent` to move the file from intents/ to
      // imported/. Archiving before persistence opens a crash window
      // where the file is no longer in intents/ but no DB row exists, so
      // restart recovery loses the intent entirely.
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      rejected.push({ filePath, reason, receivedAt });
      // Rejected files are safe to archive immediately: there is no DB
      // row to lose, and leaving them in intents/ would cause the next
      // import boundary to re-reject the same file forever.
      await archiveIntentFile(runtime, filePath, 'rejected').catch(() => undefined);
    }
  }

  accepted.sort((a, b) => a.receivedAt - b.receivedAt || a.createdAt - b.createdAt);
  return { accepted, rejected };
}

/**
 * Archive a previously-imported intent file from `intents/` into
 * `imported/`. Callers MUST invoke this only after the intent has been
 * durably persisted (e.g. inserted into `loop_terminal_intents`).
 *
 * Failure here means the DB has the row but the source file is still in
 * `intents/`. On next import the file would be re-read, but the
 * `UPSERT` on the intent id keeps the operation idempotent — the worst
 * case is a duplicate insert attempt that resolves to a no-op update.
 */
export async function commitImportedIntent(
  runtime: LoopControlRuntime,
  filePath: string,
): Promise<void> {
  await archiveIntentFile(runtime, filePath, 'imported');
}

/**
 * Walk `<controlDir>/imported/` and parse any intent files present
 * there. Used by the startup reconciler to find orphans whose source
 * file was archived but whose DB row never landed (the crash window
 * NB2 was designed to close at write time, with this reconciler as the
 * defence-in-depth net).
 *
 * The returned intents have `status: 'pending'` and `source:
 * 'imported-file'` so the caller can distinguish reconciled orphans
 * from fresh CLI submissions. The secret check is intentionally
 * skipped — these files have already passed through the importer at
 * least once.
 */
export async function listArchivedImportedIntents(
  runtime: LoopControlRuntime,
): Promise<LoopTerminalIntent[]> {
  return listArchivedImportedIntentsFromControlDir(runtime.controlDir, runtime.loopRunId);
}

/**
 * Boot-time variant of `listArchivedImportedIntents` that does not
 * require an in-memory `LoopControlRuntime`. Used by the startup
 * reconciler to find orphans for previously-running loops whose
 * runtime objects are gone after a crash.
 *
 * `workspaceCwd` plus `loopRunId` is enough to compute the control
 * directory deterministically (`<workspaceCwd>/.aio-loop-control/<loopRunId>/`).
 */
export async function listArchivedImportedIntentsByLoop(
  workspaceCwd: string,
  loopRunId: string,
): Promise<LoopTerminalIntent[]> {
  const controlDir = path.join(path.resolve(workspaceCwd), LOOP_CONTROL_DIR_NAME, loopRunId);
  return listArchivedImportedIntentsFromControlDir(controlDir, loopRunId);
}

async function listArchivedImportedIntentsFromControlDir(
  controlDir: string,
  loopRunId: string,
): Promise<LoopTerminalIntent[]> {
  const archiveDir = path.join(controlDir, 'imported');
  const entries = await fs.readdir(archiveDir, { withFileTypes: true }).catch(() => []);
  const out: LoopTerminalIntent[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(archiveDir, entry.name);
    try {
      const stat = await fs.lstat(filePath);
      if (stat.isSymbolicLink()) continue;
      if (!stat.isFile()) continue;
      if (stat.size > LOOP_CONTROL_MAX_JSON_BYTES) continue;
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
      const raw = parseRawIntent(parsed);
      // Skip files that belong to a different loop run (defensive — the
      // archive directory should already be scoped to this run).
      if (raw.loopRunId !== loopRunId) continue;
      out.push({
        id: raw.id,
        loopRunId: raw.loopRunId,
        iterationSeq: raw.iterationSeq,
        kind: raw.kind,
        summary: raw.summary,
        evidence: normalizeEvidence(raw.evidence ?? []),
        source: 'imported-file',
        createdAt: raw.createdAt,
        receivedAt: Date.now(),
        status: 'pending',
        filePath,
      });
    } catch (err) {
      logger.warn('Failed to read archived imported intent', {
        loopRunId,
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

export function latestIntentByReceivedAt(intents: readonly LoopTerminalIntent[]): LoopTerminalIntent | null {
  if (intents.length === 0) return null;
  return [...intents].sort((a, b) => b.receivedAt - a.receivedAt || b.createdAt - a.createdAt)[0] ?? null;
}

export function cloneIntentWithStatus(
  intent: LoopTerminalIntent,
  status: LoopTerminalIntentStatus,
  statusReason?: string,
): LoopTerminalIntent {
  return {
    ...intent,
    evidence: intent.evidence.map((item) => ({ ...item })),
    status,
    statusReason,
  };
}

export async function readLoopControlFileFromEnv(env: NodeJS.ProcessEnv): Promise<LoopControlFile> {
  const controlFile = readRequiredEnv(env, 'ORCHESTRATOR_LOOP_CONTROL_FILE');
  const loopRunId = readRequiredEnv(env, 'ORCHESTRATOR_LOOP_RUN_ID');
  const secret = readRequiredEnv(env, 'ORCHESTRATOR_LOOP_CONTROL_SECRET');
  const resolved = path.resolve(controlFile);
  const control = await readSizedJsonFile<LoopControlFile>(resolved, LOOP_CONTROL_MAX_JSON_BYTES);
  if (control.version !== LOOP_CONTROL_VERSION) {
    throw new Error(`Unsupported loop-control version ${String(control.version)}`);
  }
  if (control.loopRunId !== loopRunId) {
    throw new Error('Loop-control run id mismatch');
  }
  if (control.secret !== secret) {
    throw new Error('Loop-control secret mismatch');
  }

  const workspace = await realpathIfExists(control.workspaceCwd);
  const realControl = await fs.realpath(resolved);
  const expectedRoot = path.join(workspace, LOOP_CONTROL_DIR_NAME, loopRunId);
  if (!isPathInside(realControl, expectedRoot)) {
    throw new Error('Loop-control file is outside the expected workspace control directory');
  }
  return control;
}

export async function writeIntentFromCli(
  control: LoopControlFile,
  kind: LoopTerminalIntentKind,
  summary: string,
  evidence: LoopTerminalIntentEvidence[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const secret = readRequiredEnv(env, 'ORCHESTRATOR_LOOP_CONTROL_SECRET');
  const id = `intent-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const intent: RawIntentFile = {
    version: LOOP_CONTROL_VERSION,
    id,
    loopRunId: control.loopRunId,
    iterationSeq: control.currentIterationSeq,
    kind,
    summary,
    evidence: normalizeEvidence(evidence),
    source: 'loop-control-cli',
    createdAt: Date.now(),
    secret,
  };

  const intentsDir = path.resolve(control.intentsDir);
  const workspace = await realpathIfExists(control.workspaceCwd);
  const expectedRoot = path.join(workspace, LOOP_CONTROL_DIR_NAME, control.loopRunId);
  const realIntentsDir = await realpathOrCreateDir(intentsDir);
  if (!isPathInside(realIntentsDir, expectedRoot)) {
    throw new Error('Loop-control intents directory is outside the expected workspace control directory');
  }

  const target = path.join(intentsDir, `${intent.iterationSeq}-${Date.now()}-${id}.json`);
  await writeJsonAtomic(target, intent, 0o600);
  return target;
}

export function summarizeLoopControlPrompt(runtime: LoopControlRuntime): string {
  return [
    '',
    'Loop Terminal Control:',
    `- When the requested work is complete and verified by you, run: "${runtime.cliPath}" complete --summary "<what is done>"`,
    `- If genuinely blocked and another iteration cannot help, run: "${runtime.cliPath}" block --summary "<exact blocker>"`,
    `- If the task should be marked failed, run: "${runtime.cliPath}" fail --summary "<failure reason>"`,
    '- This command records your intent only. The coordinator will still run verification and fresh-eyes review before marking completion.',
    '- The command reads the current iteration from the loop control file, so use it exactly as provided even in same-session loops.',
  ].join('\n');
}

export async function cleanupLoopControl(runtime: LoopControlRuntime | undefined): Promise<void> {
  if (!runtime) return;
  await fs.rm(runtime.controlDir, { recursive: true, force: true }).catch((err: unknown) => {
    logger.warn('Failed to cleanup loop-control directory', {
      loopRunId: runtime.loopRunId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

async function readIntentFileForImport(filePath: string): Promise<RawIntentFile> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink()) {
    throw new Error('Intent file must not be a symlink');
  }
  if (!stat.isFile()) {
    throw new Error('Intent path is not a regular file');
  }
  if (stat.size > LOOP_CONTROL_MAX_JSON_BYTES) {
    throw new Error(`Intent file exceeds ${LOOP_CONTROL_MAX_JSON_BYTES} byte cap`);
  }
  const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
  return parseRawIntent(parsed);
}

function parseRawIntent(value: unknown): RawIntentFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Intent JSON must be an object');
  }
  const data = value as Record<string, unknown>;
  const kind = data['kind'];
  if (kind !== 'complete' && kind !== 'block' && kind !== 'fail') {
    throw new Error('Intent kind must be complete, block, or fail');
  }
  const summary = readStringField(data, 'summary');
  if (!summary.trim()) {
    throw new Error('Intent summary is required');
  }
  if (summary.length > 4096) {
    throw new Error('Intent summary is too large');
  }
  const evidence = Array.isArray(data['evidence'])
    ? normalizeEvidence(data['evidence'] as unknown[])
    : [];
  return {
    version: data['version'] === 1 ? 1 : (() => { throw new Error('Intent version must be 1'); })(),
    id: readStringField(data, 'id'),
    loopRunId: readStringField(data, 'loopRunId'),
    iterationSeq: readNonnegativeIntegerField(data, 'iterationSeq'),
    kind,
    summary,
    evidence,
    source: data['source'] === 'imported-file' ? 'imported-file' : 'loop-control-cli',
    createdAt: readNonnegativeIntegerField(data, 'createdAt'),
    secret: readStringField(data, 'secret'),
  };
}

function validateIntentAgainstRuntime(
  raw: RawIntentFile,
  runtime: LoopControlRuntime,
  options: { maxIterationSeq: number; exactIterationSeq?: number; terminalEligible: boolean },
): void {
  if (raw.loopRunId !== runtime.loopRunId) {
    throw new Error('Intent loopRunId does not match this loop');
  }
  if (raw.secret !== runtime.secret) {
    throw new Error('Intent secret does not match this loop');
  }
  if (options.exactIterationSeq !== undefined && raw.iterationSeq !== options.exactIterationSeq) {
    throw new Error(`Intent iterationSeq ${raw.iterationSeq} does not match current iteration ${options.exactIterationSeq}`);
  }
  if (raw.iterationSeq > options.maxIterationSeq) {
    throw new Error(`Intent iterationSeq ${raw.iterationSeq} is ahead of imported loop state ${options.maxIterationSeq}`);
  }
  if (!options.terminalEligible && raw.kind !== 'block') {
    throw new Error('Loop is not currently eligible for terminal complete/fail intents');
  }
}

function normalizeEvidence(evidence: readonly unknown[]): LoopTerminalIntentEvidence[] {
  return evidence.slice(0, 20).map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Evidence item ${index + 1} must be an object`);
    }
    const data = item as Record<string, unknown>;
    const kind = data['kind'];
    if (kind !== 'summary' && kind !== 'command' && kind !== 'file' && kind !== 'test' && kind !== 'note') {
      throw new Error(`Evidence item ${index + 1} has invalid kind`);
    }
    const label = readStringField(data, 'label').slice(0, 256);
    const value = readStringField(data, 'value').slice(0, 4096);
    return { kind, label, value };
  });
}

async function writeJsonAtomic(filePath: string, value: unknown, mode: number): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const handle = await fs.open(tmp, 'w', mode);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, filePath);
  const dirHandle = await fs.open(dir, 'r').catch(() => null);
  if (dirHandle) {
    try { await dirHandle.sync(); } finally { await dirHandle.close(); }
  }
}

async function archiveIntentFile(runtime: LoopControlRuntime, filePath: string, bucket: 'imported' | 'rejected'): Promise<void> {
  const archiveDir = path.join(runtime.controlDir, bucket);
  await fs.mkdir(archiveDir, { recursive: true, mode: 0o700 });
  const target = path.join(archiveDir, path.basename(filePath));
  await fs.rename(filePath, target).catch(async () => {
    await fs.rm(filePath, { force: true });
  });
}

async function ensureGitignoreEntry(workspace: string, entry: string): Promise<void> {
  const gitignore = path.join(workspace, '.gitignore');
  let existing = '';
  try {
    existing = await fs.readFile(gitignore, 'utf8');
  } catch {
    existing = '';
  }
  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(entry)) return;
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await fs.appendFile(gitignore, `${prefix}${entry}\n`, 'utf8');
}

async function pruneStaleLoopControlDirs(workspace: string, activeLoopRunIds: Set<string>): Promise<void> {
  const root = path.join(workspace, LOOP_CONTROL_DIR_NAME);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !activeLoopRunIds.has(entry.name))
    .map((entry) => fs.rm(path.join(root, entry.name), { recursive: true, force: true }).catch(() => undefined)));
}

async function resolveLoopControlCliPath(controlDir: string): Promise<string> {
  const binaryName = process.platform === 'win32' ? 'aio-loop-control.exe' : 'aio-loop-control';
  const resourcePath = typeof process.resourcesPath === 'string'
    ? path.join(process.resourcesPath, 'loop-control-cli', binaryName)
    : '';
  const candidates = [
    resourcePath,
    path.resolve('dist/loop-control-cli-sea', binaryName),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) return candidate;
  }

  const shimPath = path.join(controlDir, process.platform === 'win32' ? 'aio-loop-control.cmd' : 'aio-loop-control');
  const scriptCandidates = [
    path.resolve('dist/loop-control-cli/index.js'),
    path.resolve('dist/main/orchestration/loop-control-cli.js'),
  ];
  const scriptPath = scriptCandidates.find((candidate) => fsSync.existsSync(candidate)) ?? scriptCandidates[0];
  if (process.platform === 'win32') {
    await fs.writeFile(shimPath, `@echo off\r\nnode "${scriptPath}" %*\r\n`, { mode: 0o700 });
  } else {
    await fs.writeFile(shimPath, `#!/usr/bin/env sh\nexec node "${scriptPath}" "$@"\n`, { mode: 0o700 });
  }
  return shimPath;
}

async function readSizedJsonFile<T>(filePath: string, maxBytes: number): Promise<T> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink()) {
    throw new Error('JSON file must not be a symlink');
  }
  if (!stat.isFile()) {
    throw new Error('JSON path is not a regular file');
  }
  if (stat.size > maxBytes) {
    throw new Error(`JSON file exceeds ${maxBytes} byte cap`);
  }
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

async function realpathIfExists(target: string): Promise<string> {
  return fs.realpath(target).catch(() => path.resolve(target));
}

async function realpathOrCreateDir(target: string): Promise<string> {
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  return fs.realpath(target);
}

function isPathInside(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readRequiredEnv(env: NodeJS.ProcessEnv, key: keyof LoopControlEnv): string {
  const value = env[key];
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function readStringField(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function readNonnegativeIntegerField(data: Record<string, unknown>, key: string): number {
  const value = data[key];
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${key} must be a nonnegative integer`);
  }
  return value as number;
}
