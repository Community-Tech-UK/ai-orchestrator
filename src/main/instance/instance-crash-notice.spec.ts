import { describe, expect, it } from 'vitest';
import { describeProcessCrash } from './instance-crash-notice';

describe('describeProcessCrash', () => {
  it('replaces the raw exit text with a plain sentence that names the provider and what is kept', () => {
    const crash = describeProcessCrash('codex', 143, null);
    expect(crash.message).toBe(`${crash.presentation.headline} ${crash.presentation.whatToDo}`);
    expect(crash.message).toContain('Codex');
    expect(crash.message).toContain('Your message and the work above are kept.');
    expect(crash.message).not.toMatch(/exited unexpectedly|\b143\b|exit code|signal/i);
    expect(crash.presentation.category).toBe('provider-crash');
  });

  it('keeps the exit facts in the old words for Details and hooks, not for the screen', () => {
    expect(describeProcessCrash('claude', 1, null).rawDetail).toBe('Process exited unexpectedly with code 1');
    expect(describeProcessCrash('claude', null, 'SIGKILL').rawDetail).toBe('Process exited unexpectedly with signal SIGKILL');
    expect(describeProcessCrash('claude', null, null).rawDetail).toBe('Process exited unexpectedly with code unknown');
    expect(describeProcessCrash('claude', null, 'SIGKILL').message).not.toContain('SIGKILL');
    expect(describeProcessCrash('claude', 2, null).presentation.rawDetail).toBe('Process exited unexpectedly with code 2');
  });

  it('offers the button the crash notice offers', () => {
    expect(describeProcessCrash('gemini', 1, null).action).toBe('continue');
  });

  it('joins the hardened-mode advice on cleanly, without a stray full stop', () => {
    const advice = '. Hardened mode (Seatbelt) likely blocked file access. Use "Allow path & retry" on this session.';
    const crash = describeProcessCrash('claude', 1, null, advice);
    expect(crash.message).toContain('are kept. Hardened mode (Seatbelt) likely blocked file access.');
    expect(crash.message).not.toContain('..');
    expect(crash.rawDetail).not.toContain('Hardened');
  });

  it('does not name a provider it does not recognise', () => {
    const crash = describeProcessCrash('PRIVATE_PROVIDER_ID', 1, null);
    expect(crash.message).not.toContain('PRIVATE_PROVIDER_ID');
  });
});
