import { describe, expect, it } from 'vitest';
import { listAutomationTemplates } from './automation-templates';

describe('automation templates', () => {
  it('lists the built-in templates with explicit output expectations', () => {
    const templates = listAutomationTemplates();

    expect(templates.map((template) => template.id)).toEqual([
      'daily-repo-health',
      'dependency-audit',
      'open-pr-review-sweep',
      'weekly-project-summary',
      'log-triage',
      'test-stabilizer',
      'contract-alias-sync-audit',
      'fresh-clone-onboarding',
      'docs-sweep',
      'production-error-sweep',
    ]);
    for (const template of templates) {
      expect(template.prompt).toContain('Return a concise summary');
      expect(template.suggestedSchedule.type).toBe('cron');
      expect(template.tags.length).toBeGreaterThan(0);
    }
  });

  it('keeps borrowed loop recipes bounded by the authoring template lines', () => {
    const templates = listAutomationTemplates();
    const borrowedRecipes = [
      'test-stabilizer',
      'contract-alias-sync-audit',
      'fresh-clone-onboarding',
      'docs-sweep',
      'production-error-sweep',
    ];

    for (const id of borrowedRecipes) {
      const template = templates.find((item) => item.id === id);

      expect(template, id).toBeDefined();
      const lines = template!.prompt.split('\n');

      expect(lines[0], `${id} objective line`).toMatch(/^OBJECTIVE: /);
      expect(lines[1], `${id} checks line`).toMatch(/^CHECKS: /);
      expect(lines[2], `${id} stop line`).toMatch(/^STOP: /);
      expect(lines[2], `${id} done stop`).toContain('done');
      expect(lines[2], `${id} stalled stop`).toContain('stalled');
      expect(lines[2], `${id} needs-permission stop`).toContain('needs-permission');
      expect(lines[3], `${id} guardrails line`).toMatch(/^GUARDRAILS: /);
      expect(lines[3], `${id} destructive guardrail`).toContain('Do not ');
      expect(template!.prompt).toContain('Return a concise summary');
    }
  });

  it('returns defensive copies so callers cannot mutate the catalog', () => {
    const [first] = listAutomationTemplates();
    first!.tags.push('mutated');

    expect(listAutomationTemplates()[0]!.tags).not.toContain('mutated');
  });
});
