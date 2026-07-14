import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { DocReviewViewerComponent } from './doc-review-viewer.component';

@Component({
  standalone: true,
  imports: [DocReviewViewerComponent],
  template: '<app-doc-review-viewer [html]="html" />',
})
class TestHostComponent {
  readonly html = '<!doctype html><title>review</title>';
}

describe('DocReviewViewerComponent', () => {
  it('mirrors a validated choice event from its sandboxed artifact', () => {
    TestBed.configureTestingModule({ imports: [TestHostComponent] });
    const fixture = TestBed.createComponent(TestHostComponent);
    fixture.detectChanges();
    const component = fixture.debugElement.children[0].componentInstance as DocReviewViewerComponent;
    const mirrored: unknown[] = [];
    component.choiceChanged.subscribe((choice) => mirrored.push(choice));
    const source = {} as Window;
    // JSDOM does not consistently populate iframe.contentWindow. Override only the
    // view-query seam so this unit test still proves the source-gated protocol branch.
    (component as unknown as { frame: () => { nativeElement: { contentWindow: Window } } }).frame =
      () => ({ nativeElement: { contentWindow: source } });

    (component as unknown as { handleMessage(event: MessageEvent): void }).handleMessage({
      source,
      data: {
        type: 'aio-review/choice',
        itemId: 'strategy',
        decisionId: '1',
        choice: 'b',
        choices: [],
      },
    } as MessageEvent);

    expect(mirrored).toEqual([{
      itemId: 'strategy',
      choice: 'b',
      choices: [],
    }]);
  });

  it('returns stored choice state to a newly loaded sandboxed artifact', () => {
    TestBed.configureTestingModule({ imports: [TestHostComponent] });
    const fixture = TestBed.createComponent(TestHostComponent);
    fixture.detectChanges();
    const component = fixture.debugElement.children[0].componentInstance as DocReviewViewerComponent;
    const messages: unknown[] = [];
    (component as unknown as { frame: () => { nativeElement: { contentWindow: Window } } }).frame =
      () => ({ nativeElement: { contentWindow: { postMessage: (message: unknown) => messages.push(message) } as Window } });

    (component as unknown as { sendInit(state: unknown): void }).sendInit({
      comments: [{
        itemId: 'strategy',
        decision: 'approve',
        comment: '',
        choice: 'b',
        choices: [],
      }],
    });

    expect(messages).toEqual([{
      type: 'aio-review/init',
      comments: [{
        itemId: 'strategy',
        decision: 'approve',
        comment: '',
        choice: 'b',
        choices: [],
      }],
    }]);
  });
});
