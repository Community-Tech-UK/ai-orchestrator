/**
 * N4 — rendered, and driven by real clicks on the real checkboxes. The emitted
 * text is checked against `buildFixSelectedMessage`'s real output rather than
 * a copy of it, so the component and the message builder cannot drift.
 */
import { ChangeDetectionStrategy, Component, signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { LoopFreshEyesFindingsPanelComponent } from './loop-fresh-eyes-findings-panel.component';
import {
  buildFixSelectedMessage,
  type FreshEyesFindingsDetail,
} from './loop-fresh-eyes-findings-panel.util';

await resolveComponentResources(() => Promise.resolve(''));

const DETAIL: FreshEyesFindingsDetail = {
  signal: 'blocking-findings',
  blockingFindings: [
    {
      title: 'Null deref in the parser',
      body: 'The parser assumes a node exists.',
      severity: 'high',
      anchorStatus: 'verified',
      anchor: { file: 'src/parse.ts', lineRange: [40, 42], quote: 'node.value' },
    },
    { title: 'Missing test for the empty case', severity: 'medium' },
  ],
  demotedFindings: [
    { title: 'Style nit', demotedReason: 'anchor could not be verified' },
  ],
};

@Component({
  standalone: true,
  imports: [LoopFreshEyesFindingsPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-loop-fresh-eyes-findings-panel
      [detail]="detail()"
      (fixRequested)="sent.push($event)"
    />
  `,
})
class HostComponent {
  readonly detail = signal<FreshEyesFindingsDetail | null>(null);
  readonly sent: string[] = [];
}

describe('LoopFreshEyesFindingsPanelComponent (N4)', () => {
  let fixture: ComponentFixture<HostComponent>;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  });

  function seed(): void {
    fixture.componentInstance.detail.set(DETAIL);
    fixture.detectChanges();
  }
  function items(): HTMLElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.fe-findings__item'));
  }
  function checkboxes(): HTMLInputElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.fe-findings__item input[type="checkbox"]'));
  }
  function fixButton(): HTMLButtonElement {
    return fixture.nativeElement.querySelector('.fe-findings__fix');
  }

  it('renders nothing without findings', () => {
    expect(fixture.nativeElement.querySelector('.fe-findings')).toBeNull();
  });

  it('renders one row per blocking finding', () => {
    seed();
    expect(items()).toHaveLength(2);
  });

  it('shows the severity, location and anchor status the flat line dropped', () => {
    seed();
    const first = items()[0]!;
    expect(first.textContent).toContain('high');
    expect(first.textContent).toContain('src/parse.ts:40–42');
    expect(first.textContent).toContain('verified');
  });

  it('shows the citation that justifies the block', () => {
    seed();
    expect((fixture.nativeElement.querySelector('.fe-findings__quote') as HTMLElement).textContent)
      .toContain('node.value');
  });

  it('omits the citation for a finding that has none', () => {
    seed();
    expect(items()[1]!.querySelector('.fe-findings__quote')).toBeNull();
  });

  it('disables the fix button until something is selected', () => {
    seed();
    expect(fixButton().disabled).toBe(true);
    checkboxes()[0]!.click();
    fixture.detectChanges();
    expect(fixButton().disabled).toBe(false);
  });

  it('counts the selection on the button', () => {
    seed();
    checkboxes()[0]!.click();
    checkboxes()[1]!.click();
    fixture.detectChanges();
    expect(fixButton().textContent?.trim()).toBe('Fix 2 selected');
  });

  it('deselects on a second click', () => {
    seed();
    checkboxes()[0]!.click();
    checkboxes()[0]!.click();
    fixture.detectChanges();
    expect(fixButton().disabled).toBe(true);
  });

  it('emits only the selected findings, in the builder’s own wording', () => {
    seed();
    checkboxes()[1]!.click();
    fixture.detectChanges();
    fixButton().click();
    expect(fixture.componentInstance.sent).toEqual([
      buildFixSelectedMessage([DETAIL.blockingFindings[1]!]),
    ]);
  });

  it('clears the selection after sending, so it does not look still-pending', () => {
    seed();
    checkboxes()[0]!.click();
    fixture.detectChanges();
    fixButton().click();
    fixture.detectChanges();
    expect(fixButton().disabled).toBe(true);
  });

  it('lists demoted findings with their reason rather than hiding them', () => {
    seed();
    const demoted = fixture.nativeElement.querySelector('.fe-findings__demoted') as HTMLElement;
    expect(demoted.textContent).toContain('1 demoted to advisory');
    expect(demoted.textContent).toContain('anchor could not be verified');
  });

  it('shows no demoted section when there are none', () => {
    fixture.componentInstance.detail.set({ ...DETAIL, demotedFindings: [] });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.fe-findings__demoted')).toBeNull();
  });
});
