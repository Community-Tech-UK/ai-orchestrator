import { describe, expect, it } from 'vitest';

import { isPermissionDenialContent } from './claude-cli-permission-details';

describe('isPermissionDenialContent', () => {
  describe('true CLI permission denials', () => {
    it.each([
      "Claude requested permissions to use Bash, but you haven't granted it yet.",
      "Claude requested permissions to write to /tmp/out.txt, but you haven't granted it yet.",
      'Permission to use this tool hasn\'t been granted.',
      'This tool use is denied by permission rule Bash(rm:*).',
      'Tool use is not allowed in this session.',
      'You must grant permission to use this tool first.',
    ])('matches: %s', (content) => {
      expect(isPermissionDenialContent(content)).toBe(true);
    });
  });

  describe('command output that merely contains denial-sounding text', () => {
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
});
