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
});
