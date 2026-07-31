/**
 * PrCreationService — WS-B1 phase 1.
 *
 * Pushes a branch and opens a GitHub pull request via the `gh` CLI, gated
 * end-to-end so this outward-facing action is never a silent default:
 *
 *   Gate 1 (capability): per-project `allowPrCreation` opt-in setting.
 *     Off by default. Refuses with a typed `optIn` error and performs no
 *     side effects — no process is spawned.
 *   Gate 2 (authority): a `checkPermission()` call with
 *     `context.categoryHint: 'external_publish'` proves this request maps
 *     to WS-B3's never-delegable category (always forced to 'ask', before
 *     YOLO/rules/cache — see `approval-category.ts`). The actual block-until-
 *     answered gate is a durable approval record (`DurableApprovalStore`,
 *     `action_kind: 'pr_create'`) paired with an explicit user prompt; only
 *     an explicit approval proceeds. The push and the PR creation are a
 *     single user-visible action covered by this one approval — there is no
 *     second prompt between them.
 *
 * Only after both gates pass does execution begin: gh-auth pre-check,
 * branch-exists pre-check, push-if-no-upstream, then `gh pr create`. Every
 * process spawn uses array args (never shell string concatenation) and a
 * bounded timeout that kills the whole process group on expiry, matching
 * this campaign's P0.1 fix pattern.
 *
 * When `loopId` is supplied (the call originated from a loop's completion
 * surface), a successful PR URL is durably recorded as loop evidence via
 * `EvidenceStore` (kind: 'pr-created', state: 'fixed') — never invented,
 * never recorded on failure.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { dialog } from 'electron';
import { getLogger } from '../logging/logger';
import { killProcessGroup } from '../cli/adapters/base-cli-process-utils';
import { gitExec, gitExecSafe } from '../workspace/git/git-exec';
import { getSettingsManager } from '../core/config/settings-manager';
import { getPermissionManager } from '../security/permission-manager';
import type { PermissionDecision, PermissionRequest } from '../security/permission-manager';
import { getRLMDatabase } from '../persistence/rlm-database';
import { DurableApprovalStore } from '../orchestration/durable-approval-store';
import { EvidenceStore } from '../orchestration/evidence-store';

const logger = getLogger('PrCreationService');

const AUTH_CHECK_TIMEOUT_MS = 10_000;
const PUSH_TIMEOUT_MS = 60_000;
const PR_CREATE_TIMEOUT_MS = 30_000;
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

// ---- Public types -----------------------------------------------------------

export interface CreatePullRequestOptions {
  projectPath: string;
  branch: string;
  title: string;
  body?: string;
  baseBranch?: string;
  draft?: boolean;
  /** Instance requesting the PR, if any. Defaults to a fixed main-process id. */
  instanceId?: string;
  /** Present only when a loop initiated this call — the URL is recorded as loop evidence. */
  loopId?: string;
}

export type PrCreationFailureKind =
  | 'optIn'
  | 'permissionDenied'
  | 'authRequired'
  | 'ghMissing'
  | 'gitState'
  | 'timeout'
  | 'unknown';

export interface PrCreationFailure {
  kind: PrCreationFailureKind;
  message: string;
}

export type PrCreationResult =
  | { ok: true; url: string }
  | { ok: false; error: PrCreationFailure };

// ---- Injectable seams (testability) -----------------------------------------

export interface GhCommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Thrown by the default `runGh` implementation when the timeout fires. */
export class GhTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GhTimeoutError';
  }
}

export interface PrApprovalPromptDetails {
  projectPath: string;
  branch: string;
  baseBranch: string;
  title: string;
}

