import ElectronStore from 'electron-store';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { getLogger } from '../logging/logger';
import { renderPlanArtifact } from './artifact-renderer';
import {
  DOC_REVIEW_DIR_NAME,
  ensureDocReviewIgnored,
  parseArtifactMeta,
  validateArtifactPath,
} from './artifact-validator';
import type {
  CreateDocReviewSessionInput,
  DocReviewInstanceSink,
  DocReviewOverall,
  DocReviewSession,
  DocReviewStoreShape,
  SubmitDocReviewDecisionInput,
} from './doc-review.types';

const logger = getLogger('DocReviewService');

/** Event name emitted on any session change; consumed by the IPC handler layer. */
export const DOC_REVIEW_CHANGED_EVENT = 'doc-review:changed';

const STORE_VERSION = 1;
const DEFAULT_STORE: DocReviewStoreShape = { version: STORE_VERSION, sessions: [] };

/** Decided sessions older than this are pruned on startup. */
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

interface Store<T> {
  get<K extends keyof T>(key: K): T[K];
  set<K extends keyof T>(key: K, value: T[K]): void;
  set(object: Partial<T>): void;
}

const OVERALL_LABEL: Record<DocReviewOverall, string> = {
  approved: 'APPROVED',
  changes_requested: 'CHANGES REQUESTED',
  rejected: 'REJECTED',
};

/**
 * Render the canonical feedback block agents consume. Built entirely from structured
 * decisions — never from raw artifact HTML (security gate #3).
 */
export function renderFeedbackBlock(
  session: DocReviewSession,
  input: SubmitDocReviewDecisionInput,
): string {
  const lines: string[] = [];
  lines.push(`## Document review feedback — ${session.title} (review ${session.id})`);
  lines.push(`Overall: ${OVERALL_LABEL[input.overall]}`);
  let n = 0;
  for (const decision of input.decisions) {
    const comment = decision.comment?.trim();
    if (!decision.decision && !comment) continue;
    n += 1;
    const verb =
      decision.decision === 'approve'
        ? 'approve'
        : decision.decision === 'reject'
          ? 'reject'
          : 'note';
    const title = decision.title || decision.itemId;
    let line = `${n}. [${title}] ${verb}`;
    if (comment) line += ` — ${comment}`;
    lines.push(line);
  }
  const general = input.generalComment?.trim();
  if (general) lines.push(`General: ${general}`);
  return lines.join('\n');
}

export class DocReviewService extends EventEmitter {
  private static instance: DocReviewService | null = null;
  /** Lazily created — constructing ElectronStore needs the electron app, so we defer it
   *  until a session is actually read/written (wiring the sink/recorder must not touch it). */
  private store: Store<DocReviewStoreShape> | null = null;
  private sink: DocReviewInstanceSink | null = null;
  private approvalRecorder: ((session: DocReviewSession) => void) | null = null;

  private constructor() {
    super();
  }

  private getStore(): Store<DocReviewStoreShape> {
    if (!this.store) {
      this.store = new ElectronStore<DocReviewStoreShape>({
        name: 'doc-reviews',
        defaults: DEFAULT_STORE,
      }) as unknown as Store<DocReviewStoreShape>;
      this.pruneDecided();
    }
    return this.store;
  }

