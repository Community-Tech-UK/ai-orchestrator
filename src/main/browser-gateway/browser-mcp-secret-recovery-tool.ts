import { objectSchema, stringProp } from './browser-mcp-schema-props';

const reference = { ...stringProp, minLength: 1, maxLength: 200 };

export const SECRET_RECOVERY_TOOL_SCHEMAS = {
  'browser.recover_secret_observation': objectSchema({
    profileId: reference,
    targetId: reference,
    reason: { ...stringProp, maxLength: 1000, description: 'Why access is needed, shown to the user.' },
    requestId: { ...reference, description: 'From an earlier call: report or finish that recovery.' },
  }, ['profileId', 'targetId']),
} as const;

export const SECRET_RECOVERY_TOOL_DESCRIPTION = 'After a read fails with browser_secret_observation_blocked_for_tainted_origin, '
  + 'ask the user in Harness to restore this task\'s access to that site\'s tabs. Returns approval_pending and a requestId; '
  + 'after approval Harness releases only the reviewed protection, verifies it and reports state and loginVerified. '
  + 'Call again with requestId for the result. Never returns page content. If the page still needs signing in, finish it yourself afterwards.';