export interface PrCreationDeps {
  /** Returns the current per-project PR-creation opt-in map. */
  getAllowPrCreationMap: () => Record<string, boolean>;
  checkPermission: (request: PermissionRequest) => PermissionDecision;
  /** Blocks until the user answers. Resolves `true` only on an explicit allow. */
  askApproval: (details: PrApprovalPromptDetails) => Promise<boolean>;
  runGh: (args: string[], cwd: string, timeoutMs: number) => Promise<GhCommandResult>;
  branchExists: (branch: string, cwd: string) => Promise<boolean>;
  hasUpstream: (branch: string, cwd: string) => Promise<boolean>;
  gitPush: (branch: string, cwd: string) => Promise<void>;
  getApprovalStore: () => DurableApprovalStore;
  getEvidenceStore: () => EvidenceStore;
  now: () => number;
}

// ---- Default implementations -------------------------------------------------

/**
 * Canonicalize a project root for opt-in comparison. Resolves symlinks via
 * `fs.realpathSync` (2026-07-31 fresh-eyes WARNING fix) so a symlink alias of
 * a DIFFERENT, unapproved directory cannot be mistaken for an approved one —
 * `path.resolve` alone only normalizes `.`/`..`/relative segments and never
 * dereferences a symlink, so two lexically distinct paths could disagree with
 * their real target. Fail-closed: if the path cannot be resolved (missing,
 * permissions, loop), fall back to the plain-resolved form, which can then
 * only still match another equally-unresolvable, byte-identical raw string —
 * never a different, successfully-resolved real path. Mirrors
 * `canonicalizeProjectPluginRoot` in `project-plugin-trust.ts` (aligned by
 * the same fresh-eyes pass — that function shared this exact gap).
 */
function canonicalizeProjectRoot(root: string): string {
  const resolved = path.resolve(root);
  let real = resolved;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    real = resolved;
  }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/** Resolve the opt-in decision for `projectPath` against the settings map. Mirrors `resolveProjectPluginTrust`. */
