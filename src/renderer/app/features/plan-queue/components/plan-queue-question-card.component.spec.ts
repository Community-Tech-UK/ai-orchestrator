import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PlanQueueQuestion } from '@contracts/schemas/plan-queue';
import { PlanQueueQuestionCardComponent } from './plan-queue-question-card.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './plan-queue-question-card.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './plan-queue-question-card.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('plan-queue-question-card.component.html')) return Promise.resolve(template);
  if (url.endsWith('plan-queue-question-card.component.scss')) return Promise.resolve(styles);
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

const question: PlanQueueQuestion = {
  question: 'Which migration path should the worker take?',
  options: [
    { id: 'a', label: 'In-place migration' },
    { id: 'b', label: 'Blue-green cutover' },
  ],
};

describe('PlanQueueQuestionCardComponent', () => {
  let fixture: ComponentFixture<PlanQueueQuestionCardComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PlanQueueQuestionCardComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(PlanQueueQuestionCardComponent);
    fixture.componentRef.setInput('question', question);
    fixture.detectChanges();
  });

  function radios(): HTMLInputElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('input[type="radio"]'));
  }

  function submitButton(): HTMLButtonElement {
    return fixture.nativeElement.querySelector('.pq-question-submit') as HTMLButtonElement;
  }

  it('renders the question text and one radio per option', () => {
    expect(fixture.nativeElement.textContent).toContain(question.question);
    expect(radios()).toHaveLength(2);
  });

  it('disables the submit button until an option is selected', () => {
    expect(submitButton().disabled).toBe(true);

    radios()[0].dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(submitButton().disabled).toBe(false);
  });

  it('never lets James type an option id — only radio inputs are rendered', () => {
    expect(fixture.nativeElement.querySelectorAll('input[type="text"]')).toHaveLength(0);
  });

  it('emits the selected option id on submit', () => {
    const emitted: string[] = [];
    fixture.componentInstance.submitAnswer.subscribe((id: string) => emitted.push(id));

    radios()[1].dispatchEvent(new Event('change'));
    fixture.detectChanges();
    submitButton().click();

    expect(emitted).toEqual(['b']);
  });

  it('gives each rendered card its own radio group name', () => {
    const other = TestBed.createComponent(PlanQueueQuestionCardComponent);
    other.componentRef.setInput('question', question);
    other.detectChanges();

    const firstName = radios()[0].name;
    const secondName = (other.nativeElement.querySelector('input[type="radio"]') as HTMLInputElement).name;
    expect(firstName).not.toBe(secondName);
  });
});
