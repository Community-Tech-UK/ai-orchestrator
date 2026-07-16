/**
 * Fable WS6 Task 4 — production wiring gate (loopSurfaceLessons).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const generate = vi.fn(async (_slot: string, _sys: string, _user: string) => ({ text: 'A lesson.', decision: { source: 'primary' } }));
const capture = vi.fn((_text: string) => ({ reinforced: false }));
let settings: { loopSurfaceLessons?: boolean } = {};

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => settings }),
}));
vi.mock('../rlm/auxiliary-llm-service', () => ({
  getAuxiliaryLlmService: () => ({ generate }),
}));
vi.mock('../memory/lesson-store', () => ({
  getLessonStore: () => ({ capture }),
}));

import { captureReviewLessonForVerdict } from './loop-review-lesson-capture-wiring';

const verdict = {
  reviewers: ['codex'],
  findings: [{ title: 'Bug', body: 'broken', severity: 'high', file: 'a.ts' }],
  summary: 'blocked',
};

function invoke() {
  captureReviewLessonForVerdict({ loopRunId: 'loop-1', goal: 'do the thing', kind: 'fresh-eyes', verdict });
}

afterEach(() => {
  generate.mockClear();
  capture.mockClear();
  settings = {};
});

describe('captureReviewLessonForVerdict', () => {
  it('captures a lesson when loopSurfaceLessons is unset (default ON)', async () => {
    invoke();
    await vi.waitFor(() => expect(capture).toHaveBeenCalledWith('A lesson.'));
    expect(generate).toHaveBeenCalledWith('memoryDistillation', expect.any(String), expect.any(String));
  });

  it('captures a lesson when loopSurfaceLessons is explicitly true', async () => {
    settings = { loopSurfaceLessons: true };
    invoke();
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
  });

  it('does NOT distill or capture when loopSurfaceLessons is false', () => {
    settings = { loopSurfaceLessons: false };
    invoke();
    expect(generate).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it('WS3: redacts secrets from both the distill prompt (egress) and the stored lesson (memory)', async () => {
    const fakeToken = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD';
    generate.mockResolvedValueOnce({
      text: `Never hardcode ${fakeToken} in configs.`,
      decision: { source: 'primary' },
    });
    captureReviewLessonForVerdict({
      loopRunId: 'loop-1',
      goal: 'do the thing',
      kind: 'fresh-eyes',
      verdict: {
        ...verdict,
        findings: [{ title: 'Leaked token', body: `found ${fakeToken} in diff`, severity: 'high' }],
      },
    });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    // Prompt sent to the (possibly remote) aux model must not contain the token.
    const sentPrompt = generate.mock.calls[0][2] as string;
    expect(sentPrompt).not.toContain(fakeToken);
    // Stored lesson must not contain the token either.
    const stored = capture.mock.calls[0][0] as string;
    expect(stored).not.toContain(fakeToken);
    expect(stored).toContain('[REDACTED — potential secret]');
  });
});
