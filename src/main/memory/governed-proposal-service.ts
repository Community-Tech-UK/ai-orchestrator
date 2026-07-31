/**
 * GovernedProposalService — the workflow authority for the WS-A4 memory
 * promotion review inbox.
 *
 * Bridges two things that must never silently drift apart:
 *   - {@link LessonStore} — the in-memory, injection-time authority for what
 *     the agent actually sees (never persisted itself).
 *   - {@link GovernedProposalStore} — the durable, human-reviewable queue and
 *     its append-only `proposal_audit` decision trail.
 *
 * `captureMemoryProposal` is called in parallel with (never instead of) the
 * existing `LessonStore.capture()` call at the one production call site
 * (`loop-review-lesson-capture-wiring.ts`) — the direct lesson-capture path
 * is unchanged. This module only ever RAISES a proposal or REACTS to an
 * explicit operator decision; it never mutates a lesson's provenance except
 * through {@link approve}/{@link reject}/{@link rehydrate}, all of which are
 * gated by an explicit `proposal_audit` row.
 */

import { getLogger } from '../logging/logger';
import {
  getLessonStore,
  normalizeLessonText,
  type LessonProvenance,
} from './lesson-store';
import {
  getGovernedProposalStore,
  type CaptureProposalResult,
  type GovernedProposal,
} from './governed-proposal-store';

const logger = getLogger('GovernedProposalService');

const MAX_TITLE_CHARS = 120;

/** Thrown by {@link GovernedProposalService.approve}/{@link GovernedProposalService.reject}. */
export class GovernedProposalDecisionError extends Error {
  constructor(
    message: string,
    public readonly code: 'NOT_FOUND' | 'ALREADY_DECIDED',
  ) {
    super(message);
    this.name = 'GovernedProposalDecisionError';
  }
}

export interface CaptureMemoryProposalParams {
  /** Optional explicit title; derived from `text` when omitted. */
  title?: string;
  text: string;
  sourceSessionId?: string | null;
  sourceMessageId?: string | null;
  tags?: string[];
}

/** One example of the mined fail->fix pair backing a rule proposal (capped by the caller). */
export interface RuleProposalEvidence {
  sessionId: string;
  exampleFail: string;
  exampleFix: string;
}

/**
 * WS-B8: payload shape for `kind: 'rule'` governed proposals — a mined
 * fail->fix correction. `decidedLessonText`/`decidedProvenance` are set only
 * on approval (mirrors `ProposalPayload.decidedProvenance` for memory kind)
 * so {@link rehydrate} can replay the exact promoted text after a restart
 * without re-deriving formatting.
 */
export interface RuleProposalPayload {
  /** Base command family this rule applies to, e.g. "npm", "git". */
  baseCommand: string;
  errorClass: string;
  /** Representative example of the failing invocation. */
  pattern: string;
  /** Representative example of the correction that resolved it. */
  correction: string;
  /** How many matching fail->fix pairs this scan run found (this proposal's own reinforcements track cross-scan growth). */
  occurrences: number;
  confidence: number;
  evidence: RuleProposalEvidence[];
  decidedLessonText?: string;
  decidedProvenance?: LessonProvenance;
}

export interface CaptureRuleProposalParams {
  baseCommand: string;
  errorClass: string;
  pattern: string;
  correction: string;
  occurrences: number;
  confidence: number;
  evidence: RuleProposalEvidence[];
  sourceSessionId?: string | null;
}

const MAX_RULE_EVIDENCE = 3;

/** `When \`<pattern>\` fails with <errorClass>, use \`<correction>\` instead (observed N times).` */
function formatRuleLessonText(payload: RuleProposalPayload): string {
  const confidencePct = Math.round(payload.confidence * 100);
  return `When \`${payload.pattern}\` fails with ${payload.errorClass}, use \`${payload.correction}\` instead `
    + `(observed ${payload.occurrences}× this scan, ${confidencePct}% confidence).`;
}

