import { describe, expect, it } from 'vitest';

import { doctorReportToJson, runSettingsDoctor } from './settings-doctor';
import type { SettingMetadata } from './settings-metadata.types';

const num: SettingMetadata = {
  key: 'contextWarningThreshold', label: 'Context warning', description: 'x',
  type: 'number', category: 'general', min: 10, max: 95,
};
const json: SettingMetadata = {
  key: 'computerUseAllowedAppsJson', label: 'Allowed apps', description: 'x',
  type: 'json', category: 'mcp',
};
const select: SettingMetadata = {
  key: 'notificationSoundMode', label: 'Sound', description: 'x',
  type: 'select', category: 'general',
  options: [{ value: 'always', label: 'Always' }, { value: 'never', label: 'Never' }],
};
const dir: SettingMetadata = {
  key: 'defaultWorkingDirectory', label: 'Default folder', description: 'x',
  type: 'directory', category: 'general',
};
const multi: SettingMetadata = {
  key: 'sessionFailoverProviders', label: 'Failover', description: 'x',
  type: 'multi-select', category: 'advanced', options: [{ value: 'codex', label: 'Codex' }],
};

function run(settings: Record<string, unknown>, metadata: SettingMetadata[], pathExists?: (p: string) => boolean) {
  return runSettingsDoctor({ settings, metadata, defaults: {}, pathExists });
}

describe('runSettingsDoctor (S5)', () => {
  it('reports a healthy configuration as healthy', () => {
    const report = run({ contextWarningThreshold: 80 }, [num]);
    expect(report.healthy).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it('catches a number below its own declared minimum', () => {
    const report = run({ contextWarningThreshold: 2 }, [num]);
    expect(report.errors).toBe(1);
    expect(report.findings[0]!.problem).toContain('below the minimum');
    expect(report.findings[0]!.fix).toContain('at least 10');
  });

  it('catches a number above its maximum', () => {
    expect(run({ contextWarningThreshold: 300 }, [num]).errors).toBe(1);
  });

  it('catches unparseable JSON and quotes the parser', () => {
    const report = run({ computerUseAllowedAppsJson: '["unclosed"' }, [json]);
    expect(report.errors).toBe(1);
    expect(report.findings[0]!.problem).toContain('Not valid JSON');
  });

  it('treats empty JSON as fine, since that means "use the default"', () => {
    expect(run({ computerUseAllowedAppsJson: '   ' }, [json]).healthy).toBe(true);
  });

  it('catches a select value that is not one of the choices', () => {
    const report = run({ notificationSoundMode: 'loud' }, [select]);
    expect(report.errors).toBe(1);
    expect(report.findings[0]!.fix).toContain('always, never');
  });

  it('notes an empty multi-select as off rather than broken', () => {
    const report = run({ sessionFailoverProviders: [] }, [multi]);
    expect(report.errors).toBe(0);
    expect(report.findings[0]!.severity).toBe('info');
  });

  it('warns about a folder that does not exist', () => {
    const report = run({ defaultWorkingDirectory: '/gone' }, [dir], () => false);
    expect(report.warnings).toBe(1);
    expect(report.findings[0]!.problem).toContain('does not exist');
  });

  /**
   * The load-bearing negative: with no checker we cannot tell, and inventing
   * "the path is fine" is the confident-wrong-answer this report exists to
   * prevent.
   */
  it('says nothing about a path when it cannot check', () => {
    expect(run({ defaultWorkingDirectory: '/whatever' }, [dir]).findings).toEqual([]);
  });

  it('flags a stored key the registry does not know about', () => {
    const report = run({ someRemovedKey: 1 }, []);
    expect(report.warnings).toBe(1);
    expect(report.findings[0]!.key).toBe('someRemovedKey');
  });

  it('does not flag a key the registry does know', () => {
    expect(run({ contextWarningThreshold: 80 }, [num]).findings).toEqual([]);
  });

  /** A report that buries a broken value under six notes is one nobody finishes. */
  it('puts errors before warnings before info', () => {
    const report = run(
      {
        sessionFailoverProviders: [],
        defaultWorkingDirectory: '/gone',
        contextWarningThreshold: 999,
      },
      [multi, dir, num],
      () => false,
    );
    expect(report.findings.map((f) => f.severity)).toEqual(['error', 'warning', 'info']);
  });
});

describe('doctorReportToJson', () => {
  it('emits stable machine-readable output for --json', () => {
    const report = run({ contextWarningThreshold: 1 }, [num]);
    const parsed = JSON.parse(doctorReportToJson(report));
    expect(parsed).toMatchObject({ healthy: false, errors: 1, warnings: 0 });
    expect(parsed.findings[0].key).toBe('contextWarningThreshold');
  });
});
