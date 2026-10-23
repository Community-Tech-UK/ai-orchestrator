import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { describe, expect, it } from 'vitest';
import { HelpLinkComponent } from './help-link.component';
import { HelpDrawerService } from './help-drawer.service';
import { AioTooltipDirective } from '../tooltip/aio-tooltip.directive';
import { AppIconButtonDirective } from '../tooltip/icon-button.directive';

@Component({ standalone: true, imports: [HelpLinkComponent], template: `<app-help-link topic="loop" label="Help: Loop Mode" />` })
class Host {}

describe('HelpLinkComponent', () => {
  it('uses one phrase for its accessible name and tooltip and opens topic help', async () => {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const button = fixture.debugElement.query(By.css('button'));
    expect(button.injector.get(AppIconButtonDirective).label()).toBe('Help: Loop Mode');
    expect(button.nativeElement.getAttribute('aria-label')).toBe('Help: Loop Mode');
    button.injector.get(AioTooltipDirective).show();
    fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')?.textContent?.trim()).toBe('Help: Loop Mode');
    expect(button.nativeElement.getAttribute('aria-haspopup')).toBe('dialog');
    button.nativeElement.click();
    expect(TestBed.inject(HelpDrawerService).target()).toEqual({ topic: 'loop' });
    fixture.destroy();
  });
});
