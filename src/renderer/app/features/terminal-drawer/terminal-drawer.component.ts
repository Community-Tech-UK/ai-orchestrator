import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Terminal as XTerminal } from '@xterm/xterm';
import type { FitAddon as XFitAddon } from '@xterm/addon-fit';
import { NodePickerComponent } from '../../shared/components/node-picker/node-picker.component';
import { TERMINAL_SESSION } from '../../core/services/terminal-session.service';
import { RemoteNodeStore } from '../../core/state/remote-node.store';

type DrawerStatus = 'idle' | 'connecting' | 'running' | 'exited' | 'error';

@Component({
  selector: 'app-terminal-drawer',
  standalone: true,
  imports: [FormsModule, NodePickerComponent],
  // The host element is an in-flow flex child of `.app-container`. Toggling
  // `.open` animates its height, which reflows the column and pushes the rest of
  // the app up rather than overlaying it (see `:host` styles below).
  host: { '[class.open]': 'isOpen()' },
  template: `
    <section class="terminal-drawer" aria-label="Terminal drawer">
      <header class="terminal-drawer__header">
        <h3 class="terminal-drawer__title">Remote Terminal</h3>
        <div class="terminal-drawer__controls">
          <app-node-picker
            [selectedNodeId]="selectedNodeId()"
            [allowLocal]="false"
            (nodeSelected)="onNodeSelected($event)"
          ></app-node-picker>
          <input
            class="terminal-drawer__cwd"
            type="text"
            placeholder="Working directory on worker"
            [ngModel]="cwd()"
            (ngModelChange)="cwd.set($event)"
            [disabled]="isLive()"
            list="terminal-drawer-roots"
            aria-label="Working directory on the worker (must be inside an allowed root)"
            [title]="selectedNodeRoots().length
              ? 'Allowed roots: ' + selectedNodeRoots().join(', ')
              : 'Pick a worker node first'"
          />
          <datalist id="terminal-drawer-roots">
            @for (root of selectedNodeRoots(); track root) {
              <option [value]="root"></option>
            }
          </datalist>
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
    /* In-flow flex child: animating the host's height reflows the app column and
       pushes the content above it up, instead of floating over it. Collapsed to
       0 when closed; the fixed-height inner section is clipped during the slide. */
    :host {
      display: block;
      flex: 0 0 auto;
      height: 0;
      overflow: hidden;
      transition: height 160ms ease-out;
    }

    :host(.open) { height: clamp(160px, 300px, 42vh); }

    .terminal-drawer {
      display: flex;
      flex-direction: column;
      height: clamp(160px, 300px, 42vh);
      background: var(--bg-primary);
      border-top: 1px solid var(--border-color);
      box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.22);
    }

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
  private readonly remoteNodes = inject(RemoteNodeStore);

  readonly isOpen = input(false);
  readonly closeRequested = output<void>();

  protected readonly selectedNodeId = signal<string | null>(null);
  protected readonly cwd = signal('');

  /**
   * The worker's allowed working-directory roots for the selected node. The
   * worker sandboxes terminals to these, so the cwd MUST be inside one of them
   * (otherwise the spawn fails with "cwd outside allowed roots"). Surfaced as
   * suggestions + used to pre-fill a valid default on node selection.
   */
  protected readonly selectedNodeRoots = computed<string[]>(() => {
    const id = this.selectedNodeId();
    return id ? this.remoteNodes.nodeById(id)?.capabilities.workingDirectories ?? [] : [];
  });
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
            // The session is gone — wipe its output so the dead terminal isn't
            // left lingering in the window. The exit notice above stays visible.
            this.clearTerminalView();
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

    // On open with nothing selected, auto-pick the only connected worker (and
    // pre-fill a valid cwd via onNodeSelected) so the common case is one click.
    effect(() => {
      if (!this.isOpen()) return;
      untracked(() => {
        if (this.selectedNodeId()) return;
        const connected = this.remoteNodes.connectedNodes();
        if (connected.length === 1) this.onNodeSelected(connected[0].id);
      });
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
    // Pre-fill the cwd with one of the node's allowed roots so "Open" works out of
    // the box. Only overwrite when the current cwd isn't already a valid root for
    // this node (avoids clobbering a deliberate sub-path the user typed).
    const roots = this.selectedNodeRoots();
    const current = this.cwd().trim();
    if (roots.length > 0 && !roots.some((root) => current === root || current.startsWith(root))) {
      this.cwd.set(roots[0]);
    }
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
    // Closing a finished/idle terminal clears it so the next open starts fresh.
    // A live session is only hidden (not killed or cleared) so it can be resumed.
    if (!this.isLive()) {
      this.clearTerminalView();
      this.status.set('idle');
      this.statusMessage.set(null);
    }
    this.closeRequested.emit();
  }

  /** Wipe the on-screen terminal buffer (e.g. after the session ends). */
  private clearTerminalView(): void {
    this.pendingOutput = '';
    this.term?.reset();
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
