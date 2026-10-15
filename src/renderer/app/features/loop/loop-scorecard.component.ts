import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { LoopScorecardService } from '../../core/services/ipc/loop-scorecard.service';
import { scorecardLines } from '../../../../shared/util/loop-scorecard-format';
@Component({
  selector:'app-loop-scorecard', standalone:true, changeDetection:ChangeDetectionStrategy.OnPush,
  template:`<section aria-label="Run scorecard"><h4>Run scorecard</h4>@if (error()) { <p role="alert">{{ error() }}</p> } @else { @for (line of lines(); track $index) { <p>{{ line }}</p> } }</section>`,
})
export class LoopScorecardComponent {
  loopRunId = input.required<string>();
  private readonly service = inject(LoopScorecardService);
  readonly lines = signal<string[]>([]);
  readonly error = signal('');
  constructor() {
    effect((onCleanup) => {
      const id = this.loopRunId(); let current = true;
      onCleanup(() => { current = false; }); this.error.set(''); this.lines.set([]);
      void this.service.get(id).then(card => { if(current) this.lines.set(card ? scorecardLines(card) : ['No recorded scorecard for this run.']); })
        .catch(error => { if(current) this.error.set(error instanceof Error ? error.message : String(error)); });
    });
  }
}
