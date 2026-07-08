import { ChangeDetectionStrategy, Component, output } from '@angular/core';
import type { HarnessRole } from '../../../../shared/types/pair-both.types';

@Component({
  standalone: true,
  selector: 'app-role-choice',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="role-choice-shell" aria-labelledby="role-choice-title">
      <div class="role-choice-panel">
        <h1 id="role-choice-title">What should this computer do?</h1>
        <div class="role-choice-grid">
          <button class="role-card" type="button" (click)="selectRole('coordinator')">
            <span class="role-card-title">Use this computer as the main Harness</span>
            <span class="role-card-body">Run sessions, coordinate workers, and manage settings.</span>
          </button>
          <button class="role-card" type="button" (click)="selectRole('worker')">
            <span class="role-card-title">Use this computer as a worker</span>
            <span class="role-card-body">Let another Harness use this computer for browser, GPU, Android, and CLI work.</span>
          </button>
        </div>
      </div>
    </section>
  `,
  styles: [`
    .role-choice-shell {
      min-height: 100%;
      display: grid;
      place-items: center;
      padding: 32px;
      background: var(--app-bg, #0f1117);
      color: var(--text-primary, #f5f7fb);
    }

    .role-choice-panel {
      width: min(920px, 100%);
    }

    h1 {
      margin: 0 0 24px;
      font-size: 30px;
      font-weight: 650;
      letter-spacing: 0;
    }

    .role-choice-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }

    .role-card {
      min-height: 180px;
      border: 1px solid rgba(148, 163, 184, 0.26);
      border-radius: 8px;
      padding: 22px;
      text-align: left;
      color: inherit;
      background: rgba(20, 24, 33, 0.96);
      cursor: pointer;
    }

    .role-card:hover,
    .role-card:focus-visible {
      border-color: rgba(96, 165, 250, 0.78);
      outline: none;
    }

    .role-card-title,
    .role-card-body {
      display: block;
    }

    .role-card-title {
      font-size: 20px;
      font-weight: 650;
      letter-spacing: 0;
      margin-bottom: 10px;
    }

    .role-card-body {
      font-size: 14px;
      line-height: 1.5;
      color: rgba(226, 232, 240, 0.78);
    }

    @media (max-width: 720px) {
      .role-choice-grid {
        grid-template-columns: 1fr;
      }
    }
  `],
})
export class RoleChoiceComponent {
  readonly roleSelected = output<Exclude<HarnessRole, 'unset'>>();

  protected selectRole(role: Exclude<HarnessRole, 'unset'>): void {
    this.roleSelected.emit(role);
  }
}
