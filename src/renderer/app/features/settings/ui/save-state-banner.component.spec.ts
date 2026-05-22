import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { SaveState, SaveStateBannerComponent } from './save-state-banner.component';

@Component({
  standalone: true,
  imports: [SaveStateBannerComponent],
  template: `<app-save-state-banner [state]="state" />`,
})
class SaveStateBannerHostComponent {
  state: SaveState = 'saved';
}

describe('SaveStateBannerComponent', () => {
  let fixture: ComponentFixture<SaveStateBannerHostComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SaveStateBannerHostComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(SaveStateBannerHostComponent);
  });

  it('renders restart-required save state with apply and reset actions', () => {
    fixture.componentInstance.state = 'restart';
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Needs restart');
    expect(text).toContain('Reset');
    expect(text).toContain('Apply changes');
  });
});
