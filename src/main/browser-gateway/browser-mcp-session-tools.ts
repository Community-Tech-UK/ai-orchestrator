import {
  booleanProp,
  objectSchema,
  profileIdProp,
  selectorProp,
  stringProp,
  targetIdProp,
} from './browser-mcp-schema-props';

/**
 * MCP schemas for the session sentinel tools: check_session and the persisted
 * login recipes it signs in with (see browser-login-recipe-store.ts).
 */

export const SESSION_TOOL_SCHEMAS = {
  'browser.check_session': objectSchema({
    profileId: profileIdProp,
    targetId: targetIdProp,
    autoRelogin: {
      ...booleanProp,
      description:
        'When logged out and a persisted re-login recipe exists for this origin (shared tabs share '
        + 'one recipe per computer), automatically re-login (navigate login URL, vault credential '
        + 'fill, optional 2FA, then re-verify from a LIVE snapshot; max 2 attempts, then a '
        + 'relogin_failed escalation is parked). Default true.',
    },
    campaignId: {
      ...stringProp,
      description: 'Campaign to attribute a parked escalation to.',
    },
  }, ['profileId', 'targetId']),
  'browser.remember_login_fingerprint': objectSchema({
    profileId: profileIdProp,
    origin: {
      ...stringProp,
      description: 'Origin the fingerprint belongs to (e.g. https://portal.example.gov.uk).',
    },
    loginUrl: {
      ...stringProp,
      description: 'Canonical login URL to navigate to when re-authentication is needed.',
    },
    loggedInMarkers: {
      type: 'array',
      items: stringProp,
      description:
        'Texts present ONLY when logged in (e.g. "Log out", the account name). Record this '
        + 'right after a successful login so browser.check_session can detect logouts. The '
        + 'recipe is persisted across restarts; for a shared tab it applies to every tab on '
        + 'that computer.',
    },
    relogin: objectSchema({
      vaultItemRef: {
        ...stringProp,
        description: 'Vault item reference to re-login with (never a secret).',
      },
      usernameSelector: selectorProp,
      passwordSelector: selectorProp,
      submitSelector: selectorProp,
      codeSelector: selectorProp,
      codeKind: { type: 'string', enum: ['totp', 'email_code'] },
    }, ['vaultItemRef', 'passwordSelector']),
  }, ['profileId', 'origin', 'loginUrl', 'loggedInMarkers']),
  'browser.list_login_recipes': objectSchema({
    profileId: {
      ...stringProp,
      description:
        'Optional tab or managed profile id. Resolved to its stable recipe scope (the node for '
        + 'a shared tab), so any tab on that computer lists the same recipes.',
    },
    origin: {
      ...stringProp,
      description: 'Optional origin filter, e.g. https://supplier.example.co.uk.',
    },
  }),
  'browser.forget_login_recipe': objectSchema({
    scope: {
      ...stringProp,
      description: 'Recipe scope exactly as browser.list_login_recipes returns it.',
    },
    origin: {
      ...stringProp,
      description: 'Recipe origin exactly as browser.list_login_recipes returns it.',
    },
  }, ['scope', 'origin']),
} as const;

const SESSION_TOOL_DESCRIPTIONS: Partial<Record<keyof typeof SESSION_TOOL_SCHEMAS, string>> = {
  'browser.list_login_recipes':
    'List persisted login fingerprints and re-login recipes used by browser.check_session. '
    + 'Recipes are keyed by stable scope (managed profile id, or the node for shared tabs) and origin, '
    + 'hold a vault item reference and selectors only (never a secret), and show the last check '
    + 'outcome, so you can see why an auto re-login did or did not run.',
  'browser.forget_login_recipe':
    'Delete one persisted login recipe by scope and origin (as listed by browser.list_login_recipes). '
    + 'Removes only the recipe; no credential, authorization or vault item is touched.',
};

export function sessionToolDescription(name: string): string | undefined {
  return SESSION_TOOL_DESCRIPTIONS[name as keyof typeof SESSION_TOOL_DESCRIPTIONS];
}
