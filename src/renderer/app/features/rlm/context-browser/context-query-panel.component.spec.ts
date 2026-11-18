import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type { QueryType } from '../../../../../shared/types/rlm.types';
import { ContextQueryPanelComponent } from './context-query-panel.component';

describe('ContextQueryPanelComponent', () => {
  it.each<QueryType>(['grep', 'slice', 'sub_query', 'summarize', 'get_section', 'semantic_search'])(
    'gives every field an accessible name in %s mode',
    (queryType) => {
      const fixture = TestBed.createComponent(ContextQueryPanelComponent);
      fixture.componentRef.setInput('hasSession', true);
      fixture.componentInstance.selectedQueryType.set(queryType);
      fixture.detectChanges();

      const fields = Array.from<HTMLElement>(
        fixture.nativeElement.querySelectorAll('.query-form input, .query-form textarea, .query-form select')
      );
      for (const field of fields) {
        const name = field.getAttribute('aria-label') ?? field.getAttribute('placeholder');
        expect(name, `${queryType}: ${field.outerHTML.slice(0, 80)}`).toBeTruthy();
      }
    }
  );

  it('names the slice offsets "Start offset" and "End offset"', () => {
    const fixture = TestBed.createComponent(ContextQueryPanelComponent);
    fixture.componentRef.setInput('hasSession', true);
    fixture.componentInstance.selectedQueryType.set('slice');
    fixture.detectChanges();

    const names = Array.from<HTMLElement>(fixture.nativeElement.querySelectorAll('.query-form input')).map((el) =>
      el.getAttribute('aria-label')
    );
    expect(names).toEqual(['Start offset', 'End offset']);
  });
});
