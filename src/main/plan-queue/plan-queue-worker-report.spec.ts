import { describe, expect, it } from 'vitest';
import { REPORT_REQUIRED_PROVIDERS } from './plan-queue-worker-report';

describe('REPORT_REQUIRED_PROVIDERS', () => {
  // A provider joins this list only with a passing live check recorded in
  // docs/plans/2026-11-04-pq-b3-report-ready_livetest.md. copilot has not been run and gemini fails (LT-1037).
  it('names only the providers whose live check has passed', () => {
    expect([...REPORT_REQUIRED_PROVIDERS].sort()).toEqual(['claude', 'codex', 'cursor', 'opencode']);
  });
});
