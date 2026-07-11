import { describe, expect, it, vi } from 'vitest';
import {
  assertNoSecretMaterial,
  runProcurementReview,
  SecretMaterialInPlanError,
  type ProcurementReviewer,
  type ProcurementReviewPlan,
} from './browser-procurement-review';

const PLAN: ProcurementReviewPlan = {
  origin: 'https://portal.example.gov.uk',
  targetId: 't1',
  fields: [
    { selector: '#account-number', secretType: 'bank_account_number', vaultItemRef: 'supplier-1', actionClass: 'financial_identity' },
    { selector: '#company', actionClass: 'input', sourceDocRef: 'doc:companies-house' },
  ],
  declarations: [{ selector: '#declaration', textHash: 'abcd1234' }],
};

const approve = (name: string): ProcurementReviewer => async () => ({ reviewer: name, approved: true, concerns: [] });
const reject = (name: string, concern: string): ProcurementReviewer => async () => ({
  reviewer: name,
  approved: false,
  concerns: [concern],
});

describe('runProcurementReview', () => {
  it('proceeds only when every reviewer approves', async () => {
    const outcome = await runProcurementReview(PLAN, [approve('security'), approve('workflow')]);
    expect(outcome.decision).toBe('approved');
    expect(outcome.verdicts).toHaveLength(2);
  });

  it('blocks (disagreement) when reviewers disagree', async () => {
    const outcome = await runProcurementReview(PLAN, [approve('security'), reject('workflow', 'field mapping off')]);
    expect(outcome.decision).toBe('blocked');
    expect(outcome.reason).toBe('reviewer_disagreement');
  });

  it('blocks (all rejected) when every reviewer rejects', async () => {
    const outcome = await runProcurementReview(PLAN, [reject('a', 'x'), reject('b', 'y')]);
    expect(outcome.decision).toBe('blocked');
    expect(outcome.reason).toBe('all_reviewers_rejected');
  });

  it('fails closed when a reviewer errors (never counts as approval)', async () => {
    const throwing: ProcurementReviewer = async () => {
      throw new Error('llm timeout');
    };
    const outcome = await runProcurementReview(PLAN, [approve('security'), throwing]);
    expect(outcome.decision).toBe('blocked');
    expect(outcome.reason).toBe('reviewer_error');
  });

  it('requires at least two independent reviewers', async () => {
    const outcome = await runProcurementReview(PLAN, [approve('only-one')]);
    expect(outcome.decision).toBe('blocked');
    expect(outcome.reason).toBe('insufficient_reviewers');
  });

  it('blocks and never calls reviewers when a plan contains secret material', async () => {
    const security = vi.fn(approve('security'));
    const workflow = vi.fn(approve('workflow'));
    const tainted = {
      ...PLAN,
      fields: [{ selector: '#iban', actionClass: 'financial_identity' as const, value: 'GB33BUKB20201555555555' }],
    } as unknown as ProcurementReviewPlan;

    const outcome = await runProcurementReview(tainted, [security, workflow]);
    expect(outcome.decision).toBe('blocked');
    expect(outcome.reason).toBe('secret_material_in_plan');
    expect(security).not.toHaveBeenCalled();
    expect(workflow).not.toHaveBeenCalled();
  });
});

describe('assertNoSecretMaterial', () => {
  it('passes a reference-only plan and throws (key only, no value) on leaked material', () => {
    expect(() => assertNoSecretMaterial(PLAN)).not.toThrow();

    const tainted = { ...PLAN, fields: [{ selector: '#x', actionClass: 'input' as const, password: 'hunter2' }] } as unknown as ProcurementReviewPlan;
    const error = (() => {
      try {
        assertNoSecretMaterial(tainted);
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(SecretMaterialInPlanError);
    expect((error as Error).message).not.toContain('hunter2');
  });
});
