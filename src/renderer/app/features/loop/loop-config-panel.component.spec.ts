import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { LoopConfigPanelComponent } from './loop-config-panel.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './loop-config-panel.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './loop-config-panel.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('loop-config-panel.component.html')) {
    return Promise.resolve(template);
  }
  if (url.endsWith('loop-config-panel.component.scss')) {
    return Promise.resolve(styles);
  }
  // resolveComponentResources is global: it resolves pending templateUrl/styleUrl
  // resources for *every* component left in the shared registry by other specs in
  // the same vitest worker, not just this one. Resolve unrelated component
  // resources to empty so a leaked component (e.g. output-stream.component) cannot
  // make this spec fail. Matches the tolerant pattern in checkpoint-timeline.spec.
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

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

  it('defaults to review-driven completion with 2 clean passes', () => {
    const config = component.buildConfig();

    expect(config?.completion?.mode).toBe('review-driven');
    expect(config?.completion?.requiredCleanReviewPasses).toBe(2);
  });

  it('emits the chosen completion mode and clean-pass count', () => {
    component.completionMode.set('gated');
    component.requiredCleanPasses.set(4);
    const config = component.buildConfig();

    expect(config?.completion?.mode).toBe('gated');
    expect(config?.completion?.requiredCleanReviewPasses).toBe(4);
  });

  it('defaults to a $500 spend-cap backstop (LF-3)', () => {
    const config = component.buildConfig();

    expect(config?.caps?.maxCostCents).toBe(50000);
  });

  it('defaults the context recycle threshold to 60%', () => {
    const config = component.buildConfig();

    expect(config?.context?.compaction.resetAtUtilization).toBe(0.6);
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

  it('emits semantic-progress config only when explicitly enabled', () => {
    expect(component.buildConfig()?.semanticProgress).toBeUndefined();

    component.semanticProgress.set(true);
    fixture.detectChanges();

    const config = component.buildConfig();

    expect(config?.semanticProgress).toEqual({
      enabled: true,
      cadence: 5,
      confidenceFloor: 0.6,
    });
  });

  it('emits branch-select config only when explicitly enabled', () => {
    expect(component.buildConfig()?.exploration).toBeUndefined();

    component.branchSelect.set(true);
    component.branchFanout.set(4);
    fixture.detectChanges();

    const config = component.buildConfig();

    expect(config?.exploration).toEqual({
      enabled: true,
      fanout: 4,
      crossModel: false,
      selector: 'verify+listwise',
    });
  });

  it('requires a spend cap before enabling branch-select on stuck', () => {
    component.branchSelect.set(true);
    component.maxDollars.set(null);
    fixture.detectChanges();

    expect(component.validationError()).toBe('Branch-select on stuck requires a spend cap ($). Set Max spend.');
    expect(component.buildConfig()).toBeNull();
  });

  it('updates the compaction threshold in the emitted config', () => {
    component.onCompactionThresholdPctChange(75);
    fixture.detectChanges();

    const config = component.buildConfig();

    expect(config?.context?.compaction.resetAtUtilization).toBe(0.75);
  });
});
