import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agenticPingPongReviewer,
  parseReviewerJson,
} from './agentic-pingpong-reviewer';
import { classifyPingPongSubjectHeuristic } from './pingpong-intent-classifier';

const runReviewSession = vi.hoisted(() => vi.fn());

vi.mock('./reviewer-session-spawner', () => ({
  getReviewerSessionSpawner: () => ({ runReviewSession }),
}));

vi.mock('../cli/cli-detection', () => ({
  detectAvailableClis: vi.fn(async () => [
    { name: 'claude', installed: true },
    { name: 'codex', installed: true },
  ]),
}));

vi.mock('../review/review-execution-host', () => ({
  resolveReviewerModelOverride: vi.fn(() => undefined),
}));

describe('parseReviewerJson', () => {
  it('extracts a fenced ```json block', () => {
    const out = 'Some analysis...\n```json\n{"verdict":"APPROVED","summary":"ok"}\n```\n';
    expect(parseReviewerJson(out)).toEqual({ verdict: 'APPROVED', summary: 'ok' });
  });

  it('prefers the LAST json block when multiple are present', () => {
    const out = '```json\n{"verdict":"CHANGES_REQUESTED"}\n```\nmore\n```json\n{"verdict":"APPROVED"}\n```';
    expect(parseReviewerJson(out)).toEqual({ verdict: 'APPROVED' });
  });

  it('tolerates trailing prose after the JSON object', () => {
    const out = '```json\n{"verdict":"APPROVED","summary":"done"}\n```\nThanks for reading!';
    expect(parseReviewerJson(out)).toMatchObject({ verdict: 'APPROVED' });
  });

  it('falls back to a bare {...} object with no fence', () => {
    const out = 'verdict below\n{"verdict":"CHANGES_REQUESTED","findings":[]}';
    expect(parseReviewerJson(out)).toMatchObject({ verdict: 'CHANGES_REQUESTED' });
  });

  it('returns null for empty or non-JSON output (fail-closed upstream)', () => {
    expect(parseReviewerJson('')).toBeNull();
    expect(parseReviewerJson('no json here, just prose')).toBeNull();
  });
});

