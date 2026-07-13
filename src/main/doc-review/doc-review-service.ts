import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { getLogger } from '../logging/logger';
import { renderPlanArtifact } from './artifact-renderer';
import { DocReviewStore, type DocReviewStorePort } from './doc-review-store';
import {
  DOC_REVIEW_DIR_NAME,
  ensureDocReviewIgnored,
  parseArtifactMeta,
  validateArtifactPath,
} from './artifact-validator';
import type {
  DocReviewDeliveryCoordinator,
  CreateDocReviewSessionInput,
  DocReviewDeliveryAttempt,
  DocReviewInstanceSink,
  DocReviewOverall,
  DocReviewSession,
  SubmitDocReviewDecisionInput,
} from './doc-review.types';

const logger = getLogger('DocReviewService');

/** Event name emitted on any session change; consumed by the IPC handler layer. */
export const DOC_REVIEW_CHANGED_EVENT = 'doc-review:changed';

/** Decided sessions older than this are pruned on startup. */
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const OVERALL_LABEL: Record<DocReviewOverall, string> = {
  approved: 'APPROVED',
  changes_requested: 'CHANGES REQUESTED',
  rejected: 'REJECTED',
};

/**
 * Render the canonical feedback block agents consume. Built entirely from structured
 * decisions — never from raw artifact HTML (security gate #3).
 */
/**
 * Collapse newlines/tabs so one item never spills across lines and breaks the numbered
 * list. Covers every vertical separator — not just CR/LF but the Unicode line/paragraph
 * separators (U+2028/U+2029), NEL (U+0085), and VT/FF — so a crafted comment can't smuggle
 * a break that renders as a spurious numbered item in the feedback block downstream.
 */
function oneLine(value: string): string {
  return value.replace(/\s*[\r\n\u2028\u2029\u0085\v\f]+\s*/g, ' ').trim();
}

export function renderFeedbackBlock(
  session: DocReviewSession,
  input: SubmitDocReviewDecisionInput,
): string {
  const lines: string[] = [];
  lines.push(`## Document review feedback — ${oneLine(session.title)} (review ${session.id})`);
  lines.push(`Overall: ${OVERALL_LABEL[input.overall]}`);
  let n = 0;
  for (const decision of input.decisions) {
    const comment = decision.comment ? oneLine(decision.comment) : '';
    const selected = decision.choices?.length
      ? decision.choices
      : decision.choice
        ? [decision.choice]
        : [];
    if (!decision.decision && !comment && selected.length === 0) continue;
    n += 1;
    const verb =
      decision.decision === 'approve'
        ? 'approve'
        : decision.decision === 'reject'
          ? 'reject'
          : 'note';
    const title = oneLine(decision.title || decision.itemId);
    let line = `${n}. [${title}] ${verb}`;
    if (selected.length) line += ` — choice: ${selected.map(oneLine).join(', ')}`;
    if (comment) line += ` — ${comment}`;
    lines.push(line);
  }
  const general = input.generalComment ? oneLine(input.generalComment) : '';
  if (general) lines.push(`General: ${general}`);
  return lines.join('\n');
}

export class DocReviewService extends EventEmitter {
  private static instance: DocReviewService | null = null;
  /** Lazily created because the RLM database is initialized during app bootstrap. */
  private store: DocReviewStorePort | null = null;
  private sink: DocReviewInstanceSink | null = null;
  private deliveryCoordinator: DocReviewDeliveryCoordinator | null = null;
  private approvalRecorder: ((session: DocReviewSession) => void) | null = null;

  private constructor() {
    super();
  }

  private static storeFactory: () => DocReviewStorePort = () => new DocReviewStore();