export interface DecideProposalParams {
  rationale?: string;
  actor: string;
}

export interface ApproveProposalParams extends DecideProposalParams {
  /** When provided, approve as edit-then-approve (supersede semantics). */
  editedText?: string;
}

interface ProposalPayload {
  text: string;
  normalizedText: string;
  decidedProvenance?: LessonProvenance;
  originalText?: string;
}

function deriveTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_TITLE_CHARS ? `${oneLine.slice(0, MAX_TITLE_CHARS - 1)}…` : oneLine;
}

export class GovernedProposalService {
  private static instance: GovernedProposalService | null = null;

  static getInstance(): GovernedProposalService {
    if (!GovernedProposalService.instance) {
      GovernedProposalService.instance = new GovernedProposalService();
    }
    return GovernedProposalService.instance;
  }

  static _resetForTesting(): void {
    GovernedProposalService.instance = null;
  }

  // ---- Capture ---------------------------------------------------------

  /**
   * Raise (or reinforce) a governance proposal for an agent-derived memory
   * candidate. Fail-soft: never throws, returns null on any failure so a
   * governance-record write can never break the lesson-capture hot path.
   */
  captureMemoryProposal(params: CaptureMemoryProposalParams): CaptureProposalResult | null {
    try {
      const trimmedText = params.text.trim();
      const normalizedText = normalizeLessonText(trimmedText);
      if (!normalizedText) return null;

      const payload: ProposalPayload = { text: trimmedText, normalizedText };
      return getGovernedProposalStore().capture({
        kind: 'memory',
        normalizedTitle: normalizedText,
        title: params.title?.trim() || deriveTitle(trimmedText),
        provenance: 'agent-derived',
        payloadJson: JSON.stringify(payload),
        sourceSessionId: params.sourceSessionId ?? null,
        sourceMessageId: params.sourceMessageId ?? null,
        tagsJson: params.tags ? JSON.stringify(params.tags) : undefined,
      });
    } catch (err) {
      logger.warn('captureMemoryProposal failed (skipped)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * WS-B8: raise (or reinforce) a governance proposal for a mined fail->fix
   * correction. Unlike {@link captureMemoryProposal}, nothing is written to
   * {@link LessonStore} at capture time — a 'rule' proposal only reaches
   * prompts once a human approves it (see {@link approve}). Dedup key is
   * `baseCommand::errorClass` (not the example text), so repeated captures of
   * the same recurring mistake across scans reinforce one proposal instead of
   * creating near-duplicates keyed on incidental argument differences.
   * Fail-soft: never throws.
   */
  captureRuleProposal(params: CaptureRuleProposalParams): CaptureProposalResult | null {
    try {
      const baseCommand = params.baseCommand.trim();
      const pattern = params.pattern.trim();
      const correction = params.correction.trim();
      if (!baseCommand || !pattern || !correction) return null;

      const normalizedTitle = normalizeLessonText(`${baseCommand}::${params.errorClass}`);
      if (!normalizedTitle) return null;

      const payload: RuleProposalPayload = {
        baseCommand,
        errorClass: params.errorClass,
        pattern,
        correction,
        occurrences: Math.max(1, Math.floor(params.occurrences)),
        confidence: Math.min(1, Math.max(0, params.confidence)),
        evidence: params.evidence.slice(0, MAX_RULE_EVIDENCE),
      };

      return getGovernedProposalStore().capture({
        kind: 'rule',
        normalizedTitle,
        title: deriveTitle(`${pattern} → ${correction}`),
        provenance: 'agent-derived',
        payloadJson: JSON.stringify(payload),
        sourceSessionId: params.sourceSessionId ?? null,
      });
    } catch (err) {
      logger.warn('captureRuleProposal failed (skipped)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // ---- Decisions ---------------------------------------------------------

  /**
   * Approve a pending proposal.
   *  - No `editedText`: PROMOTE — the linked agent-derived lesson's
   *    provenance becomes `'user-approved'` in place.
   *  - With `editedText`: supersede — the original agent-derived lesson is
   *    deprecated and a NEW `'user-authored'` lesson is captured from the
   *    edited text.
   * Throws {@link GovernedProposalDecisionError} for an unknown id or a
   * proposal that is not `pending` (idempotent-decision guard).
   */
  approve(id: string, opts: ApproveProposalParams): GovernedProposal {
    const proposal = this.requirePending(id);
    if (proposal.kind === 'rule') {
      return this.approveRuleProposal(proposal, opts);
    }
    const now = Date.now();
    const payload = this.parsePayload(id);
    const editedText = opts.editedText?.trim();

    if (editedText) {
      this.deprecateLinkedLesson(payload.normalizedText);
      const { lesson } = getLessonStore().capture(editedText, now, 'user-authored');
      const finalPayload: ProposalPayload = {
        text: editedText,
        normalizedText: normalizeLessonText(editedText),
        decidedProvenance: 'user-authored',
        originalText: payload.text,
      };

      getGovernedProposalStore().writeAuditOnly(id, 'edited', {
        actor: opts.actor,
        reason: opts.rationale ?? null,
        metadataJson: JSON.stringify({ originalText: payload.text, editedText }),
      });

      const updated = getGovernedProposalStore().applyDecision(
        id,
        {
          status: 'approved',
          decidedAt: now,
          decidedBy: opts.actor,
          decisionRationale: opts.rationale ?? null,
          payloadJson: JSON.stringify(finalPayload),
        },
        {
          action: 'approved',
          actor: opts.actor,
          reason: opts.rationale ?? null,
          metadataJson: JSON.stringify({ lessonId: lesson.id }),
        },
      );
      if (!updated) throw new Error(`Failed to persist approval for proposal ${id}`);
      return updated;
    }

    this.applyLessonPromotion(payload.text, 'user-approved', now);
    const finalPayload: ProposalPayload = { ...payload, decidedProvenance: 'user-approved' };
    const updated = getGovernedProposalStore().applyDecision(
      id,
      {
        status: 'approved',
        decidedAt: now,
        decidedBy: opts.actor,
        decisionRationale: opts.rationale ?? null,
        payloadJson: JSON.stringify(finalPayload),
      },
      { action: 'approved', actor: opts.actor, reason: opts.rationale ?? null },
    );
    if (!updated) throw new Error(`Failed to persist approval for proposal ${id}`);
    return updated;
  }

  /**
   * WS-B8: approve a 'rule' proposal. Unlike memory kind (whose linked lesson
   * already exists at pending time), a rule proposal's LessonStore entry is
   * created here, for the first time, on approval — via the SAME
   * {@link applyLessonPromotion} helper memory approval uses, so it reaches
   * prompts through the one existing injection path
   * (`LessonStore.digest()` -> `loop-coordinator.ts`) rather than a new one.
   * `editedText` (when provided) replaces the auto-formatted lesson text
   * verbatim, same supersede-vs-promote semantics as the memory path.
   */
  private approveRuleProposal(proposal: GovernedProposal, opts: ApproveProposalParams): GovernedProposal {
    const now = Date.now();
    const payload = this.parseRulePayload(proposal);
    const editedText = opts.editedText?.trim();
    const lessonText = editedText || formatRuleLessonText(payload);
    const provenance: LessonProvenance = editedText ? 'user-authored' : 'user-approved';

    this.applyLessonPromotion(lessonText, provenance, now);

    if (editedText) {
      getGovernedProposalStore().writeAuditOnly(proposal.id, 'edited', {
        actor: opts.actor,
        reason: opts.rationale ?? null,
        metadataJson: JSON.stringify({ originalLessonText: formatRuleLessonText(payload), editedText }),
      });
    }

    const finalPayload: RuleProposalPayload = { ...payload, decidedLessonText: lessonText, decidedProvenance: provenance };
    const updated = getGovernedProposalStore().applyDecision(
      proposal.id,
      {
        status: 'approved',
        decidedAt: now,
        decidedBy: opts.actor,
        decisionRationale: opts.rationale ?? null,
        payloadJson: JSON.stringify(finalPayload),
      },
      { action: 'approved', actor: opts.actor, reason: opts.rationale ?? null },
    );
    if (!updated) throw new Error(`Failed to persist approval for proposal ${proposal.id}`);
    return updated;
  }

  /**
   * Reject a pending proposal. For `kind: 'memory'` the linked agent-derived
   * lesson (if still active) is deprecated. `kind: 'rule'` proposals never
   * have a linked lesson at pending time (see {@link captureRuleProposal}),
   * so there is nothing to deprecate. Throws
   * {@link GovernedProposalDecisionError} for an unknown id or a non-pending
   * proposal.
   */
  reject(id: string, opts: DecideProposalParams): GovernedProposal {
    const proposal = this.requirePending(id);
    const now = Date.now();
    if (proposal.kind !== 'rule') {
      const payload = this.parsePayload(id);
      this.deprecateLinkedLesson(payload.normalizedText);
    }

    const updated = getGovernedProposalStore().applyDecision(
      id,
      {
        status: 'rejected',
        decidedAt: now,
        decidedBy: opts.actor,
        decisionRationale: opts.rationale ?? null,
      },
      { action: 'rejected', actor: opts.actor, reason: opts.rationale ?? null },
    );
    if (!updated) throw new Error(`Failed to persist rejection for proposal ${id}`);
    return updated;
  }

  // ---- Startup: backfill + rehydrate --------------------------------------

  /**
   * One-time (per-database) historical backfill: any ACTIVE agent-derived
   * lesson in {@link LessonStore} that predates this feature (or arrived via
   * a path other than the governed capture hook) gets a pending proposal.
   * Guarded by whether a `'backfilled'` audit row has ever been written, so
   * repeated app starts are no-ops once the one-time pass has run.
   */
  backfillOnce(now: number = Date.now()): number {
    const store = getGovernedProposalStore();
    if (store.hasEverRun('backfilled')) return 0;

    let backfilled = 0;
    for (const lesson of getLessonStore().active()) {
      if (lesson.provenance !== 'agent-derived') continue;
      const normalizedText = normalizeLessonText(lesson.text);
      const payload: ProposalPayload = { text: lesson.text, normalizedText };
      const result = store.capture({
        kind: 'memory',
        normalizedTitle: normalizedText,
        title: deriveTitle(lesson.text),
        provenance: 'agent-derived',
        payloadJson: JSON.stringify(payload),
      });
      if (result && !result.reinforced) {
        store.writeAuditOnly(result.proposal.id, 'backfilled', {
          reason: 'startup backfill of pre-existing agent-derived lesson',
          metadataJson: JSON.stringify({ lessonId: lesson.id }),
        });
        backfilled += 1;
      }
    }
    logger.info('Governed proposal backfill complete', { backfilled });
    return backfilled;
  }

  /**
   * Replay every APPROVED memory/rule proposal into {@link LessonStore} with
   * its decided provenance. Required because LessonStore itself is in-memory
   * and does not survive a restart — without this, an approved/promoted
   * lesson would silently vanish from injection on the next boot. Idempotent:
   * reruns reinforce rather than duplicate. `skill`/`hook` kind proposals
   * have no LessonStore (or any) promotion target yet and are skipped.
   */
  rehydrate(now: number = Date.now()): number {
    const approved = getGovernedProposalStore().list({ status: 'approved', limit: 1000 });
    let rehydrated = 0;
    for (const proposal of approved) {
      try {
        if (proposal.kind === 'memory') {
          const payload = JSON.parse(proposal.payloadJson) as ProposalPayload;
          if (!payload.text) continue;
          this.applyLessonPromotion(payload.text, payload.decidedProvenance ?? 'user-approved', now);
          rehydrated += 1;
        } else if (proposal.kind === 'rule') {
          const payload = JSON.parse(proposal.payloadJson) as RuleProposalPayload;
          if (!payload.decidedLessonText) continue;
          this.applyLessonPromotion(payload.decidedLessonText, payload.decidedProvenance ?? 'user-approved', now);
          rehydrated += 1;
        }
      } catch (err) {
        logger.warn('rehydrate: failed to replay proposal', {
          proposalId: proposal.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    logger.info('Governed proposal rehydration complete', { rehydrated });
    return rehydrated;
  }

  /** Startup entry point: rehydrate first, then backfill any gaps. Fail-soft. */
  initialize(): void {
    try {
      this.rehydrate();
    } catch (err) {
      logger.warn('Governed proposal rehydration failed', { error: err instanceof Error ? err.message : String(err) });
    }
    try {
      this.backfillOnce();
    } catch (err) {
      logger.warn('Governed proposal backfill failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ---- Helpers -------------------------------------------------------------

  private requirePending(id: string): GovernedProposal {
    const proposal = getGovernedProposalStore().get(id);
    if (!proposal) {
      throw new GovernedProposalDecisionError(`Unknown governed proposal: ${id}`, 'NOT_FOUND');
    }
    if (proposal.status !== 'pending') {
      throw new GovernedProposalDecisionError(
        `Governed proposal ${id} was already decided (status=${proposal.status})`,
        'ALREADY_DECIDED',
      );
    }
    return proposal;
  }

  private parsePayload(id: string): ProposalPayload {
    const proposal = getGovernedProposalStore().get(id);
    const fallbackTitle = proposal?.title ?? id;
    try {
      const parsed = JSON.parse(proposal?.payloadJson ?? '{}') as Partial<ProposalPayload>;
      const text = parsed.text ?? fallbackTitle;
      return { text, normalizedText: parsed.normalizedText ?? normalizeLessonText(text) };
    } catch {
      return { text: fallbackTitle, normalizedText: normalizeLessonText(fallbackTitle) };
    }
  }

  private parseRulePayload(proposal: GovernedProposal): RuleProposalPayload {
    try {
      const parsed = JSON.parse(proposal.payloadJson) as Partial<RuleProposalPayload>;
      return {
        baseCommand: parsed.baseCommand ?? proposal.title,
        errorClass: parsed.errorClass ?? 'WrongSyntax',
        pattern: parsed.pattern ?? proposal.title,
        correction: parsed.correction ?? '',
        occurrences: parsed.occurrences ?? 1,
        confidence: parsed.confidence ?? 0,
        evidence: parsed.evidence ?? [],
      };
    } catch {
      return {
        baseCommand: proposal.title,
        errorClass: 'WrongSyntax',
        pattern: proposal.title,
        correction: '',
        occurrences: 1,
        confidence: 0,
        evidence: [],
      };
    }
  }

  private deprecateLinkedLesson(normalizedText: string): void {
    const lesson = getLessonStore().findActiveByNormalizedText(normalizedText);
    if (lesson) getLessonStore().deprecate(lesson.id);
  }

  /**
   * Set `provenance` on the active lesson matching `text` (by normalized
   * text), creating it first if it no longer exists in the in-memory store
   * (e.g. replaying an approval across a restart).
   */
  private applyLessonPromotion(text: string, provenance: LessonProvenance, now: number): void {
    const normalized = normalizeLessonText(text);
    const existing = getLessonStore().findActiveByNormalizedText(normalized);
    if (existing) {
      getLessonStore().setProvenance(existing.id, provenance, now);
      return;
    }
    const { lesson } = getLessonStore().capture(text, now, provenance);
    if (lesson.provenance !== provenance) {
      getLessonStore().setProvenance(lesson.id, provenance, now);
    }
  }
}

export function getGovernedProposalService(): GovernedProposalService {
  return GovernedProposalService.getInstance();
}