export function resolvePrCreationOptIn(projectPath: string, map: Record<string, boolean>): boolean {
  const canonicalRoot = canonicalizeProjectRoot(projectPath);
  for (const [rawRoot, allowed] of Object.entries(map)) {
    if (canonicalizeProjectRoot(rawRoot) === canonicalRoot) {
      return allowed === true;
    }
  }
  return false;
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Extract the PR URL `gh pr create` prints to stdout on success. */
export function extractPrUrl(stdout: string): string | undefined {
  const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
  return lastLine && /^https:\/\//.test(lastLine) ? lastLine : undefined;
}

function isGhAuthError(stderr: string): boolean {
  return /gh auth login|not logged in|authentication/i.test(stderr);
}

/**
 * Run `gh <args>` with array args (no shell), a bounded timeout, and a
 * process-group kill on expiry (P0.1 fix pattern — a plain wrapper-PID kill
 * would leave `gh`'s browser/network children running past the deadline).
 */
function defaultRunGh(args: string[], cwd: string, timeoutMs: number): Promise<GhCommandResult> {
  return new Promise<GhCommandResult>((resolve, reject) => {
    const proc = spawn('gh', args, { cwd, detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (!killProcessGroup(proc.pid, 'SIGTERM')) {
        try {
          proc.kill('SIGTERM');
        } catch {
          // Process may already be gone.
        }
      }
    }, timeoutMs);

    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new GhTimeoutError(`gh ${args[0] ?? ''} timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

async function defaultBranchExists(branch: string, cwd: string): Promise<boolean> {
  const out = await gitExecSafe(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd);
  return out.length > 0;
}

async function defaultHasUpstream(branch: string, cwd: string): Promise<boolean> {
  const out = await gitExecSafe(
    ['for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`],
    cwd,
  );
  return out.trim().length > 0;
}

async function defaultGitPush(branch: string, cwd: string): Promise<void> {
  await gitExec(['push', '-u', 'origin', branch], cwd, PUSH_TIMEOUT_MS);
}

/** Native, blocking-until-answered confirmation. Never auto-approves. */
async function defaultAskApproval(details: PrApprovalPromptDetails): Promise<boolean> {
  const detail = [
    `Project: ${details.projectPath}`,
    `Branch: ${details.branch}`,
    `Base: ${details.baseBranch}`,
    `Title: ${details.title}`,
  ].join('\n');
  const result = await dialog.showMessageBox({
    type: 'warning',
    title: 'Publish pull request?',
    message: 'AI Orchestrator wants to push this branch and open a pull request on GitHub.',
    detail,
    buttons: ['Create pull request', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  return result.response === 0;
}

function defaultDeps(): PrCreationDeps {
  return {
    getAllowPrCreationMap: () => getSettingsManager().getAll().allowPrCreation ?? {},
    checkPermission: (request) => getPermissionManager().checkPermission(request),
    askApproval: defaultAskApproval,
    runGh: defaultRunGh,
    branchExists: defaultBranchExists,
    hasUpstream: defaultHasUpstream,
    gitPush: defaultGitPush,
    getApprovalStore: () => DurableApprovalStore.getInstance(getRLMDatabase().getRawDb()),
    getEvidenceStore: () => EvidenceStore.getInstance(getRLMDatabase().getDb()),
    now: () => Date.now(),
  };
}

// ---- Service ------------------------------------------------------------------

export class PrCreationService {
  private static instance: PrCreationService | null = null;

  constructor(private readonly deps: PrCreationDeps = defaultDeps()) {}

  static getInstance(): PrCreationService {
    if (!PrCreationService.instance) {
      PrCreationService.instance = new PrCreationService();
    }
    return PrCreationService.instance;
  }

  static _resetForTesting(): void {
    PrCreationService.instance = null;
  }

  async createPullRequest(options: CreatePullRequestOptions): Promise<PrCreationResult> {
    const instanceId = options.instanceId ?? 'main-process';

    // Gate 1 — per-project capability opt-in. Off by default; no side effects.
    const optedIn = resolvePrCreationOptIn(options.projectPath, this.deps.getAllowPrCreationMap());
    if (!optedIn) {
      return this.fail(
        'optIn',
        'PR creation is not enabled for this project. Enable "Allow PR creation" in project settings first.',
      );
    }

    // Gate 2 — never-delegable external_publish authority.
    const request: PermissionRequest = {
      id: crypto.randomUUID(),
      instanceId,
      scope: 'external_service',
      resource: `pr-create:${options.projectPath}#${options.branch}`,
      context: {
        workingDirectory: options.projectPath,
        categoryHint: 'external_publish',
      },
      timestamp: this.deps.now(),
    };
    const decision = this.deps.checkPermission(request);
    logger.info('PR creation permission decision', {
      action: decision.action,
      category: decision.category,
      decidedBy: decision.decidedBy,
      branch: options.branch,
    });

    // 2026-07-31 fresh-eyes WARNING fix: `decision.action` was logged but not
    // enforced. Branch explicitly instead of always asking:
    //   'deny'  -> refuse immediately, never prompt the user.
    //   'ask'   -> the expected outcome for a never-delegable category; proceed.
    //   'allow' -> should be structurally impossible here (external_publish
    //              always forces 'ask' — see approval-category.ts). Treat as
    //              an invariant violation: log it loudly but still fail safe
    //              by requiring the explicit ask rather than auto-approving.
    if (decision.action === 'deny') {
      return this.fail(
        'permissionDenied',
        decision.reason || 'PR creation was denied by permission policy.',
      );
    }
    if (decision.action !== 'ask') {
      logger.error(
        'PR creation permission decision was not "ask" for a never-delegable category — ' +
          'failing safe and still requiring an explicit user approval',
        undefined,
        { action: decision.action, category: decision.category, decidedBy: decision.decidedBy, branch: options.branch },
      );
    }

    const approvalId = crypto.randomUUID();
    const approvalStore = this.deps.getApprovalStore();
    approvalStore.create({
      approvalId,
      instanceId,
      actionKind: 'pr_create',
      payload: {
        projectPath: options.projectPath,
        branch: options.branch,
        baseBranch: options.baseBranch,
        title: options.title,
        category: decision.category,
        decidedBy: decision.decidedBy,
      },
      expiresAt: this.deps.now() + APPROVAL_TTL_MS,
    });

    // The single explicit approval covers push + PR create as one action —
    // only an explicit allow proceeds.
    const approved = await this.deps.askApproval({
      projectPath: options.projectPath,
      branch: options.branch,
      baseBranch: options.baseBranch ?? '(repository default)',
      title: options.title,
    });
    if (!approved) {
      approvalStore.resolve(approvalId, 'denied', 'user');
      return this.fail('permissionDenied', 'PR creation was not approved.');
    }
    approvalStore.resolve(approvalId, 'approved', 'user');

    return this.execute(options, instanceId);
  }

  private async execute(options: CreatePullRequestOptions, instanceId: string): Promise<PrCreationResult> {
    // Pre-check: gh authenticated.
    try {
      const authResult = await this.deps.runGh(['auth', 'status'], options.projectPath, AUTH_CHECK_TIMEOUT_MS);
      if (authResult.code !== 0) {
        return this.fail('authRequired', 'gh CLI is not authenticated. Run `gh auth login` and try again.');
      }
    } catch (err) {
      return this.classifySpawnError(err);
    }

    // Pre-check: branch exists locally.
    const exists = await this.deps.branchExists(options.branch, options.projectPath);
    if (!exists) {
      return this.fail('gitState', `Branch "${options.branch}" does not exist in ${options.projectPath}.`);
    }

    // Push if needed — external_publish-gated by the SAME approval above.
    try {
      const hasUpstream = await this.deps.hasUpstream(options.branch, options.projectPath);
      if (!hasUpstream) {
        await this.deps.gitPush(options.branch, options.projectPath);
      }
    } catch (err) {
      return this.fail('gitState', `Failed to push branch "${options.branch}": ${errorMessage(err)}`);
    }

    // Create the PR.
    try {
      const args = ['pr', 'create', '--title', options.title, '--body', options.body ?? '', '--head', options.branch];
      if (options.baseBranch) args.push('--base', options.baseBranch);
      if (options.draft) args.push('--draft');

      const result = await this.deps.runGh(args, options.projectPath, PR_CREATE_TIMEOUT_MS);
      if (result.code !== 0) {
        if (isGhAuthError(result.stderr)) {
          return this.fail('authRequired', result.stderr.trim() || 'gh CLI authentication required.');
        }
        return this.fail('unknown', result.stderr.trim() || `gh pr create exited with code ${result.code}`);
      }

      const url = extractPrUrl(result.stdout);
      if (!url) {
        return this.fail('unknown', 'gh pr create did not return a pull request URL.');
      }

      if (options.loopId) {
        this.recordEvidence(options.loopId, options.branch, url, instanceId, options.baseBranch);
      }
      return { ok: true, url };
    } catch (err) {
      return this.classifySpawnError(err);
    }
  }

  private classifySpawnError(err: unknown): PrCreationResult {
    if (isEnoent(err)) {
      return this.fail('ghMissing', 'The `gh` CLI was not found on PATH.');
    }
    if (err instanceof GhTimeoutError) {
      return this.fail('timeout', err.message);
    }
    return this.fail('unknown', errorMessage(err));
  }

  private recordEvidence(
    loopId: string,
    branch: string,
    url: string,
    instanceId: string,
    baseBranch?: string,
  ): void {
    this.deps.getEvidenceStore().record({
      loopId,
      target: branch,
      kind: 'pr-created',
      state: 'fixed',
      sourceMetadata: { url, branch, baseBranch, instanceId },
    });
  }

  private fail(kind: PrCreationFailureKind, message: string): PrCreationResult {
    logger.warn('PR creation failed', { kind, message });
    return { ok: false, error: { kind, message } };
  }
}

export function getPrCreationService(): PrCreationService {
  return PrCreationService.getInstance();
}

export function _resetPrCreationServiceForTesting(): void {
  PrCreationService._resetForTesting();
}
