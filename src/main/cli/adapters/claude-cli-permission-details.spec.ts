import { describe, expect, it } from 'vitest';

import { extractPermissionDetails, isPermissionDenialContent, type ClaudeToolUseContext } from './claude-cli-permission-details';

describe('isPermissionDenialContent', () => {
  describe('true CLI permission denials', () => {
    it.each([
      "Claude requested permissions to use Bash, but you haven't granted it yet.",
      "Claude requested permissions to write to /tmp/out.txt, but you haven't granted it yet.",
      'Permission to use this tool hasn\'t been granted.',
      'This tool use is denied by permission rule Bash(rm:*).',
      'Tool use is not allowed in this session.',
      'You must grant permission to use this tool first.',
      'This command requires approval',
      'This command requires approval.',
      '  This command requires approval.\n',
      '  THIS COMMAND REQUIRES APPROVAL\n',
      // Source snapshot: utils/permissions/{filesystem,permissions}.ts.
      "Claude requested permissions to read from /example/file.txt, but you haven't granted it yet.",
      'Claude requested permissions to edit /example/file.txt which is a sensitive file.',
      'Claude requested permissions to write to C:\\example\\file.txt, which contains a suspicious Windows path pattern that requires manual approval.',
      'Claude requested permissions to read from C:\\example\\file.txt, which contains a suspicious Windows path pattern that requires manual approval.',
      'Claude requested permissions to read from //example/share/file.txt, which appears to be a UNC path that could access network resources.',
      'Permission to use Bash has been denied.',
      'Permission to use mcp__example__tool has been denied.',
      "Permission to use Bash has been denied because Claude Code is running in don't ask mode.",
      'Permission denied by hook',
      'Permission denied by PermissionRequest hook',
      // Source snapshot: utils/messages.ts; the source appends guidance/reasons.
      'Permission to use Read has been denied. IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal, e.g. using head instead of cat.',
      'Permission for this action has been denied. Reason: EXAMPLE_REASON. If you have other tasks that don\'t depend on this action, continue working on those.',
      'Permission for this tool use was denied. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). Try a different approach or report the limitation to complete your task.',
      'Permission for this tool use was denied. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). The user said:\nEXAMPLE_REASON',
      // Tool permission checks in MCPTool, WebSearchTool, AgentTool and compaction.
      'MCPTool requires permission.',
      'WebSearchTool requires permission.',
      'Agent tool requires permission to spawn sub-agents.',
      'Tool use is not allowed during compaction',
    ])('matches: %s', (content) => {
      expect(isPermissionDenialContent(content)).toBe(true);
    });
  });

  it('retains source-owned refusals even when their paths or guidance exceed the legacy cap', () => {
    expect(isPermissionDenialContent(
      `Claude requested permissions to read from /example/${'directory/'.repeat(35)}file.txt, but you haven't granted it yet.`,
    )).toBe(true);
    expect(isPermissionDenialContent(
      'Permission to use Bash has been denied. IMPORTANT: You *may* attempt ' + 'EXAMPLE_GUIDANCE '.repeat(30),
    )).toBe(true);
  });

  describe('command output that merely contains denial-sounding text', () => {
    it.each([
      'Exit code 1\nThis command requires approval',
      'deploy: This command requires approval',
      'The server says: This command requires approval',
      'This command requires approval from the deployment service',
      'This command requires approval\nServer refused deployment',
    ])('does not treat approval wording embedded in command output as a CLI denial: %s', (content) => {
      expect(isPermissionDenialContent(content)).toBe(false);
    });

    it.each([
      'Read failed: page says "you are not allowed to do that".',
      'The response was not authorized by the upstream server.',
      'A document says: "Permission to use Read has been denied."',
      '"Claude requested permissions to use Bash, but you haven\'t granted it yet."',
      'Documentation: Claude requested permissions to read a file.',
      'Operation not permitted',
      'Not authorized',
      'This tool returned a page saying you need permission.',
      'Tool use is not allowed: ' + 'EXAMPLE_TEXT '.repeat(30),
      'Permission denied\n' + 'EXAMPLE_OUTPUT '.repeat(30),
    ])('rejects quoted or generic errors: %s', content => {
      expect(isPermissionDenialContent(content)).toBe(false);
    });
    it('rejects executed Bash results (Exit code prefix) regardless of wording', () => {
      // Real incident (2026-07-17): remote grep on a root-owned .env produced a
      // Unix "Permission denied", got classified as a CLI denial, and restarted
      // a healthy YOLO session.
      expect(
        isPermissionDenialContent(
          'Exit code 2\n=== PROD ===\ngrep: /var/www/app-prod/.env: Permission denied\n'
            + '=== DEV ===\ngrep: /var/www/app-dev/.env: Permission denied',
        ),
      ).toBe(false);
      expect(
        isPermissionDenialContent('Exit code 255\nroot@203.0.113.7: Permission denied (publickey).'),
      ).toBe(false);
      expect(
        isPermissionDenialContent(
          'Exit code 1\nbash: line 1: /tmp/rk_1234: Permission denied\n'
            + "sed: can't read /tmp/rk_1234: Permission denied",
        ),
      ).toBe(false);
      // Even a real-sounding grant phrase after an exit code is command output.
      expect(
        isPermissionDenialContent("Exit code 1\ncurl: (22) The requested URL hasn't been granted"),
      ).toBe(false);
    });

    it('rejects Unix-style "<prefix>: Permission denied" without an exit-code header', () => {
      expect(isPermissionDenialContent('cat: /etc/shadow: Permission denied')).toBe(false);
      expect(
        isPermissionDenialContent('deploy@198.51.100.9: Permission denied (publickey,password).'),
      ).toBe(false);
    });

    it('still matches a bare CLI-style "Permission denied" message', () => {
      expect(isPermissionDenialContent('Permission denied. Use /allow to grant access.')).toBe(true);
    });
  });

  it('requires a known original tool use when called with runtime context', () => {
    const contexts = new Map<string, ClaudeToolUseContext>([
      ['example-read', { name: 'Read', input: { file_path: '/example/file.txt' } }],
    ]);
    const content = "Claude requested permissions to read from /example/file.txt, but you haven't granted it yet.";
    expect(isPermissionDenialContent(content, 'example-read', contexts)).toBe(true);
    expect(isPermissionDenialContent(content, 'example-missing', contexts)).toBe(false);
    expect(isPermissionDenialContent(content, undefined, contexts)).toBe(false);
  });
});


describe('human denial echo', () => {
  it('does not turn a Harness refusal or a deny note into another card', () => {
    expect(isPermissionDenialContent('Harness: the user declined this call. Permission denied. Use another way.')).toBe(false);
  });
});

describe('extractPermissionDetails targets', () => {
  it('drops the preposition from "read from <path>"', () => {
    const details = extractPermissionDetails(
      "Claude requested permissions to read from /tmp/protected/data.txt, but you haven't granted it yet.",
      undefined,
      new Map(),
    );
    expect(details).toMatchObject({ action: 'read', path: '/tmp/protected/data.txt' });
  });

  it('keeps the real Bash command as the path and a shortened label for display', () => {
    const details = extractPermissionDetails(
      'This command requires approval',
      'toolu_1',
      new Map([['toolu_1', { name: 'Bash', input: { command: 'rtk proxy pwd', description: 'Print directory' } }]]),
    );
    expect(details).toEqual({ action: 'bash', path: 'rtk proxy pwd', displayPath: 'command (13 chars)' });
  });
});
