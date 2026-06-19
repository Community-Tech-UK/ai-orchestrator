import { describe, expect, it } from 'vitest';
import { parseReviewerJson } from './agentic-pingpong-reviewer';
import { classifyPingPongSubjectHeuristic } from './pingpong-intent-classifier';

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
