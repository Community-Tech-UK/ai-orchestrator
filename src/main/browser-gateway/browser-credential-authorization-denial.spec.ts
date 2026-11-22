import { describe, expect, it } from 'vitest';
import {
  buildCredentialAuthorizationDenial,
  formatAuthorizedOriginHosts,
  formatCredentialAuthorizationDenial,
} from './browser-credential-authorization-denial';

const NODE_ID = 'bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be';
const ORIGIN = 'https://education.app.jaggaer.com';

describe('formatAuthorizedOriginHosts', () => {
  it('renders exact hosts and wildcard grants, de-duplicated', () => {
    expect(
      formatAuthorizedOriginHosts([
        {
          allowedOrigins: [
            { scheme: 'https', hostPattern: 'uktrade.app.jaggaer.com', includeSubdomains: false },
            { scheme: 'https', hostPattern: 'example.gov.uk', includeSubdomains: true },
          ],
        },
        {
          allowedOrigins: [
            { scheme: 'https', hostPattern: 'uktrade.app.jaggaer.com', includeSubdomains: false },
          ],
        },
      ]),
    ).toEqual([
      'https://uktrade.app.jaggaer.com',
      'https://*.example.gov.uk',
    ]);
  });
});

describe('formatCredentialAuthorizationDenial', () => {
  it('keeps the machine prefix and tells the agent how to mint the missing grant', () => {
    const denial = formatCredentialAuthorizationDenial({
      toolName: 'browser.fill_credential',
      origin: ORIGIN,
      purpose: 'login',
      reason: 'origin_not_authorized',
      authorizedOrigins: ['https://uktrade.app.jaggaer.com'],
    });

    expect(denial.reason.startsWith('credential_not_authorized:origin_not_authorized:')).toBe(true);
    expect(denial.reason).toContain('browser.request_grant does not cover credential fill');
    expect(denial.reason).toContain('This scope already covers: https://uktrade.app.jaggaer.com');
    expect(denial.reason).toContain('browser.request_credential_access');
    expect(denial.reason).toContain('without the shell CLI connection');
    expect(denial.summary).not.toContain('credential_not_authorized');
    expect(denial.reason.length).toBeLessThanOrEqual(1000);
  });

  it('points a missing email_code permission at the approval request, not the refused CLI', () => {
    const denial = formatCredentialAuthorizationDenial({
      toolName: 'browser.fill_credential',
      origin: 'https://tap.tcsapps.com',
      purpose: 'email_code',
      reason: 'origin_not_authorized',
    });

    expect(denial.reason).toContain('browser.request_credential_access');
    expect(denial.reason).toContain('email_code');
    expect(denial.reason).toContain('senderDomains');
    expect(denial.reason).not.toContain('browser-credentials authorize');
  });

  it('sends secret_fill to James, never to an agent request or the CLI', () => {
    const denial = formatCredentialAuthorizationDenial({
      toolName: 'browser.fill_secret',
      origin: ORIGIN,
      purpose: 'secret_fill',
      reason: 'origin_not_authorized',
      detail: 'iban',
    });

    expect(denial.reason.startsWith('secret_not_authorized:origin_not_authorized:')).toBe(true);
    expect(denial.reason).toContain('(iban)');
    expect(denial.reason).toContain('Only James can allow this');
    expect(denial.reason).toContain('Browser Gateway > Permissions');
    expect(denial.reason).toContain('Agents cannot request secret_fill');
    expect(denial.reason).not.toContain('browser-credentials authorize');
  });

  it('points a missing register permission at a register approval request, not the CLI', () => {
    const denial = formatCredentialAuthorizationDenial({
      toolName: 'browser.create_agent_credential',
      origin: 'https://dashboard.uptimerobot.com',
      purpose: 'register',
      reason: 'origin_not_authorized',
    });

    expect(denial.reason.startsWith('credential_not_authorized:origin_not_authorized:')).toBe(true);
    expect(denial.reason).toContain('browser.request_credential_access');
    expect(denial.reason).toContain('purposes ["register"]');
    expect(denial.reason).toContain('origin https://dashboard.uptimerobot.com');
    expect(denial.reason).toContain('retry browser.create_agent_credential');
    expect(denial.reason).not.toContain('browser-credentials authorize');
    expect(denial.reason).not.toContain('$AIO_MCP');
  });
});

describe('buildCredentialAuthorizationDenial', () => {
  it('pulls standing origins from list() so a sibling Jaggaer tenant is visible', () => {
    const denial = buildCredentialAuthorizationDenial(
      () => [
        {
          allowedOrigins: [
            { scheme: 'https', hostPattern: 'uktrade.app.jaggaer.com', includeSubdomains: false },
          ],
        },
      ],
      {
        toolName: 'browser.fill_credential',
        origin: ORIGIN,
        purpose: 'login',
        reason: 'origin_not_authorized',
        scope: NODE_ID,
      },
    );

    expect(denial.reason).toContain('https://uktrade.app.jaggaer.com');
    expect(denial.reason).toContain(ORIGIN);
  });
});