describe('agenticPingPongReviewer', () => {
  beforeEach(() => {
    runReviewSession.mockReset();
  });

  it('classifies a Copilot monthly-quota notice as rate-limited without format repair', async () => {
    runReviewSession.mockResolvedValueOnce({
      outcome: 'settled',
      finalOutput: 'Error: You have exceeded your monthly quota (Request ID: <redacted>)',
      instanceId: 'rev-1',
      tokensUsed: 123,
      costCents: 4,
    });

    const result = await agenticPingPongReviewer({
      loopRunId: 'loop-1',
      workspaceCwd: '/repo',
      goal: 'finish the widget',
      subject: 'impl',
      builderProvider: 'claude',
      reviewerProviderSetting: 'copilot',
      triedReviewerProviders: [],
      ledger: [],
      roundNumber: 1,
      maxRounds: 15,
      blockingSeverities: ['critical', 'high'],
      timeoutMs: 90_000,
    });

    expect(result.verdict).toBe('UNRELIABLE');
    expect(result.fault).toBe('rate_limited');
    expect(result.reason).toContain('usage/rate-limit notice');
    expect(result.tokensUsed).toBe(123);
    expect(result.costCents).toBe(4);
    expect(runReviewSession).toHaveBeenCalledTimes(1);
  });

  it('repairs a prose reviewer answer into the required JSON before declaring the round unusable', async () => {
    const prose = 'I inspected src/widget.ts and ran npm test. No blocking issues remain.';
    runReviewSession
      .mockResolvedValueOnce({
        outcome: 'settled',
        finalOutput: prose,
        instanceId: 'rev-1',
        tokensUsed: 1000,
        costCents: 5,
      })
      .mockResolvedValueOnce({
        outcome: 'settled',
        finalOutput:
          '```json\n' +
          JSON.stringify({
            verdict: 'APPROVED',
            summary: 'No blocking issues remain.',
            completeness: {
              filesInspected: 1,
              commandsRun: 1,
              scopeCovered: 'src/widget.ts and npm test',
            },
            findings: [],
            ledger: [],
          }) +
          '\n```',
        instanceId: 'rev-repair',
        tokensUsed: 50,
        costCents: 1,
      });

    const result = await agenticPingPongReviewer({
      loopRunId: 'loop-1',
      workspaceCwd: '/repo',
      goal: 'finish the widget',
      subject: 'impl',
      builderProvider: 'claude',
      reviewerProviderSetting: 'codex',
      triedReviewerProviders: [],
      ledger: [],
      roundNumber: 1,
      maxRounds: 15,
      blockingSeverities: ['critical', 'high'],
      timeoutMs: 90_000,
    });

    expect(result.verdict).toBe('APPROVED');
    expect(result.tokensUsed).toBe(1050);
    expect(result.costCents).toBe(6);
    expect(runReviewSession).toHaveBeenCalledTimes(2);
    const initialPrompt = runReviewSession.mock.calls[0][0].prompt;
    const repairPrompt = runReviewSession.mock.calls[1][0].prompt;
    expect(initialPrompt).not.toContain('"APPROVED" | "CHANGES_REQUESTED"');
    expect(repairPrompt).not.toContain('"APPROVED" | "CHANGES_REQUESTED"');
    expect(repairPrompt).not.toContain('<int>');
    expect(repairPrompt).toContain('"verdict": "APPROVED"');
    expect(repairPrompt).toContain(prose);
  });

  it('classifies a format-repair timeout as reviewer availability, not malformed reviewer output', async () => {
    const prose = 'I inspected src/widget.ts and found the reviewer answer, but forgot JSON.';
    runReviewSession
      .mockResolvedValueOnce({
        outcome: 'settled',
        finalOutput: prose,
        instanceId: 'rev-1',
        tokensUsed: 1000,
        costCents: 5,
      })
      .mockResolvedValueOnce({
        outcome: 'timeout',
        finalOutput: '',
        instanceId: 'rev-repair',
        tokensUsed: 25,
        costCents: 1,
        error: 'Timed out waiting for instance rev-repair to settle',
      });

    const result = await agenticPingPongReviewer({
      loopRunId: 'loop-1',
      workspaceCwd: '/repo',
      goal: 'finish the widget',
      subject: 'impl',
      builderProvider: 'claude',
      reviewerProviderSetting: 'codex',
      triedReviewerProviders: [],
      ledger: [],
      roundNumber: 1,
      maxRounds: 15,
      blockingSeverities: ['critical', 'high'],
      timeoutMs: 90_000,
    });

    expect(result.verdict).toBe('UNRELIABLE');
    expect(result.fault).toBe('timeout');
    expect(result.spawnOutcome).toBe('timeout');
    expect(result.reason).toContain('reviewer format repair timeout');
    expect(result.tokensUsed).toBe(1025);
    expect(result.costCents).toBe(6);
  });

  it('classifies a format-repair failure as reviewer infrastructure, not malformed reviewer output', async () => {
    runReviewSession
      .mockResolvedValueOnce({
        outcome: 'settled',
        finalOutput: 'I inspected src/widget.ts and found no blocking issues, but forgot JSON.',
        instanceId: 'rev-1',
        tokensUsed: 1000,
        costCents: 5,
      })
      .mockResolvedValueOnce({
        outcome: 'failed',
        finalOutput: '',
        instanceId: 'rev-repair',
        tokensUsed: 10,
        costCents: 1,
        error: 'spawn failed',
      });

    const result = await agenticPingPongReviewer({
      loopRunId: 'loop-1',
      workspaceCwd: '/repo',
      goal: 'finish the widget',
      subject: 'impl',
      builderProvider: 'claude',
      reviewerProviderSetting: 'codex',
      triedReviewerProviders: [],
      ledger: [],
      roundNumber: 1,
      maxRounds: 15,
      blockingSeverities: ['critical', 'high'],
      timeoutMs: 90_000,
    });

    expect(result.verdict).toBe('UNRELIABLE');
    expect(result.fault).toBe('infra_error');
    expect(result.spawnOutcome).toBe('failed');
    expect(result.reason).toContain('reviewer format repair failed');
    expect(result.tokensUsed).toBe(1010);
    expect(result.costCents).toBe(6);
  });
});

describe('classifyPingPongSubjectHeuristic', () => {
  it('respects an explicit override', () => {
    expect(classifyPingPongSubjectHeuristic({ goal: 'whatever', override: 'plan' }).subject).toBe('plan');
  });

  it('classifies a planning goal as plan', () => {
    const r = classifyPingPongSubjectHeuristic({ goal: 'Write a design spec and plan for the new API' });
    expect(r.subject).toBe('plan');
  });

  it('classifies an implementation goal as impl', () => {
    const r = classifyPingPongSubjectHeuristic({ goal: 'Implement and fix the broken upload feature' });
    expect(r.subject).toBe('impl');
  });

  it('treats production changes as a strong impl signal', () => {
    const r = classifyPingPongSubjectHeuristic({ goal: 'design the thing', producedProductionChanges: true });
    expect(r.subject).toBe('impl');
    expect(r.confidence).toBeGreaterThan(0.8);
  });

  it('defaults to impl (safer) on an ambiguous goal', () => {
    expect(classifyPingPongSubjectHeuristic({ goal: 'do the needful' }).subject).toBe('impl');
  });
});
