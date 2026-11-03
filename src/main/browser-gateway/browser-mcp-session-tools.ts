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
    vaultItemRef: {
      ...stringProp,
      description: 'Optional saved account reference within the live portal. Required when that portal has several accounts; does not grant credential permission.',
    },
    autoRelogin: {
      ...booleanProp,
      description:
        'When logged out and a unique saved account matches the live portal URL on this computer, '
        + 'automatically re-login (navigate login URL, vault credential '
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
    targetId: {
      ...targetIdProp,
      description:
        'The tab whose live page is being recorded. Every marker is checked against that page before it is stored.',
    },
    origin: {
      ...stringProp,
      description: 'Origin the fingerprint belongs to (e.g. https://portal.example.gov.uk).',
    },
    loginUrl: {
      ...stringProp,
      description: 'Canonical login URL within the recorded origin and portal path; cross-origin SSO recipes are not supported.',
    },
    portalPath: {
      ...stringProp,
      description: 'Portal URL path prefix, e.g. /publicagroup. Defaults to the login URL directory; an inferred origin-wide path is refused for non-root URLs, so specify / explicitly for a single-tenant site. Both login URL and live recording page must be inside it. Matches whole path segments.',
    },
    loggedInMarkers: {
      type: 'array',
      items: stringProp,
      description:
        'Texts present on every signed-in page (the account name or "Log out"), not a heading '
        + 'that only one screen shows. Record this right after a successful login so '
        + 'browser.check_session can detect logouts. Each marker must be visible on the live '
        + 'targetId page or the recipe is refused. The recipe is persisted across restarts; '
        + 'for a shared tab it applies to the same portal/account on that computer.',
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
  }, ['profileId', 'targetId', 'origin', 'loginUrl', 'loggedInMarkers']),
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
    recipeId: {
      ...stringProp,
      description: 'Recipe id from browser.list_login_recipes. Required when scope and origin contain several recipes; deletes only this portal/account.',
    },
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
    + 'Recipes are keyed by stable scope (managed profile id, or the node for shared tabs), origin, portal path and saved account, '
    + 'hold a vault item reference and selectors only (never a secret), and show the last check '
    + 'outcome. A null portalPath marks a migrated legacy recipe: re-record it from the live '
    + 'portal before auto-login can use it.',
  'browser.forget_login_recipe':
    'Delete one persisted login recipe by scope, origin and recipeId (from browser.list_login_recipes). '
    + 'Removes only the recipe; no credential, authorization or vault item is touched.',
};

export function sessionToolDescription(name: string): string | undefined {
  return SESSION_TOOL_DESCRIPTIONS[name as keyof typeof SESSION_TOOL_DESCRIPTIONS];
}
