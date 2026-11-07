import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';

@Component({
  selector: 'app-permission-deny-note', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (!open()) {
    <button type="button" class="link" [disabled]="busy()" (click)="open.set(true)">Tell it what to do instead</button>
  } @else {
    <label>Tell it what to do instead
      <input type="text" maxlength="2000" placeholder="For example: use the other folder" [disabled]="busy()" [value]="note()"
        (input)="change($event)" (keydown.enter)="$event.preventDefault(); send()" (keydown.escape)="$event.stopPropagation(); close()" />
    </label>
    <button type="button" [disabled]="busy() || !note().trim()" (click)="send()">Send</button>
    <button type="button" [disabled]="busy()" (click)="close()">Cancel</button>
    <small>Claude will see this as the reason.</small>
  }`,
  styles: `:host { max-width:100%; } button { cursor:pointer; padding:6px 8px; border:1px solid var(--border-subtle); background:var(--bg-tertiary); color:var(--text-primary); border-radius:var(--radius-md); }
    .link { border:0; background:transparent; text-decoration:underline; } label { display:block; font-size:12px; } input { width:100%; box-sizing:border-box; padding:8px; background:var(--bg-primary); color:var(--text-primary); border:1px solid var(--border-subtle); border-radius:var(--radius-md); }
    small { display:block; color:var(--text-muted); } button:disabled { opacity:.5; cursor:not-allowed; }`,
})
export class PermissionDenyNoteComponent {
  busy = input(false);
  noteSent = output<string>();
  protected open = signal(false);
  protected note = signal('');
  protected change(event: Event): void { this.note.set((event.target as HTMLInputElement).value.slice(0, 2000)); }
  protected close(): void { this.open.set(false); this.note.set(''); }
  protected send(): void {
    const note = this.note().trim();
    if (!this.busy() && note) this.noteSent.emit(note);
  }
}
