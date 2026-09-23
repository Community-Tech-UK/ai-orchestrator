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
