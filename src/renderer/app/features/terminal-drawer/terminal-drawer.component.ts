import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Terminal as XTerminal } from '@xterm/xterm';
import type { FitAddon as XFitAddon } from '@xterm/addon-fit';
import { NodePickerComponent } from '../../shared/components/node-picker/node-picker.component';
import { TERMINAL_SESSION } from '../../core/services/terminal-session.service';

type DrawerStatus = 'idle' | 'connecting' | 'running' | 'exited' | 'error';

@Component({
  selector: 'app-terminal-drawer',
  standalone: true,
  imports: [FormsModule, NodePickerComponent],
  template: `
    <section class="terminal-drawer" [class.open]="isOpen()" aria-label="Terminal drawer">
      <header class="terminal-drawer__header">
        <h3 class="terminal-drawer__title">Terminal</h3>
        <div class="terminal-drawer__controls">
          <app-node-picker
            [selectedNodeId]="selectedNodeId()"
            (nodeSelected)="onNodeSelected($event)"
          ></app-node-picker>
          <input
            class="terminal-drawer__cwd"
            type="text"
            placeholder="Working directory on worker"
            [ngModel]="cwd()"
            (ngModelChange)="cwd.set($event)"
            [disabled]="isLive()"
            aria-label="Working directory"
          />
          @if (!isLive()) {
            <button type="button" class="terminal-drawer__btn" (click)="open()">Open</button>
          } @else {
            <button type="button" class="terminal-drawer__btn" (click)="kill()">Stop</button>
          }
          <span class="terminal-drawer__status" [class]="'is-' + status()">{{ statusLabel() }}</span>
        </div>
        <button
          type="button"
          class="terminal-drawer__close"
          aria-label="Close terminal drawer"
          (click)="onClose()"
        >
          ×
        </button>
      </header>

      <div class="terminal-drawer__body">
        @if (statusMessage(); as message) {
          <p class="terminal-drawer__notice">{{ message }}</p>
        }
        <div #termHost class="terminal-drawer__term" aria-label="Terminal output"></div>
      </div>
    </section>
  `,
  styles: [`
    .terminal-drawer {
      position: fixed;
      right: 0;
      bottom: 0;
      left: 0;
      z-index: 80;
      display: flex;
      flex-direction: column;
      height: 320px;
      min-height: 200px;
      max-height: 60vh;
      background: var(--bg-primary);
      border-top: 1px solid var(--border-color);
      box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.22);
      transform: translateY(100%);
      transition: transform 160ms ease-out;
    }

    .terminal-drawer.open { transform: translateY(0); }

    .terminal-drawer__header {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      min-height: 44px;
      padding: 0 var(--spacing-md);
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
    }

    .terminal-drawer__title { margin: 0; color: var(--text-primary); font-size: 13px; font-weight: 600; }

    .terminal-drawer__controls { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }

    .terminal-drawer__cwd {
      flex: 1;
      min-width: 120px;
      max-width: 360px;
      padding: 4px 8px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 12px;
      font-family: var(--font-mono);
    }

    .terminal-drawer__btn {
      padding: 4px 12px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 12px;
      cursor: pointer;
    }
    .terminal-drawer__btn:hover { border-color: var(--border-light); }

    .terminal-drawer__status { font-size: 11px; color: var(--text-muted); white-space: nowrap; }
    .terminal-drawer__status.is-running { color: var(--success-color, #22c55e); }
    .terminal-drawer__status.is-error { color: var(--error-color, #ef4444); }
    .terminal-drawer__status.is-connecting { color: #eab308; }

    .terminal-drawer__close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      padding: 0;
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      transition: all var(--transition-fast);
    }
    .terminal-drawer__close:hover { background: var(--bg-hover); border-color: var(--border-color); color: var(--text-primary); }

    .terminal-drawer__body {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      padding: var(--spacing-sm);
      gap: 6px;
    }

    .terminal-drawer__notice { margin: 0 var(--spacing-sm); color: var(--text-muted); font-size: 12px; line-height: 1.5; }

    .terminal-drawer__term {
      flex: 1;
      min-height: 0;
      padding: 4px 6px;
      background: #0b0e14;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      overflow: hidden;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TerminalDrawerComponent {
  private readonly terminal = inject(TERMINAL_SESSION);
  private readonly destroyRef = inject(DestroyRef);
  private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly isOpen = input(false);
  readonly closeRequested = output<void>();

  protected readonly selectedNodeId = signal<string | null>(null);
  protected readonly cwd = signal('');
  protected readonly status = signal<DrawerStatus>('idle');
  protected readonly statusMessage = signal<string | null>(null);

  private sessionId: string | null = null;
  private term: XTerminal | null = null;
  private fitAddon: XFitAddon | null = null;
  private pendingOutput = '';

  constructor() {
    const unsubscribe = this.terminal.subscribe((event) => {
      switch (event.kind) {
        case 'spawned':
          if (this.sessionId === null) this.sessionId = event.sessionId;
          if (this.matches(event.sessionId)) this.status.set('running');
          break;
        case 'data':
          if (this.matches(event.sessionId)) this.writeOut(event.data);
          break;
        case 'exited':
          if (this.matches(event.sessionId)) {
            this.status.set('exited');
            this.statusMessage.set(
              `Session exited${event.code !== null ? ` (code ${event.code})` : ''}${event.signal ? ` [${event.signal}]` : ''}.`,
            );
            this.sessionId = null;
          }
          break;
        case 'error':
          this.status.set('error');
          this.statusMessage.set(event.message);
          break;
      }
    });

    const onResize = () => this.fit();
    if (typeof window !== 'undefined') window.addEventListener('resize', onResize);

    // Refit when the drawer slides open (its container only has a size then).
    effect(() => {
      if (this.isOpen() && this.term) this.fit();
    });

    this.destroyRef.onDestroy(() => {
      if (typeof window !== 'undefined') window.removeEventListener('resize', onResize);
      unsubscribe();
      void this.killQuietly();
      this.term?.dispose();
      this.term = null;
    });
  }

  protected isLive(): boolean {
    return this.status() === 'connecting' || this.status() === 'running';
  }

  protected statusLabel(): string {
    switch (this.status()) {
      case 'connecting': return 'Connecting…';
      case 'running': return 'Connected';
      case 'exited': return 'Exited';
      case 'error': return 'Error';
      default: return 'Idle';
    }
  }

  protected onNodeSelected(nodeId: string | null): void {
    this.selectedNodeId.set(nodeId);
  }

  protected async open(): Promise<void> {
    const nodeId = this.selectedNodeId();
    if (!nodeId) {
      this.statusMessage.set('Pick a connected worker node to open a remote terminal.');
      return;
    }
    const cwd = this.cwd().trim();
    if (!cwd) {
      this.statusMessage.set('Enter a working directory on the worker to start the terminal.');
      return;
    }
    this.status.set('connecting');
    this.statusMessage.set(null);
    this.pendingOutput = '';
    this.sessionId = null;
    try {
      const term = await this.ensureTerminal();
      const { sessionId } = await this.terminal.spawn({
        nodeId,
        cwd,
        cols: term?.cols,
        rows: term?.rows,
      });
      this.sessionId = sessionId;
      this.status.set('running');
      term?.focus();
    } catch (err) {
      this.status.set('error');
      this.statusMessage.set(err instanceof Error ? err.message : String(err));
    }
  }

  protected async kill(): Promise<void> {
    await this.killQuietly();
    this.status.set('idle');
  }

  protected onClose(): void {
    this.closeRequested.emit();
  }

  /** Lazily create the xterm terminal (kept out of the initial bundle). */
  private async ensureTerminal(): Promise<XTerminal | null> {
    if (this.term) {
      this.fit();
      return this.term;
    }
    const host = this.elementRef.nativeElement.querySelector<HTMLElement>('.terminal-drawer__term');
    if (!host) return null;

    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ]);
    const term = new Terminal({
      fontSize: 12,
      fontFamily: 'SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: '#0b0e14', foreground: '#d7dae0' },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(host);
    this.term = term;
    this.fitAddon = fitAddon;

    if (this.pendingOutput) {
      term.write(this.pendingOutput);
      this.pendingOutput = '';
    }
    // Forward raw keystrokes (the whole point of a real terminal vs a line box).
    term.onData((data) => {
      const sessionId = this.sessionId;
      if (sessionId) void this.terminal.write(sessionId, data).catch(() => undefined);
    });
    this.fit();
    return term;
  }

  private fit(): void {
    try {
      this.fitAddon?.fit();
    } catch {
      /* container not laid out yet */
    }
    const term = this.term;
    const sessionId = this.sessionId;
    if (term && sessionId) {
      void this.terminal.resize(sessionId, term.cols, term.rows).catch(() => undefined);
    }
  }

  private writeOut(data: string): void {
    if (this.term) this.term.write(data);
    else this.pendingOutput += data;
  }

  private matches(sessionId: string): boolean {
    return this.sessionId === null || this.sessionId === sessionId;
  }

  private async killQuietly(): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    this.sessionId = null;
    try {
      await this.terminal.kill(sessionId);
    } catch {
      /* best-effort */
    }
  }
}
