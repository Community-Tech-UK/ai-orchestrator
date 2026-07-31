import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { GovernedProposalStore, getGovernedProposalStore } from './governed-proposal-store';
import { _resetLessonStoreForTesting, getLessonStore } from './lesson-store';
import {
  GovernedProposalDecisionError,
  GovernedProposalService,
  getGovernedProposalService,
} from './governed-proposal-service';

const dbs: SqliteDriver[] = [];

function openMigratedDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  dbs.push(db);
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

function bindStore(): void {
  getGovernedProposalStore()._bindDatabaseForTesting(openMigratedDb());
}

describe('GovernedProposalService', () => {
  beforeEach(() => {
    GovernedProposalStore._resetForTesting();
    GovernedProposalService._resetForTesting();
    _resetLessonStoreForTesting();
    bindStore();
  });

  afterEach(() => {
    GovernedProposalStore._resetForTesting();
    GovernedProposalService._resetForTesting();
    _resetLessonStoreForTesting();
    for (const db of dbs.splice(0)) db.close();
  });

  it('captureMemoryProposal raises a pending proposal alongside an existing lesson capture', () => {
    const service = getGovernedProposalService();
    const { reinforced: lessonReinforced } = getLessonStore().capture('Always run typecheck before claiming done');
    expect(lessonReinforced).toBe(false);

    const result = service.captureMemoryProposal({
      text: 'Always run typecheck before claiming done',
      sourceSessionId: 'loop-run-1',
    });

    expect(result).not.toBeNull();
    expect(result!.proposal.kind).toBe('memory');
    expect(result!.proposal.status).toBe('pending');
    expect(result!.proposal.provenance).toBe('agent-derived');
    expect(result!.proposal.sourceSessionId).toBe('loop-run-1');
  });

  it('captureMemoryProposal reinforces rather than duplicates on re-capture of the same text', () => {
    const service = getGovernedProposalService();
    const first = service.captureMemoryProposal({ text: 'Reuse the connection pool' });
    const second = service.captureMemoryProposal({ text: '  Reuse   the connection POOL  ' });

    expect(first!.reinforced).toBe(false);
    expect(second!.reinforced).toBe(true);
    expect(second!.proposal.id).toBe(first!.proposal.id);
  });

  it('captureMemoryProposal is a no-op for empty/whitespace text', () => {
    const service = getGovernedProposalService();
    expect(service.captureMemoryProposal({ text: '   ' })).toBeNull();
  });

  it('approve() without editedText promotes the linked agent-derived lesson to user-approved', () => {
    const service = getGovernedProposalService();
    getLessonStore().capture('Cache the parsed AST between passes');
    const { proposal } = service.captureMemoryProposal({ text: 'Cache the parsed AST between passes' })!;

    const decided = service.approve(proposal.id, { actor: 'james', rationale: 'good generalization' });

    expect(decided.status).toBe('approved');
    expect(decided.decidedBy).toBe('james');
    expect(decided.decisionRationale).toBe('good generalization');

    const lesson = getLessonStore().findActiveByNormalizedText('cache the parsed ast between passes');
    expect(lesson).toBeDefined();
    expect(lesson!.provenance).toBe('user-approved');

    const audit = getGovernedProposalStore().getAuditTrail(proposal.id);
    expect(audit.map((a) => a.action)).toEqual(['created', 'approved']);
  });

  it('approve() with editedText deprecates the original lesson and captures a new user-authored one', () => {
    const service = getGovernedProposalService();
    getLessonStore().capture('Retry flaky network calls');
    const { proposal } = service.captureMemoryProposal({ text: 'Retry flaky network calls' })!;

    service.approve(proposal.id, { actor: 'james', editedText: 'Retry flaky network calls up to 3 times with backoff' });

    const original = getLessonStore().findActiveByNormalizedText('retry flaky network calls');
    expect(original).toBeUndefined(); // deprecated, no longer active

    const edited = getLessonStore().findActiveByNormalizedText('retry flaky network calls up to 3 times with backoff');
    expect(edited).toBeDefined();
    expect(edited!.provenance).toBe('user-authored');

    const audit = getGovernedProposalStore().getAuditTrail(proposal.id);
    expect(audit.map((a) => a.action)).toEqual(['created', 'edited', 'approved']);
  });

  it('reject() deprecates the linked agent-derived lesson', () => {
    const service = getGovernedProposalService();
    getLessonStore().capture('Never log secrets in plaintext');
    const { proposal } = service.captureMemoryProposal({ text: 'Never log secrets in plaintext' })!;

    const decided = service.reject(proposal.id, { actor: 'james', rationale: 'too specific to one incident' });

    expect(decided.status).toBe('rejected');
    const lesson = getLessonStore().findActiveByNormalizedText('never log secrets in plaintext');
    expect(lesson).toBeUndefined();
  });

  it('approve() on an unknown id throws NOT_FOUND', () => {
    const service = getGovernedProposalService();
    expect(() => service.approve('nope', { actor: 'james' })).toThrow(GovernedProposalDecisionError);
    try {
      service.approve('nope', { actor: 'james' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GovernedProposalDecisionError);
      expect((err as GovernedProposalDecisionError).code).toBe('NOT_FOUND');
    }
  });

  it('deciding an already-decided proposal throws ALREADY_DECIDED (idempotent-decision guard)', () => {
    const service = getGovernedProposalService();
    const { proposal } = service.captureMemoryProposal({ text: 'Guard idempotency in decision handlers' })!;
    service.approve(proposal.id, { actor: 'james' });

    expect(() => service.approve(proposal.id, { actor: 'james' })).toThrow(GovernedProposalDecisionError);
    expect(() => service.reject(proposal.id, { actor: 'james' })).toThrow(GovernedProposalDecisionError);
    try {
      service.reject(proposal.id, { actor: 'james' });
      expect.unreachable();
    } catch (err) {
      expect((err as GovernedProposalDecisionError).code).toBe('ALREADY_DECIDED');
    }
  });

  it('backfillOnce creates pending proposals for pre-existing agent-derived lessons, exactly once', () => {
    const service = getGovernedProposalService();
    getLessonStore().capture('Pre-existing lesson from before this feature shipped');
    getLessonStore().capture('Another pre-existing agent-derived lesson', Date.now(), 'user-authored');

    const first = service.backfillOnce();
    expect(first).toBe(1); // only the agent-derived one is backfilled

    const proposals = getGovernedProposalStore().list({ kind: 'memory' });
    expect(proposals).toHaveLength(1);
    const audit = getGovernedProposalStore().getAuditTrail(proposals[0].id);
    expect(audit.map((a) => a.action)).toEqual(['created', 'backfilled']);

    // Guarded: a second call is a no-op even if more agent-derived lessons appear.
    getLessonStore().capture('Yet another lesson that arrives after the guard trips');
    const second = service.backfillOnce();
    expect(second).toBe(0);
    expect(getGovernedProposalStore().list({ kind: 'memory' })).toHaveLength(1);
  });

  it('rehydrate() replays approved proposals into a fresh LessonStore with the decided provenance', () => {
    const service = getGovernedProposalService();
    getLessonStore().capture('Validate webhook signatures before processing');
    const { proposal } = service.captureMemoryProposal({ text: 'Validate webhook signatures before processing' })!;
    service.approve(proposal.id, { actor: 'james' });

    // Simulate a restart: LessonStore is in-memory only and does not survive one.
    _resetLessonStoreForTesting();
    expect(getLessonStore().active()).toHaveLength(0);

    const rehydrated = service.rehydrate();
    expect(rehydrated).toBe(1);

    const lesson = getLessonStore().findActiveByNormalizedText('validate webhook signatures before processing');
    expect(lesson).toBeDefined();
    expect(lesson!.provenance).toBe('user-approved');
  });

  it('rehydrate() is idempotent (does not duplicate on repeated calls)', () => {
    const service = getGovernedProposalService();
    getLessonStore().capture('Idempotent rehydration check');
    const { proposal } = service.captureMemoryProposal({ text: 'Idempotent rehydration check' })!;
    service.approve(proposal.id, { actor: 'james' });

    service.rehydrate();
    service.rehydrate();

    expect(getLessonStore().all().filter((l) => l.status === 'active')).toHaveLength(1);
  });

  // ---- WS-B8: rule-kind proposals (fail->fix mining) -----------------------

  const ruleParams = {
    baseCommand: 'npm',
    errorClass: 'UnknownFlag',
    pattern: 'npm test --flag-x',
    correction: 'npm test --flag-y',
    occurrences: 2,
    confidence: 0.6,
    evidence: [{ sessionId: 's1', exampleFail: 'npm test --flag-x', exampleFix: 'npm test --flag-y' }],
  };

  it('captureRuleProposal raises a pending proposal WITHOUT touching LessonStore', () => {
    const service = getGovernedProposalService();
    const result = service.captureRuleProposal(ruleParams);

    expect(result).not.toBeNull();
    expect(result!.proposal.kind).toBe('rule');
    expect(result!.proposal.status).toBe('pending');
    expect(result!.proposal.provenance).toBe('agent-derived');
    expect(getLessonStore().active()).toHaveLength(0);
  });

  it('captureRuleProposal dedupes by baseCommand::errorClass (not the example text)', () => {
    const service = getGovernedProposalService();
    const first = service.captureRuleProposal(ruleParams)!;
    const second = service.captureRuleProposal({
      ...ruleParams,
      pattern: 'npm test --flag-z', // different example text, same base+errorClass
      correction: 'npm test --flag-w',
    })!;

    expect(second.reinforced).toBe(true);
    expect(second.proposal.id).toBe(first.proposal.id);
    expect(second.proposal.reinforcements).toBe(2);
  });

  it('captureRuleProposal is a no-op when pattern/correction/baseCommand is blank', () => {
    const service = getGovernedProposalService();
    expect(service.captureRuleProposal({ ...ruleParams, pattern: '  ' })).toBeNull();
    expect(service.captureRuleProposal({ ...ruleParams, correction: '' })).toBeNull();
    expect(service.captureRuleProposal({ ...ruleParams, baseCommand: '' })).toBeNull();
  });

  it('approve() on a rule proposal creates a NEW user-approved lesson from formatted rule text', () => {
    const service = getGovernedProposalService();
    const { proposal } = service.captureRuleProposal(ruleParams)!;
    expect(getLessonStore().active()).toHaveLength(0);

    const decided = service.approve(proposal.id, { actor: 'james' });

    expect(decided.status).toBe('approved');
    const lessons = getLessonStore().active();
    expect(lessons).toHaveLength(1);
    expect(lessons[0].provenance).toBe('user-approved');
    expect(lessons[0].text).toContain('npm test --flag-x');
    expect(lessons[0].text).toContain('npm test --flag-y');

    const audit = getGovernedProposalStore().getAuditTrail(proposal.id);
    expect(audit.map((a) => a.action)).toEqual(['created', 'approved']);
  });

  it('approve() with editedText on a rule proposal uses the edited text verbatim (user-authored)', () => {
    const service = getGovernedProposalService();
    const { proposal } = service.captureRuleProposal(ruleParams)!;

    service.approve(proposal.id, { actor: 'james', editedText: 'Custom rule wording' });

    const lesson = getLessonStore().findActiveByNormalizedText('custom rule wording');
    expect(lesson).toBeDefined();
    expect(lesson!.provenance).toBe('user-authored');

    const audit = getGovernedProposalStore().getAuditTrail(proposal.id);
    expect(audit.map((a) => a.action)).toEqual(['created', 'edited', 'approved']);
  });

  it('reject() on a rule proposal never touches LessonStore (nothing was ever linked)', () => {
    const service = getGovernedProposalService();
    const { proposal } = service.captureRuleProposal(ruleParams)!;

    const decided = service.reject(proposal.id, { actor: 'james', rationale: 'too narrow' });

    expect(decided.status).toBe('rejected');
    expect(getLessonStore().active()).toHaveLength(0);
  });

  it('rehydrate() replays an approved rule proposal using the literal decided lesson text', () => {
    const service = getGovernedProposalService();
    const { proposal } = service.captureRuleProposal(ruleParams)!;
    service.approve(proposal.id, { actor: 'james' });

    const approvedProposal = getGovernedProposalStore().get(proposal.id)!;
    const decidedText = (JSON.parse(approvedProposal.payloadJson) as { decidedLessonText: string }).decidedLessonText;

    _resetLessonStoreForTesting();
    expect(getLessonStore().active()).toHaveLength(0);

    const rehydrated = service.rehydrate();
    expect(rehydrated).toBe(1);

    const lesson = getLessonStore().findActiveByNormalizedText(decidedText.toLowerCase());
    expect(lesson).toBeDefined();
    expect(lesson!.provenance).toBe('user-approved');
  });

  it('rehydrate() replays both memory and rule kinds together', () => {
    const service = getGovernedProposalService();
    getLessonStore().capture('A pre-existing memory lesson');
    const memory = service.captureMemoryProposal({ text: 'A pre-existing memory lesson' })!;
    service.approve(memory.proposal.id, { actor: 'james' });
    const rule = service.captureRuleProposal(ruleParams)!;
    service.approve(rule.proposal.id, { actor: 'james' });

    _resetLessonStoreForTesting();
    expect(service.rehydrate()).toBe(2);
    expect(getLessonStore().active()).toHaveLength(2);
  });
});