  static getInstance(): DocReviewService {
    if (!this.instance) {
      this.instance = new DocReviewService();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  /** Wire the sink used to push feedback into instances (called from initialization-steps). */
  setInstanceManager(sink: DocReviewInstanceSink): void {
    this.sink = sink;
  }

  /** Wire an audit recorder invoked when a review is APPROVED (durable-approval store). */
  setApprovalRecorder(recorder: (session: DocReviewSession) => void): void {
    this.approvalRecorder = recorder;
  }

  private readSessions(): DocReviewSession[] {
    return this.getStore().get('sessions') ?? [];
  }

  private writeSessions(sessions: DocReviewSession[]): void {
    this.getStore().set('sessions', sessions);
  }

  listSessions(status?: DocReviewSession['status']): DocReviewSession[] {
    const sessions = this.readSessions();
    return status ? sessions.filter((s) => s.status === status) : sessions;
  }

  getSession(reviewId: string): DocReviewSession | undefined {
    return this.readSessions().find((s) => s.id === reviewId);
  }

  /**
   * Create a pending review session for the calling instance. Validates the artifact
   * path is inside `.aio-review/` and the file parses as a v1 artifact, and self-heals
   * the workspace .gitignore.
   */
  async createSession(input: CreateDocReviewSessionInput): Promise<DocReviewSession> {
    const validation = validateArtifactPath(input.workspacePath, input.artifactPath);
    if (!validation.ok) {
      throw new Error(`Invalid artifact path: ${validation.reason}`);
    }
    const html = await readFile(validation.resolvedPath, 'utf8');
    const meta = parseArtifactMeta(html);
    if (!meta.isArtifact) {
      throw new Error(
        'Artifact is not a doc-review artifact (missing <meta name="aio-doc-review" content="v1">)',
      );
    }
    void ensureDocReviewIgnored(input.workspacePath);

    const session: DocReviewSession = {
      id: `dr_${randomUUID()}`,
      instanceId: input.instanceId,
      workspacePath: input.workspacePath,
      title: input.title,
      artifactPath: validation.resolvedPath,
      sourcePath: input.sourcePath || meta.source,
      status: 'pending',
      decisions: [],
      createdAt: Date.now(),
    };
    const sessions = this.readSessions();
    sessions.push(session);
    this.writeSessions(sessions);
    this.emitChanged('created', session);
    logger.info('Doc-review session created', {
      reviewId: session.id,
      instanceId: session.instanceId,
      title: session.title,
    });
    return session;
  }

  /**
   * Render a plan/spec Markdown file into an artifact under `.aio-review/` and create a
   * pending review for it (Phase 3 loop auto-review). Used when a loop stops needing human
   * review and has a plan file but no artifact yet.
   */
  async createReviewFromPlan(input: {
    instanceId: string;
    workspacePath: string;
    planFile: string;
    title?: string;
    generatedAt?: string;
  }): Promise<DocReviewSession> {
    const planPath = isAbsolute(input.planFile)
      ? input.planFile
      : join(input.workspacePath, input.planFile);
    const markdown = await readFile(planPath, 'utf8');
    const title = input.title || deriveTitle(markdown, input.planFile);
    const slug = `${todayStamp()}-${slugify(title)}`;
    const reviewDir = join(input.workspacePath, DOC_REVIEW_DIR_NAME);
    await mkdir(reviewDir, { recursive: true });
    const artifactPath = join(reviewDir, `${slug}.html`);
    const html = renderPlanArtifact({
      title,
      markdown,
      reviewId: slug,
      sourcePath: input.planFile,
      generatedAt: input.generatedAt ?? new Date().toISOString(),
    });
    await writeFile(artifactPath, html, 'utf8');
    return this.createSession({
      instanceId: input.instanceId,
      workspacePath: input.workspacePath,
      title,
      artifactPath,
      sourcePath: input.planFile,
    });
  }

  /** Re-validate the stored path and return the resolved file (for reads / open-external). */
  resolveArtifactFile(reviewId: string): string {
    const session = this.getSession(reviewId);
    if (!session) throw new Error(`Unknown review: ${reviewId}`);
    const validation = validateArtifactPath(session.workspacePath, session.artifactPath);
    if (!validation.ok) {
      throw new Error(`Artifact no longer valid: ${validation.reason}`);
    }
    return validation.resolvedPath;
  }

  /** Read the validated artifact HTML for a session (re-validates the stored path). */
  async readArtifact(reviewId: string): Promise<string> {
    return readFile(this.resolveArtifactFile(reviewId), 'utf8');
  }

  /**
   * Record James's decisions, push the canonical feedback block into the requesting
   * instance, and mark the session decided.
   */
  async submitDecision(
    reviewId: string,
    input: SubmitDocReviewDecisionInput,
  ): Promise<DocReviewSession> {
    const sessions = this.readSessions();
    const session = sessions.find((s) => s.id === reviewId);
    if (!session) throw new Error(`Unknown review: ${reviewId}`);
    if (session.status !== 'pending') {
      throw new Error(`Review ${reviewId} was already decided`);
    }

    const block = renderFeedbackBlock(session, input);
    if (!this.sink) {
      throw new Error('Doc-review is not wired to an instance manager');
    }
    await this.sink.sendInput(session.instanceId, block);

    session.status = input.overall;
    session.decisions = input.decisions;
    session.generalComment = input.generalComment?.trim() || undefined;
    session.decidedAt = Date.now();
    this.writeSessions(sessions);
    if (session.status === 'approved' && this.approvalRecorder) {
      try {
        this.approvalRecorder(session);
      } catch (err) {
        logger.warn('Doc-review approval recorder failed', { error: String(err) });
      }
    }
    this.emitChanged('decided', session);
    logger.info('Doc-review decision submitted', {
      reviewId,
      overall: input.overall,
    });
    return session;
  }

  /** Remove a pending review without deciding it. */
  dismiss(reviewId: string): void {
    const sessions = this.readSessions();
    const next = sessions.filter((s) => s.id !== reviewId);
    if (next.length === sessions.length) return;
    this.writeSessions(next);
    this.emit(DOC_REVIEW_CHANGED_EVENT, { kind: 'dismissed', reviewId });
  }

  /** Prune decided sessions older than PRUNE_AFTER_MS. */
  pruneDecided(now = Date.now()): void {
    const sessions = this.readSessions();
    const kept = sessions.filter((s) => {
      if (s.status === 'pending') return true;
      const decidedAt = s.decidedAt ?? s.createdAt;
      return now - decidedAt < PRUNE_AFTER_MS;
    });
    if (kept.length !== sessions.length) {
      this.writeSessions(kept);
    }
  }

  private emitChanged(kind: 'created' | 'updated' | 'decided', session: DocReviewSession): void {
    this.emit(DOC_REVIEW_CHANGED_EVENT, { kind, reviewId: session.id, session });
  }
}

function deriveTitle(markdown: string, planFile: string): string {
  const heading = /^#\s+(.+?)\s*$/m.exec(markdown);
  if (heading) return heading[1].slice(0, 200);
  return basename(planFile).replace(/\.[^.]+$/, '') || 'Document review';
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'review';
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getDocReviewService(): DocReviewService {
  return DocReviewService.getInstance();
}

export { DOC_REVIEW_DIR_NAME };
