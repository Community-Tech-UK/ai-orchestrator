import { describe, expect, it } from 'vitest';
import {
  androidReleaseWorkflowTemplate,
  iosReleaseWorkflowTemplate,
  newAppSetupWorkflowTemplate,
  builtInTemplates,
} from './index';

describe('release workflow templates', () => {
  it('registers iOS, Android, and new-app setup release workflows as built-ins', () => {
    const templates = new Map(builtInTemplates.map((template) => [template.id, template]));

    expect(templates.get('ios-release')).toBe(iosReleaseWorkflowTemplate);
    expect(templates.get('android-release')).toBe(androidReleaseWorkflowTemplate);
    expect(templates.get('new-app-setup')).toBe(newAppSetupWorkflowTemplate);
    expect([...templates.values()].filter((template) => template.category === 'release'))
      .toHaveLength(3);
  });

  it('makes recurring app releases API-first with explicit verification phases', () => {
    expect(iosReleaseWorkflowTemplate.phases.map((phase) => phase.id)).toEqual([
      'release-plan',
      'local-build-and-upload',
      'store-api-finalization',
      'verification',
      'summary',
    ]);
    expect(androidReleaseWorkflowTemplate.phases.map((phase) => phase.id)).toEqual([
      'release-plan',
      'local-build-and-upload',
      'play-api-finalization',
      'browser-console-gaps',
      'verification',
      'summary',
    ]);

    expect(iosReleaseWorkflowTemplate.phases[0].systemPromptAddition)
      .toContain('buildIosReleasePlan');
    expect(androidReleaseWorkflowTemplate.phases[0].systemPromptAddition)
      .toContain('buildAndroidReleasePlan');
    expect(iosReleaseWorkflowTemplate.phases[1].systemPromptAddition)
      .toContain('xcrun altool');
    expect(androidReleaseWorkflowTemplate.phases[2].systemPromptAddition)
      .toContain('Play Developer Publishing API');
  });

  it('makes console-only setup checkpointed and browser-gated', () => {
    expect(newAppSetupWorkflowTemplate.category).toBe('release');
    expect(newAppSetupWorkflowTemplate.phases.map((phase) => phase.id)).toEqual([
      'setup-plan',
      'campaign-lease',
      'play-console-setup',
      'asc-console-setup',
      'verification',
      'summary',
    ]);
    expect(newAppSetupWorkflowTemplate.phases[0].systemPromptAddition)
      .toContain('buildNewAppSetupPlan');
    expect(newAppSetupWorkflowTemplate.phases[1].systemPromptAddition)
      .toContain('browser.claim_campaign_lease');
    expect(newAppSetupWorkflowTemplate.phases[2].systemPromptAddition)
      .toContain('checkpoint');
    expect(newAppSetupWorkflowTemplate.phases[3].systemPromptAddition)
      .toContain('privacy nutrition labels');
  });
});
