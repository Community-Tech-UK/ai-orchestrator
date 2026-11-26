/**
 * Permission sentences from the Actual Claude source snapshot (October 2026):
 * utils/permissions/{filesystem,permissions}.ts, utils/messages.ts,
 * cli/structuredIO.ts, and tool permission checks. Keep source-owned sentences
 * separate from short legacy fallbacks: paths and denial guidance may be long.
 * The hook scripts in src/main/cli/hooks append their own "Harness is showing the user a card" guidance to the first
 * sentence; the adapter must still read that refusal as a denial.
 */
const CLI_DENIAL_SENTENCES: readonly RegExp[] = [
  /^This command requires approval\.?$/i,
  /^Claude requested permissions? to (?:use|write to|read from) [^\r\n]+, but you haven't granted it yet\.(?: Harness is showing the user a card for this call[\s\S]*)?$/i,
  /^Claude requested permissions? to (?:write to|read from) [^\r\n]+, which contains a suspicious Windows path pattern that requires manual approval\.$/i,
  /^Claude requested permissions? to read from [^\r\n]+, which appears to be a UNC path that could access network resources\.$/i,
  /^Claude requested permissions? to edit [^\r\n]+ which is a sensitive file\.$/i,
  /^Permission to use [\w:.$-]+ has been denied(?: because Claude Code is running in don't ask mode)?\.(?: IMPORTANT: You \*may\* attempt[\s\S]*)?$/i,
  /^Permission denied by (?:PermissionRequest hook|hook)$/i,
  /^Permission for this action has been denied\. Reason: [\s\S]+$/i,
  /^Permission for this tool use was denied\. The tool use was rejected \(eg\. if it was a file edit, the new_string was NOT written to the file\)\. (?:Try a different approach or report the limitation to complete your task\.|The user said:\n[\s\S]*)$/i,
  /^(?:MCPTool|WebSearchTool) requires permission\.$/i,
  /^Agent tool requires permission to spawn sub-agents\.$/i,
  /^Tool use is not allowed during compaction$/i,
];

// These older messages are exercised by the adapter's existing fixtures. Do
// not match their permission words inside a file, page, or command error.
const LEGACY_DENIAL_SENTENCES: readonly RegExp[] = [
  /^Permission denied[.!]?(?: Use \/allow to grant access\.)?$/i,
  /^Permission to use this tool hasn't been granted\.?$/i,
  /^This tool use is denied by permission rule [^\r\n]+$/i,
  /^Tool use is not allowed in this session\.?$/i,
  /^You must grant permission to use this tool first\.?$/i,
  /^(?:This tool|Tool)(?: use)? (?:is not approved|is not allowed|isn't allowed|is not permitted|is not authorized|requires permission|does not have permission)\b[^\r\n]*$/i,
];

export function matchesClaudeDenialSentence(content: string): boolean {
  const message = content.trim();
  // Executed Bash errors are command output, even if they quote a CLI refusal.
  if (/^exit code\s+\d+/i.test(message)) return false;
  if (CLI_DENIAL_SENTENCES.some(pattern => pattern.test(message))) return true;
  return message.length < 300
    && LEGACY_DENIAL_SENTENCES.some(pattern => pattern.test(message));
}
