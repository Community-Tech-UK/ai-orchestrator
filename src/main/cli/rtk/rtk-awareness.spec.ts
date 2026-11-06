import { describe, expect, it } from 'vitest';
import { RTK_AWARENESS_PROMPT, wrapRtkAwareness } from './rtk-awareness';

describe('RTK awareness prompt (A13, Step 18a)', () => {
  it('drops the proxy invitation and the evidence-summary line', () => {
    expect(RTK_AWARENESS_PROMPT).not.toContain('would lose required evidence');
    expect(RTK_AWARENESS_PROMPT).not.toContain('Do not substitute a summary for required source evidence');
  });

  it('scopes the prefix to the shell tool and out of scripts', () => {
    expect(RTK_AWARENESS_PROMPT).toContain(
      'Do not put `rtk` inside scripts, subprocess calls, pipelines, or any command whose output a program reads.',
    );
  });

  it('does not invite rtk proxy as a first-choice or evidence-preserving route', () => {
    expect(RTK_AWARENESS_PROMPT).not.toContain('Use `rtk proxy <cmd>` only when filtering is unsupported');
    expect(RTK_AWARENESS_PROMPT).not.toMatch(/filtering is unsupported/);
  });

  it('keeps the upstream guidance about when to re-run with rtk proxy', () => {
    expect(RTK_AWARENESS_PROMPT).toContain('only when its result is unusable');
    expect(RTK_AWARENESS_PROMPT).toContain('rtk gain');
    expect(RTK_AWARENESS_PROMPT).toContain('RTK_DISABLED=1');
  });

  it('wrapRtkAwareness keeps its delimiters and wraps the prompt', () => {
    const wrapped = wrapRtkAwareness();
    expect(wrapped.startsWith('[RTK AWARENESS]\n')).toBe(true);
    expect(wrapped.endsWith('\n[/RTK AWARENESS]')).toBe(true);
    expect(wrapped).toContain(RTK_AWARENESS_PROMPT);
  });
});
