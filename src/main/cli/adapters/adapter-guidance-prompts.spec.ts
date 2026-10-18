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

  // Chrome's HTTP Basic/Digest prompt is browser UI no form fill can reach;
  // without this line agents told James to type the password by hand.
  it('routes Chrome\'s own username/password prompt to browser.fill_http_auth, never a manual handoff', () => {
    expect(BROWSER_GATEWAY_SYSTEM_PROMPT).toContain('browser.fill_http_auth');
    expect(BROWSER_GATEWAY_SYSTEM_PROMPT).toContain('reported as `httpAuthChallenge`');
    expect(BROWSER_GATEWAY_SYSTEM_PROMPT).toContain('Do not ask the user to type it in Chrome');
    expect(BROWSER_GATEWAY_SYSTEM_PROMPT).toContain('browser.request_credential_access');
  });
});
