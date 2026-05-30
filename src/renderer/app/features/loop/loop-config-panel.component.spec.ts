import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { LoopConfigPanelComponent } from './loop-config-panel.component';

describe('LoopConfigPanelComponent', () => {
  let fixture: ComponentFixture<LoopConfigPanelComponent>;
  let component: LoopConfigPanelComponent;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [LoopConfigPanelComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(LoopConfigPanelComponent);
    component = fixture.componentInstance;
    (component as unknown as { workspaceCwd: () => string }).workspaceCwd = () => '/tmp/project';
    fixture.detectChanges();
  });

  it('requires completed-plan renames whenever a plan file is configured', () => {
    component.planFile.set('PLAN.md');
    fixture.detectChanges();

    const config = component.buildConfig();

    expect(config?.planFile).toBe('PLAN.md');
    expect(config?.completion?.requireCompletedFileRename).toBe(true);
  });

  it('does not require completed-plan renames for no-plan loops by default', () => {
    const config = component.buildConfig();

    expect(config?.planFile).toBeUndefined();
    expect(config?.completion?.requireCompletedFileRename).toBe(false);
  });

  it('defaults to verifier-backed completion', () => {
    const config = component.buildConfig();

    expect(config?.completion?.allowOperatorReviewedCompletion).toBe(false);
  });

  it('defaults to a $10 spend cap (LF-3)', () => {
    const config = component.buildConfig();

    expect(config?.caps?.maxCostCents).toBe(1000);
  });

  it('allows clearing the spend cap to null for an unbounded run', () => {
    component.maxDollars.set(null);

    const config = component.buildConfig();

    expect(config?.caps?.maxCostCents).toBeNull();
  });

  it('keeps the verify command control visible without opening advanced settings', () => {
    fixture.detectChanges();

    const verifyInput = fixture.nativeElement.querySelector('#loop-cfg-verify') as HTMLInputElement | null;

    expect(component.showAdvanced()).toBe(false);
    expect(verifyInput).not.toBeNull();
  });

  it('can opt into operator-reviewed completion for loops without a verifier', () => {
    component.operatorReviewedCompletion.set(true);
    fixture.detectChanges();

    const config = component.buildConfig();

    expect(config?.completion?.allowOperatorReviewedCompletion).toBe(true);
  });

  it('sends quick verify command config when provided', () => {
    component.quickVerifyCommand.set('npx tsc --noEmit');
    fixture.detectChanges();

    const config = component.buildConfig();

    expect(config?.completion?.quickVerifyCommand).toBe('npx tsc --noEmit');
    expect(config?.completion?.quickVerifyTimeoutMs).toBe(120_000);
  });

  it('sends fresh-eyes review config only when explicitly enabled', () => {
    expect(component.buildConfig()?.completion?.crossModelReview).toBeUndefined();

    component.freshEyesReview.set(true);
    fixture.detectChanges();

    const config = component.buildConfig();

    expect(config?.completion?.crossModelReview).toEqual({
      enabled: true,
      blockingSeverities: ['critical', 'high'],
      timeoutSeconds: 90,
      reviewDepth: 'structured',
    });
  });
});
