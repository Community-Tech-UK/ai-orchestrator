import { describe, expect, it } from 'vitest';
import { assertRunOnNodeUsesWorkerBrowserSurface } from './run-on-node-support';

function refusal(prompt: string): string {
  try {
    assertRunOnNodeUsesWorkerBrowserSurface({ node: 'windows-pc', prompt });
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the prompt to be refused');
}

describe('run_on_node shared-browser refusal names its trigger', () => {
  it('names a marker and surface that are far apart, and still refuses', () => {
    const message = refusal(
      'Keep other existing fields unchanged in the LM Studio config. Do not open the LM Studio window.',
    );
    expect(message).toMatch(/stay on the coordinator/i);
    expect(message).toContain('because it contains "existing" and "window"');
    expect(message).toContain('if the task needs no browser, reword it without those words.');
  });

  it('names a Browser Gateway tool', () => {
    expect(refusal('Use browser.fill_credential on windows-pc.'))
      .toContain('because it contains "browser.fill_credential"');
  });

  it('names an explicit Browser Gateway mention', () => {
    expect(refusal('Use Browser Gateway to check the relay.'))
      .toContain('because it contains "browser gateway"');
  });

  it('names the action and surface behind a Chrome tab request', () => {
    expect(refusal('Click the Chrome tab.')).toContain('because it contains "click" and "chrome"');
  });

  it('allows the same work once the trigger words are gone', () => {
    expect(() => assertRunOnNodeUsesWorkerBrowserSurface({
      node: 'windows-pc',
      prompt: 'Keep other fields unchanged in the LM Studio config. Do not launch the LM Studio desktop app.',
    })).not.toThrow();
  });
});
