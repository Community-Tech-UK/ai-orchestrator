import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze } from '../../../../../scripts/ui-hints/analyze';
import { avoidWordReports } from '../../../../../scripts/ui-hints/glossary-report';
import { fixtureTree } from '../../../../../scripts/__tests__/ui-hints-fixtures';
import { AVOID_WORD_PATTERNS } from '../../../../shared/glossary/glossary';
import { TaskPreflightCardComponent } from './task-preflight-card.component';

describe('workflow preflight wording', () => {
  it('renders the workflow subtitle and includes shared-component input copy in the vocabulary guard', () => {
    const workflow = readFileSync(resolve('src/renderer/app/features/workflow/workflow-page.component.ts'), 'utf8');
    const tag = workflow.match(/<app-task-preflight-card\b[\s\S]*?\/>/)?.[0];
    expect(tag).toBeDefined();
    const subtitle = tag!.match(/\bsubtitle="([^"]+)"/)?.[1];
    expect(subtitle).toContain('selected session');
    TestBed.configureTestingModule({ imports: [TaskPreflightCardComponent] });
    const fixture = TestBed.createComponent(TaskPreflightCardComponent);
    fixture.componentRef.setInput('subtitle', subtitle);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.card-header p')?.textContent).toBe(subtitle);

    const tree = fixtureTree(tag!);
    try {
      const current = analyze(tree.root, {});
      expect(current.vocabularyStreams[tree.owner]?.some(text => text.includes(subtitle!))).toBe(true);
      expect(avoidWordReports(current.vocabularyStreams, AVOID_WORD_PATTERNS)).toEqual([]);
      tree.write(tag!.replace('selected session', 'selected instance'));
      expect(avoidWordReports(analyze(tree.root, {}).vocabularyStreams, AVOID_WORD_PATTERNS).join('\n'))
        .toContain('avoid word "instance"');
    } finally { tree.cleanup(); }
  });
});
