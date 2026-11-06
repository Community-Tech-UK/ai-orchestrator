/**
 * Shared JSON-schema fragments for the Browser Gateway MCP tool definitions.
 */

export const stringProp = {
  type: 'string',
};
export const booleanProp = {
  type: 'boolean',
};
export const numberProp = {
  type: 'number',
};
export const profileIdProp = {
  ...stringProp,
  description: 'Browser Gateway profile id.',
};
export const targetIdProp = {
  ...stringProp,
  description: 'Browser Gateway target id.',
};
/** Optional on every tool that can raise an approval; the approval card shows it as the reason. */
export const reasonProp = {
  ...stringProp,
  description:
    'Why you are doing this, in one plain sentence. It is shown to the person who approves the '
    + 'action. Do not include passwords or other secrets.',
};
export const selectorProp = {
  ...stringProp,
  description:
    'CSS selector for the target page element. Optional when uid is provided '
    + '(a selector cannot resolve elements inside a closed shadow root).',
};

export function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}