  private getStore(): DocReviewStorePort {
    if (!this.store) {
      this.store = DocReviewService.storeFactory();
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

  static _setStoreFactoryForTesting(factory: (() => DocReviewStorePort) | null): void {
    this.storeFactory = factory ?? (() => new DocReviewStore());
  }

  /** Wire the sink used to push feedback into instances (called from initialization-steps). */
  setInstanceManager(sink: DocReviewInstanceSink): void {
    this.sink = sink;
  }

  /** Wire lifecycle-aware delivery after application services are initialized. */
  setDeliveryCoordinator(coordinator: DocReviewDeliveryCoordinator): void {
    this.deliveryCoordinator?.dispose?.();
    this.deliveryCoordinator = coordinator;
  }

  /** Wire an audit recorder invoked when a review is APPROVED (durable-approval store). */
  setApprovalRecorder(recorder: (session: DocReviewSession) => void): void {
    this.approvalRecorder = recorder;
  }

  private readSessions(): DocReviewSession[] {
    return this.getStore().list();
  }

  private writeSessions(sessions: DocReviewSession[]): void {
    const store = this.getStore();
    const nextIds = new Set(sessions.map((session) => session.id));
    for (const existing of store.list()) {
      if (!nextIds.has(existing.id)) store.remove(existing.id);
    }
    for (const session of sessions) store.put(session);
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
      origin: input.origin ?? {
        kind: 'instance',
        requestedInstanceId: input.instanceId,
        // Old MCP callers do not carry continuity fields. Keep an explicit
        // degraded value instead of silently treating the ephemeral id as a
        // durable identity; current application wiring always supplies these.
        historyThreadId: input.historyThreadId ?? input.instanceId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      },
      workspacePath: input.workspacePath,
      title: input.title,
      artifactPath: validation.resolvedPath,
      sourcePath: input.sourcePath || meta.source,
      status: 'pending',
      decisions: [],
      deliveryAttempts: [],
      createdAt: Date.now(),
    };
    this.getStore().put(session);
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
    origin?: CreateDocReviewSessionInput['origin'];
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
    // A date/title slug is readable but not unique: two loops can review the same
    // named plan on one day. Keep each submitted artifact immutable so a later
    // render cannot silently replace the document James actually reviewed.
    const artifactId = `${slug}-${randomUUID()}`;
    const reviewDir = join(input.workspacePath, DOC_REVIEW_DIR_NAME);
    await mkdir(reviewDir, { recursive: true });
    const artifactPath = join(reviewDir, `${artifactId}.html`);
    const html = renderPlanArtifact({
      title,
      markdown,
      reviewId: artifactId,
      sourcePath: input.planFile,
      generatedAt: input.generatedAt ?? new Date().toISOString(),
    });
    await writeFile(artifactPath, html, 'utf8');
    return this.createSession({
      instanceId: input.instanceId,
      origin: input.origin,
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
    const session = this.getStore().get(reviewId);
    if (!session) throw new Error(`Unknown review: ${reviewId}`);
    if (session.status !== 'pending') {
      throw new Error(`Review ${reviewId} was already decided`);
    }

    const block = renderFeedbackBlock(session, input);
    // Commit the human decision before delivery. A crash or lifecycle refusal
    // must leave a recoverable decided review, not erase James's work.
    session.status = input.overall;
    session.decisions = input.decisions;
    session.generalComment = input.generalComment?.trim() || undefined;
    session.decidedAt = Date.now();
    this.getStore().put(session);

    const dispatchingSession = this.persistDispatchingAttempt(reviewId);
    const attempt = await this.deliver(dispatchingSession, block);
    // Re-read after async delivery: a queued drain/retry may have appended an
    // attempt while the lifecycle operation was awaiting, and must not be lost.
    const deliveredSession = this.getStore().get(reviewId);
    if (!deliveredSession) throw new Error(`Review ${reviewId} was removed during delivery`);
    this.appendAttempt(deliveredSession, attempt);
    this.getStore().put(deliveredSession);
    if (deliveredSession.status === 'approved' && this.approvalRecorder) {
      try {
        this.approvalRecorder(deliveredSession);
      } catch (err) {
        logger.warn('Doc-review approval recorder failed', { error: String(err) });
      }
    }
    this.emitChanged('decided', deliveredSession);
    logger.info('Doc-review decision submitted', {
      reviewId,
      overall: input.overall,
    });
    return deliveredSession;
  }

  /** Append a later recovery attempt without reopening or mutating the decision. */
  appendDeliveryAttempt(reviewId: string, attempt: DocReviewDeliveryAttempt): DocReviewSession {
    const session = this.getStore().get(reviewId);
    if (!session) throw new Error(`Unknown review: ${reviewId}`);
    this.appendAttempt(session, attempt);
    this.getStore().put(session);
    this.emitChanged('delivery-updated', session);
    return session;
  }

  /** Keep the durable journal idempotent and derive the UI projection from its newest entry. */
  private appendAttempt(session: DocReviewSession, attempt: DocReviewDeliveryAttempt): void {
    if (!session.deliveryAttempts.some((candidate) => candidate.id === attempt.id)) {
      session.deliveryAttempts.push(attempt);
    }
    const latest = session.deliveryAttempts.at(-1);
    if (!latest) return;
    session.delivery = {
      status: latest.state,
      mechanism: latest.mechanism,
      attempts: session.deliveryAttempts.filter((candidate) => candidate.state !== 'dispatching').length,
      ...(latest.targetInstanceId ? { targetInstanceId: latest.targetInstanceId } : {}),
      ...(latest.error ? { lastError: latest.error } : {}),
    };
  }

  /**
   * Write an explicit handoff guard before touching an instance or loop. If the app dies
   * after the recipient accepted the message but before we record its outcome, startup
   * leaves this visible instead of guessing and silently sending the same review twice.
   */
  private persistDispatchingAttempt(reviewId: string): DocReviewSession {
    const session = this.getStore().get(reviewId);
    if (!session) throw new Error(`Unknown review: ${reviewId}`);
    const targetInstanceId = session.origin?.kind === 'instance'
      ? session.origin.requestedInstanceId
      : session.instanceId;
    this.appendAttempt(session, {
      id: `dra_${randomUUID()}`,
      state: 'dispatching',
      mechanism: 'none',
      targetInstanceId,
      at: Date.now(),
    });
    this.getStore().put(session);
    this.emitChanged('delivery-updated', session);
    return session;
  }

  /** Retry only decisions whose prior process stopped before or while safe delivery queued. */
  async recoverUndelivered(): Promise<void> {
    if (!this.deliveryCoordinator) return;
    for (const session of this.readSessions()) {
      if (session.status === 'pending') continue;
      const latest = session.deliveryAttempts.at(-1);
      if (latest && latest.state !== 'queued' && latest.state !== 'not-attempted') continue;
      const feedback = renderFeedbackBlock(session, {
        overall: session.status,
        decisions: session.decisions,
        generalComment: session.generalComment,
      });
      const dispatchingSession = this.persistDispatchingAttempt(session.id);
      const attempt = await this.deliver(dispatchingSession, feedback);
      this.appendDeliveryAttempt(session.id, attempt);
    }
  }

  /** Explicit user-requested retry for a decided review whose delivery failed. */
  async retryDelivery(reviewId: string): Promise<DocReviewSession> {
    const session = this.getSession(reviewId);
    if (!session) throw new Error(`Unknown review: ${reviewId}`);
    if (session.status === 'pending') {
      throw new Error(`Review ${reviewId} has not been decided`);
    }
    if (session.delivery?.status === 'delivered') return session;
    const feedback = renderFeedbackBlock(session, {
      overall: session.status,
      decisions: session.decisions,
      generalComment: session.generalComment,
    });
    const dispatchingSession = this.persistDispatchingAttempt(reviewId);
    const attempt = await this.deliver(dispatchingSession, feedback);
    return this.appendDeliveryAttempt(reviewId, attempt);
  }

  private async deliver(
    session: DocReviewSession,
    feedback: string,
  ): Promise<DocReviewDeliveryAttempt> {
    if (this.deliveryCoordinator) {
      try {
        return await this.deliveryCoordinator.deliver(session, feedback);
      } catch (error) {
        return failedDeliveryAttempt(error);
      }
    }
    if (!this.sink) {
      return failedDeliveryAttempt(new Error('Doc-review delivery is not wired to an instance manager'));
    }
    try {
      if (this.sink.deliverReviewDecision) {
        const result = await this.sink.deliverReviewDecision(session.instanceId, feedback);
        return {
          id: `dra_${randomUUID()}`,
          state: result.status,
          mechanism: result.mechanism,
          ...(result.targetInstanceId ? { targetInstanceId: result.targetInstanceId } : {}),
          ...(result.error ? { error: result.error } : {}),
          at: Date.now(),
        };
      }
      await this.sink.sendInput(session.instanceId, feedback);
      return {
        id: `dra_${randomUUID()}`,
        state: 'delivered',
        mechanism: 'direct-send',
        targetInstanceId: session.instanceId,
        at: Date.now(),
      };
    } catch (error) {
      return failedDeliveryAttempt(error);
    }
  }

  /** Remove a pending review without deciding it. */
  dismiss(reviewId: string): void {
    if (!this.getStore().remove(reviewId)) return;
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

  private emitChanged(kind: 'created' | 'decided' | 'delivery-updated', session: DocReviewSession): void {
    this.emit(DOC_REVIEW_CHANGED_EVENT, { kind, reviewId: session.id, session });
  }
}

function failedDeliveryAttempt(error: unknown): DocReviewDeliveryAttempt {
  return {
    id: `dra_${randomUUID()}`,
    state: 'failed',
    mechanism: 'none',
    error: error instanceof Error ? error.message : String(error),
    at: Date.now(),
  };
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
