import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { RoleChoiceComponent } from './role-choice.component';

describe('RoleChoiceComponent', () => {
  let fixture: ComponentFixture<RoleChoiceComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RoleChoiceComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(RoleChoiceComponent);
    fixture.detectChanges();
  });

  it('shows two large primary choices when the role is unset', () => {
    const buttons = fixture.debugElement.queryAll(By.css('button.role-card'));

    expect(buttons).toHaveLength(2);
    expect(buttons[0].nativeElement.textContent).toContain('Use this computer as the main Harness');
    expect(buttons[1].nativeElement.textContent).toContain('Use this computer as a worker');
  });

  it('emits the selected role explicitly', () => {
    const selected: string[] = [];
    fixture.componentInstance.roleSelected.subscribe((role) => selected.push(role));

    fixture.debugElement.queryAll(By.css('button.role-card'))[1].nativeElement.click();

    expect(selected).toEqual(['worker']);
  });
});
