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
    ]);
    for (const template of templates) {
      expect(template.prompt).toContain('Return a concise summary');
      expect(template.suggestedSchedule.type).toBe('cron');
      expect(template.tags.length).toBeGreaterThan(0);
    }
  });

  it('returns defensive copies so callers cannot mutate the catalog', () => {
    const [first] = listAutomationTemplates();
    first!.tags.push('mutated');

    expect(listAutomationTemplates()[0]!.tags).not.toContain('mutated');
  });
});
