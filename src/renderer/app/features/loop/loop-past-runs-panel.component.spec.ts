import { describe, expect, it } from 'vitest';
import { deriveReattemptSeed } from './loop-past-runs-panel.component';

/**
 * Tests for the pure reattempt-mapping helper that powers the
 * "Reattempt" button on each past loop run.
 *
 * Deliberately not a TestBed/component integration test: the project's
 * vitest config does not include the Angular compiler plugin, so
 * signal-based `input()` declarations don't generate the input metadata
 * `componentRef.setInput` needs. Other components in the codebase work
 * around this by exposing logic as pure functions and testing those
 * directly — same approach here.
 *
 * The component's `onReattempt(run)` is a thin wrapper around
 * {@link deriveReattemptSeed}: it short-circuits on disabled state, then
 * forwards the helper's output to `LoopPanelOpenerService.open`. The
 * forwarding is exercised end-to-end via the existing
 * `LoopPanelOpenerService` spec (which tests the open/consume contract)
 * and via manual UI testing.
 */
describe('deriveReattemptSeed', () => {
  it('splits goal + continuation when the past run had a distinct iterationPrompt', () => {
    const seed = deriveReattemptSeed({
      initialPrompt: 'implement feature X',
      iterationPrompt: 'continue with fresh eyes',
    });

    expect(seed).toEqual({
      seedMessage: 'implement feature X',
      seedPrompt: 'continue with fresh eyes',
    });
  });

  it('leaves textarea empty + seeds panel only when the past run reused a single prompt', () => {
    const seed = deriveReattemptSeed({
      initialPrompt: 'one prompt for everything',
      iterationPrompt: null,
    });

    expect(seed).toEqual({
      seedMessage: '',
      seedPrompt: 'one prompt for everything',
    });
  });

  it('treats iterationPrompt === initialPrompt as "no distinct continuation"', () => {
    const seed = deriveReattemptSeed({
      initialPrompt: 'same string',
      iterationPrompt: 'same string',
    });

    expect(seed).toEqual({
      seedMessage: '',
      seedPrompt: 'same string',
    });
  });

  it('treats an empty-string iterationPrompt as "no distinct continuation"', () => {
    const seed = deriveReattemptSeed({
      initialPrompt: 'goal',
      iterationPrompt: '',
    });

    expect(seed).toEqual({
      seedMessage: '',
      seedPrompt: 'goal',
    });
  });

  it('returns null when the run has no recorded prompt', () => {
    expect(
      deriveReattemptSeed({ initialPrompt: '', iterationPrompt: null }),
    ).toBeNull();
    expect(
      deriveReattemptSeed({ initialPrompt: '', iterationPrompt: 'continuation only' }),
    ).toBeNull();
  });
});
