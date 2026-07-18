import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-danger-zone',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="danger-zone">
      <div class="danger-header">
        <div>
          <h4>{{ title() }}</h4>
          @if (description()) {
            <p>{{ description() }}</p>
          }
        </div>
      </div>
      <div class="danger-body">
        <ng-content />
      </div>
    </section>
  `,
  styleUrl: './danger-zone.component.scss',
})
export class DangerZoneComponent {
  readonly title = input('Danger Zone');
  readonly description = input('');
}
