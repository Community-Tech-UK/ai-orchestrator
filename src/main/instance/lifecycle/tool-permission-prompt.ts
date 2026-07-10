const TOOL_FAILURE_GUIDANCE =
  'Treat other tool failures as real errors (for example, invalid input, a failed command, or a missing dependency), not as hidden permission decisions.';

export function buildToolPermissionPrompt(yoloMode: boolean): string {
  if (yoloMode) {
    return '[Tool Permissions] Tools shown in your current tool list are pre-approved for this mode. ' +
      'When a relevant tool is available, use it directly. ' +
      'If a tool explicitly reports a permission denial, report that result accurately. ' +
      TOOL_FAILURE_GUIDANCE;
  }

  return '[Tool Permissions] Tools follow the current tool policy for this mode. ' +
    'When a relevant tool is available, use it directly. ' +
    'If a tool explicitly says approval is required, request approval through the provided mechanism. ' +
    'If a tool is denied, report that result accurately. ' +
    TOOL_FAILURE_GUIDANCE;
}
