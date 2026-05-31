import { describe, it, expect } from 'vitest';
import {
  critiqueSafety,
  claimsCompletion,
  mentionsVerification,
} from './safety-critic';

describe('safety-critic / critiqueSafety', () => {
  describe('destructive operations (blocking)', () => {
    const destructive = [
      'I will run rm -rf node_modules to clean up',
      'git push --force origin main',
      'git reset --hard HEAD~3',
      'git clean -fdx',
      'git branch -D feature/old',
      'DROP TABLE users;',
      'DELETE FROM accounts',
      'truncate table sessions',
      'dd if=/dev/zero of=/dev/sda',
      'mkfs.ext4 /dev/sdb1',
      'chmod -R 777 /var',
      'terraform destroy -auto-approve',
      'kubectl delete deployment api',
      'this will wipe the production database',
    ];
    for (const text of destructive) {
      it(`flags as blocking: "${text.slice(0, 32)}"`, () => {
        const c = critiqueSafety({ text });
        expect(c.approved).toBe(false);
        expect(c.blocking.some((o) => o.kind === 'destructive')).toBe(true);
      });
    }

    it('does NOT flag a scoped DELETE with a WHERE clause', () => {
      const c = critiqueSafety({ text: 'DELETE FROM accounts WHERE id = 42' });
      expect(c.blocking.some((o) => o.kind === 'destructive')).toBe(false);
    });

    it('does NOT flag an ordinary, safe command', () => {
      const c = critiqueSafety({ text: 'I ran the tests and they pass; ls -la shows the files' });
      expect(c.approved).toBe(true);
      expect(c.objections).toHaveLength(0);
    });
  });

  describe('credential material (warning, non-blocking)', () => {
    it('warns on .env access but does not block', () => {
      const c = critiqueSafety({ text: 'read the .env file to get the key' });
      expect(c.approved).toBe(true);
      expect(c.objections.some((o) => o.kind === 'credential')).toBe(true);
    });

    it('warns on private keys and ~/.ssh', () => {
      expect(critiqueSafety({ text: 'cat ~/.ssh/id_rsa' }).objections.some((o) => o.kind === 'credential')).toBe(true);
      expect(critiqueSafety({ text: 'use server.pem for TLS' }).objections.some((o) => o.kind === 'credential')).toBe(true);
    });

    it('warns on inline secret assignment', () => {
      const c = critiqueSafety({ text: 'set API_KEY=sk-12345 in the config' });
      expect(c.objections.some((o) => o.kind === 'credential')).toBe(true);
    });
  });

  describe('missing-evidence (blocking on unbacked completion claims)', () => {
    it('blocks a completion claim with no verification evidence', () => {
      const c = critiqueSafety({ text: 'Task complete — the feature is implemented.' });
      expect(c.approved).toBe(false);
      expect(c.blocking.some((o) => o.kind === 'missing-evidence')).toBe(true);
    });

    it('does NOT block a completion claim that cites tests', () => {
      const c = critiqueSafety({ text: 'Done — all 42 vitest tests pass and tsc is green.' });
      expect(c.blocking.some((o) => o.kind === 'missing-evidence')).toBe(false);
      expect(c.approved).toBe(true);
    });

    it('honors an explicit hasVerificationEvidence=false over inferred text', () => {
      const c = critiqueSafety({
        text: 'All done, the build compiles.', // text mentions "build"
        hasVerificationEvidence: false, // but caller knows nothing actually ran
      });
      expect(c.blocking.some((o) => o.kind === 'missing-evidence')).toBe(true);
    });

    it('honors an explicit hasVerificationEvidence=true', () => {
      const c = critiqueSafety({ text: 'Finished.', hasVerificationEvidence: true });
      expect(c.blocking.some((o) => o.kind === 'missing-evidence')).toBe(false);
    });

    it('does not raise missing-evidence when no completion is claimed', () => {
      const c = critiqueSafety({ text: 'Still investigating the failing case.' });
      expect(c.objections.some((o) => o.kind === 'missing-evidence')).toBe(false);
    });
  });

  describe('commands list + dedup + ordering', () => {
    it('scans the explicit commands array too', () => {
      const c = critiqueSafety({ text: 'cleaning up', commands: ['rm -rf /tmp/build', 'ls'] });
      expect(c.blocking.some((o) => o.kind === 'destructive')).toBe(true);
    });

    it('de-dups an objection matched in both text and commands', () => {
      const c = critiqueSafety({ text: 'rm -rf build', commands: ['rm -rf build'] });
      const destructives = c.objections.filter((o) => o.kind === 'destructive' && /force-delete/.test(o.message));
      expect(destructives).toHaveLength(1);
    });

    it('orders blocking objections before warnings', () => {
      const c = critiqueSafety({ text: 'read .env then rm -rf dist' });
      expect(c.objections[0]?.severity).toBe('blocking');
      expect(c.objections.some((o) => o.severity === 'warning')).toBe(true);
    });

    it('produces a useful summary', () => {
      expect(critiqueSafety({ text: 'ls -la' }).summary).toMatch(/no safety objections/);
      expect(critiqueSafety({ text: 'rm -rf x' }).summary).toMatch(/blocking safety objection/);
    });
  });

  describe('robustness', () => {
    it('handles empty input', () => {
      const c = critiqueSafety({ text: '' });
      expect(c.approved).toBe(true);
      expect(c.objections).toHaveLength(0);
    });
  });
});

describe('safety-critic / helpers', () => {
  it('claimsCompletion detects done-ish phrasing', () => {
    expect(claimsCompletion('task complete')).toBe(true);
    expect(claimsCompletion('it now works')).toBe(true);
    expect(claimsCompletion('still working on it')).toBe(false);
  });

  it('mentionsVerification detects test/build language', () => {
    expect(mentionsVerification('ran npm run test')).toBe(true);
    expect(mentionsVerification('tsc is green')).toBe(true);
    expect(mentionsVerification('I edited the file')).toBe(false);
  });
});
