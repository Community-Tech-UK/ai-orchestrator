import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextWarningComponent } from './context-warning.component';

describe('ContextWarningComponent', () => {
  let fixture: ComponentFixture<ContextWarningComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ContextWarningComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(ContextWarningComponent);
  });

  afterEach(() => {
    fixture.destroy();
  });

  function setInputs(overrides: { percentage?: number; level?: 'warning' | 'critical' | 'emergency'; isCompacting?: boolean } = {}): void {
    fixture.componentRef.setInput('percentage', overrides.percentage ?? 80);
    fixture.componentRef.setInput('level', overrides.level ?? 'critical');
    if (overrides.isCompacting !== undefined) fixture.componentRef.setInput('isCompacting', overrides.isCompacting);
    fixture.detectChanges();
  }

  it('renders a Preview button alongside Compact Now when not compacting', () => {
    setInputs();
    const preview = fixture.nativeElement.querySelector('.preview-btn') as HTMLButtonElement | null;
    const compact = fixture.nativeElement.querySelector('.compact-btn') as HTMLButtonElement | null;
    expect(preview).toBeTruthy();
    expect(compact).toBeTruthy();
    expect(preview!.textContent?.trim()).toBe('Preview');
  });

  it('emits previewRequested when the Preview button is clicked', () => {
    setInputs();
    let emitted = 0;
    fixture.componentInstance.previewRequested.subscribe(() => { emitted += 1; });

    (fixture.nativeElement.querySelector('.preview-btn') as HTMLButtonElement).click();

    expect(emitted).toBe(1);
  });

  it('hides Preview and Compact Now while a compaction is in progress', () => {
    setInputs({ isCompacting: true });
    expect(fixture.nativeElement.querySelector('.preview-btn')).toBeNull();
    expect(fixture.nativeElement.querySelector('.compact-btn')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Compacting...');
  });

  it('Preview button has an accessible label', () => {
    setInputs();
    const preview = fixture.nativeElement.querySelector('.preview-btn') as HTMLButtonElement;
    expect(preview.getAttribute('aria-label')).toMatch(/preview/i);
  });
});
