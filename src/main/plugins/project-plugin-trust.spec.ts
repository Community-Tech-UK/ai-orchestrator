import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeProjectPluginRoot,
  resolveProjectPluginTrust,
} from './project-plugin-trust';

describe('resolveProjectPluginTrust', () => {
  it('defaults project plugin roots to ask when no trust decision exists', () => {
    const projectRoot = path.join(path.sep, 'repo');

    expect(resolveProjectPluginTrust(projectRoot, {})).toEqual({
      projectRoot,
      trust: 'ask',
      reason: 'No trust decision recorded for project plugins at this root.',
    });
  });

  it('returns trusted only for a matching canonical project root', () => {
    const projectRoot = path.join(path.sep, 'repo', 'nested', '..');
    const canonical = canonicalizeProjectPluginRoot(projectRoot);

    expect(resolveProjectPluginTrust(projectRoot, {
      projectPluginTrust: {
        [canonical]: 'trusted',
      },
    })).toEqual({
      projectRoot: canonical,
      trust: 'trusted',
      reason: 'Project plugin root is trusted in settings.',
    });
  });

  it('returns untrusted for an explicit reject decision', () => {
    const projectRoot = path.join(path.sep, 'repo');

    expect(resolveProjectPluginTrust(projectRoot, {
      projectPluginTrust: {
        [projectRoot]: 'untrusted',
      },
    })).toMatchObject({
      projectRoot,
      trust: 'untrusted',
      reason: 'Project plugin root is rejected in settings.',
    });
  });

  it('ignores malformed trust maps and falls back to ask', () => {
    const projectRoot = path.join(path.sep, 'repo');

    expect(resolveProjectPluginTrust(projectRoot, {
      projectPluginTrust: {
        [projectRoot]: 'yes-please',
      },
    })).toMatchObject({
      projectRoot,
      trust: 'ask',
    });
  });
});
