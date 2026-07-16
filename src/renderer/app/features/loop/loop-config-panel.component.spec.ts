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
    // WS6: the default prompt is an implementation goal, which now requires a
    // verification authority to submit. Give the shared baseline a verify
    // command so tests whose subject is NOT the authority gate stay focused.
    component.verifyCommand.set('npm test');
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

  it('WS7: provider failover is OFF by default and emits only when enabled with providers', () => {
    expect(component.buildConfig()?.failover).toBeUndefined();

    component.failoverEnabled.set(true);
    // Enabled but no providers picked → still not emitted.
    expect(component.buildConfig()?.failover).toBeUndefined();

    component.toggleFailoverProvider('codex', true);
    component.toggleFailoverProvider('gemini', true);
    expect(component.buildConfig()?.failover).toEqual({
      enabled: true,
      providers: ['codex', 'gemini'],
      maxSwitches: 1,
    });

    component.toggleFailoverProvider('codex', false);
    expect(component.buildConfig()?.failover?.providers).toEqual(['gemini']);
  });

  it('defaults ping-pong review to checked and emits ping-pong completion config', () => {
    const checkbox = fixture.nativeElement.querySelector('.pingpong-toggle input') as HTMLInputElement | null;
    const config = component.buildConfig();

    expect(component.pingPongEnabled()).toBe(true);
    expect(checkbox?.checked).toBe(true);
    expect(config?.completion?.crossModelReview?.pingPong).toEqual({
      enabled: true,
      reviewerProvider: 'auto',
      subject: 'auto',
      maxRounds: 15,
    });
  });

  it('offers Antigravity, not legacy Gemini, as an explicit ping-pong reviewer', () => {
    const options = Array.from(
      fixture.nativeElement.querySelectorAll('#loop-cfg-pp-reviewer option'),
      (option: Element) => ({
        label: (option as HTMLOptionElement).textContent?.trim(),
        value: (option as HTMLOptionElement).value,
      }),
    );

    expect(options).toContainEqual({ label: 'Antigravity', value: 'antigravity' });
    expect(options).not.toContainEqual({ label: 'Gemini', value: 'gemini' });
  });

  it('offers Grok Build and persists it as the ping-pong reviewer', () => {
    const options = Array.from(
      fixture.nativeElement.querySelectorAll('#loop-cfg-pp-reviewer option'),
      (option: Element) => ({
        label: (option as HTMLOptionElement).textContent?.trim(),
        value: (option as HTMLOptionElement).value,
      }),
    );

    expect(options).toContainEqual({ label: 'Grok Build', value: 'grok' });
    component.pingPongReviewerProvider.set('grok');
    expect(component.buildConfig()?.completion?.crossModelReview?.pingPong?.reviewerProvider)
      .toBe('grok');
  });

  it('emits the canonical Antigravity provider for ping-pong review', () => {
    component.pingPongReviewerProvider.set('antigravity');

    const config = component.buildConfig();

    expect(config?.completion?.crossModelReview?.pingPong?.reviewerProvider).toBe('antigravity');
  });

  it('can opt out of ping-pong review', () => {
    component.pingPongEnabled.set(false);
    fixture.detectChanges();

    const checkbox = fixture.nativeElement.querySelector('.pingpong-toggle input') as HTMLInputElement | null;
    const config = component.buildConfig();

    expect(checkbox?.checked).toBe(false);
    expect(config?.completion?.crossModelReview).toBeUndefined();
  });

  it('defaults the loop provider from the current chat provider', () => {
    fixture.componentRef.setInput('defaultProvider', 'codex');
    fixture.detectChanges();

    const config = component.buildConfig();

    expect(config?.provider).toBe('codex');
  });

  it('offers the available chat providers as loop provider overrides', () => {
    fixture.componentRef.setInput('availableProviders', ['gemini', 'copilot', 'cursor']);
    component.showAdvanced.set(true);
    fixture.detectChanges();

    const options = Array.from(
      fixture.nativeElement.querySelectorAll('#loop-cfg-provider option'),
      (option: Element) => (option as HTMLOptionElement).value,
    );

    expect(options).toEqual(['gemini', 'copilot', 'cursor']);
  });

  it('emits the chosen completion mode and clean-pass count', () => {
    component.pingPongEnabled.set(false);
    component.completionMode.set('gated');
    component.requiredCleanPasses.set(4);
    const config = component.buildConfig();

    expect(config?.completion?.mode).toBe('gated');
    expect(config?.completion?.requiredCleanReviewPasses).toBe(4);
  });

  it('WS6: defaults to a finite $30 estimated spend cap', () => {
    const config = component.buildConfig();

    expect(component.maxDollars()).toBe(30);
    expect(config?.caps?.maxCostCents).toBe(3_000);
  });

  it('WS6: a blank spend cap requires the deliberate unbounded toggle', () => {
    component.maxDollars.set(null);

    expect(component.canSubmit()).toBe(false);
    expect(component.validationError()).toContain('Allow unbounded');

    component.allowUnbounded.set(true);

    expect(component.canSubmit()).toBe(true);
    expect(component.buildConfig()?.caps?.maxCostCents).toBeNull();
  });

  it('Fable WS6: defaults the loop recipe to coding and emits it in the config', () => {
    const config = component.buildConfig();

    expect(component.loopRecipe()).toBe('coding');
    expect(config?.loopRecipe).toBe('coding');
  });

  it('Fable WS6: a selected recipe is emitted in the config', () => {
    component.recipeOptions.set([
      { name: 'coding', description: 'd', source: 'built-in' },
      { name: 'doc-work', description: 'd', source: 'built-in' },
    ]);
    component.loopRecipe.set('doc-work');

    expect(component.buildConfig()?.loopRecipe).toBe('doc-work');
  });

  it('WS6: defaults max turns per iteration to 30 and emits it', () => {
    const config = component.buildConfig();

    expect(component.maxTurns()).toBe(30);
    expect(config?.maxTurnsPerIteration).toBe(30);
  });

  it('WS6: submit is blocked with an inline reason when an implementation goal has no verification authority', () => {
    component.verifyCommand.set('');

    expect(component.canSubmit()).toBe(false);
    expect(component.validationError()).toContain('verification authority');
    expect(component.buildConfig()).toBeNull();

    // Operator-reviewed completion is a valid authority (finite cap present).
    component.operatorReviewedCompletion.set(true);

    expect(component.canSubmit()).toBe(true);
  });

  it('WS6: an investigation goal may submit without a verify command', () => {
    component.prompt.set('investigate why startup is slow and report the root cause');
    component.verifyCommand.set('');

    expect(component.canSubmit()).toBe(true);
  });

  it('defaults to no token cap (iteration/wall-time caps govern)', () => {
    const config = component.buildConfig();

    expect(config?.caps?.maxTokens).toBeNull();
  });

  it('emits an explicit token cap when one is set', () => {
    component.maxTokens.set(5_000_000);
    const config = component.buildConfig();

    expect(config?.caps?.maxTokens).toBe(5_000_000);
  });

  it('rejects a token cap below the minimum', () => {
    component.maxTokens.set(5_000);

    expect(component.canSubmit()).toBe(false);
    expect(component.buildConfig()).toBeNull();
  });

  it('sets a default iteration cap', () => {
    const config = component.buildConfig();

    expect(config?.caps?.maxIterations).toBe(50);
  });

  it('defaults to a 50-hour wall-time cap', () => {
    const config = component.buildConfig();

    expect(config?.caps?.maxWallTimeMs).toBe(50 * 60 * 60 * 1000);
  });

  it('defaults each loop iteration to same-session context reuse', () => {
    const config = component.buildConfig();

    expect(config?.contextStrategy).toBe('same-session');
  });

  it('defaults the context recycle threshold to 60%', () => {
    const config = component.buildConfig();

    expect(config?.context?.compaction.resetAtUtilization).toBe(0.6);
  });

  it('emits an explicit estimated usage cap when provided', () => {
    component.maxDollars.set(500);

    const config = component.buildConfig();

    expect(config?.caps?.maxCostCents).toBe(50000);
  });

  it('keeps the verify command control visible without opening advanced settings', () => {
    fixture.detectChanges();

    const verifyInput = fixture.nativeElement.querySelector('#loop-cfg-verify') as HTMLInputElement | null;

    expect(component.showAdvanced()).toBe(false);
    expect(verifyInput).not.toBeNull();
  });

  it('can opt into operator-reviewed completion for loops without a verifier', () => {
    component.maxDollars.set(500);
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

  it('emits default audit config', () => {
    const config = component.buildConfig();

    expect(config?.audit).toEqual({
      finalAuditMode: 'gate',
      preflightMode: 'record',
      planPacketMode: 'prompted',
      cleanlinessScan: true,
    });
  });

  it('defaults plan packets off for short low-iteration loops without a plan file', () => {
    component.prompt.set('fix the small bug');
    component.maxIterations.set(3);
    fixture.detectChanges();

    const config = component.buildConfig();

    expect(config?.audit?.planPacketMode).toBe('off');
  });

  it('preserves an explicit plan-packet override for short low-iteration loops', () => {
    component.prompt.set('fix the small bug');
    component.maxIterations.set(3);
    component.showAdvanced.set(true);
    fixture.detectChanges();

    const planPacket = fixture.nativeElement.querySelector('#loop-cfg-plan-packet') as HTMLSelectElement;
    planPacket.value = 'prompted';
    planPacket.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    const config = component.buildConfig();

    expect(config?.audit?.planPacketMode).toBe('prompted');
  });

  it('emits custom audit controls from advanced settings', () => {
    component.showAdvanced.set(true);
    fixture.detectChanges();

    const preflight = fixture.nativeElement.querySelector('#loop-cfg-preflight') as HTMLSelectElement;
    const finalAudit = fixture.nativeElement.querySelector('#loop-cfg-final-audit') as HTMLSelectElement;
    const planPacket = fixture.nativeElement.querySelector('#loop-cfg-plan-packet') as HTMLSelectElement;
    const cleanliness = fixture.nativeElement.querySelector('#loop-cfg-cleanliness-scan') as HTMLInputElement;

    preflight.value = 'block';
    preflight.dispatchEvent(new Event('change'));
    finalAudit.value = 'observe';
    finalAudit.dispatchEvent(new Event('change'));
    planPacket.value = 'off';
    planPacket.dispatchEvent(new Event('change'));
    cleanliness.checked = false;
    cleanliness.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    const config = component.buildConfig();

    expect(config?.audit).toEqual({
      finalAuditMode: 'observe',
      preflightMode: 'block',
      planPacketMode: 'off',
      cleanlinessScan: false,
    });
  });

  it('sends fresh-eyes review config only when explicitly enabled', () => {
    component.pingPongEnabled.set(false);
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

    component.maxDollars.set(500);
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

  it('does not emit next-objective planning by default', () => {
    expect(component.buildConfig()?.nextObjectivePlanning).toBeUndefined();
  });

  it('emits next-objective planning config only when explicitly enabled', () => {
    component.nextObjectivePlanning.set(true);
    component.onNextObjectiveCadenceChange(3);
    fixture.detectChanges();

    expect(component.buildConfig()?.nextObjectivePlanning).toEqual({
      enabled: true,
      cadence: 3,
    });
  });

  it('validates next-objective planner cadence', () => {
    component.nextObjectivePlanning.set(true);
    component.onNextObjectiveCadenceChange(0);
    fixture.detectChanges();

    expect(component.validationError()).toBe('Next-objective cadence must be between 1 and 50.');
    expect(component.buildConfig()).toBeNull();
  });

  it('requires an estimated usage cap before enabling branch-select on stuck', () => {
    component.branchSelect.set(true);
    component.maxDollars.set(null);
    // WS6: even with the deliberate unbounded toggle on, branch-select still
    // demands its own cap (it multiplies spend by the fanout).
    component.allowUnbounded.set(true);
    fixture.detectChanges();

    expect(component.validationError()).toBe('Branch-select on stuck requires an estimated usage cap ($). Set Estimated usage cap.');
    expect(component.buildConfig()).toBeNull();
  });

  it('updates the compaction threshold in the emitted config', () => {
    component.onCompactionThresholdPctChange(75);
    fixture.detectChanges();

    const config = component.buildConfig();

    expect(config?.context?.compaction.resetAtUtilization).toBe(0.75);
  });
});
