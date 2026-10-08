import { describe, expect, it } from 'vitest';
import { BROWSER_GATEWAY_SYSTEM_PROMPT } from './adapter-guidance-prompts';

describe('BROWSER_GATEWAY_SYSTEM_PROMPT', () => {
  // The offload guard refuses to fall back to this Mac when the user's browser
  // computer is unavailable; every provider must turn that into a question for
  // the user, not a silent retry on this computer.
  it('tells every provider to ask the user before using this computer when the browser computer is offline', () => {
    expect(BROWSER_GATEWAY_SYSTEM_PROMPT).toContain('browser_remote_computer_offline');
    expect(BROWSER_GATEWAY_SYSTEM_PROMPT).toContain('ask whether to use this computer instead, wait, or skip the browser step');
    expect(BROWSER_GATEWAY_SYSTEM_PROMPT).toContain('Retry with computer: "local" only after the user agrees');
  });
});
