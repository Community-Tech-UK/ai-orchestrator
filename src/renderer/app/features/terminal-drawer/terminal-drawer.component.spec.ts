import { NO_ERRORS_SCHEMA } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { TerminalDrawerComponent } from './terminal-drawer.component';
import { TERMINAL_SESSION } from '../../core/services/terminal-session.service';
import type {
  TerminalLifecycleEvent,
  TerminalSession,
} from '../../../../shared/types/terminal.types';

// Capture xterm instances created by the component (xterm is lazy-imported).
const hoisted = vi.hoisted(() => ({ terminals: [] as FakeTerminalHandle[] }));

interface FakeTerminalHandle {
  cols: number;
  rows: number;
  written: string[];
  dataCb?: (data: string) => void;
}

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80;
    rows = 24;
    written: string[] = [];
    dataCb?: (data: string) => void;
    constructor() {
      hoisted.terminals.push(this as unknown as FakeTerminalHandle);
    }
    loadAddon(addon: unknown): void {
      void addon;
    }
    open(el: unknown): void {
      void el;
    }
    focus(): void {
      void 0;
    }
    dispose(): void {
      void 0;
    }
    write(data: string): void {
      this.written.push(data);
    }
    onData(cb: (data: string) => void): void {
      this.dataCb = cb;
    }
  }
  return { Terminal };
});

vi.mock('@xterm/addon-fit', () => {
  class FitAddon {
    fit(): void {
      void 0;
    }
  }
  return { FitAddon };
});

class FakeTerminalSession implements TerminalSession {
  listener: ((event: TerminalLifecycleEvent) => void) | undefined;
  readonly spawn = vi.fn(async () => ({ sessionId: 's1', pid: 123 }));
  readonly write = vi.fn(async () => undefined);
  readonly resize = vi.fn(async () => undefined);
  readonly kill = vi.fn(async () => undefined);

  subscribe(listener: (event: TerminalLifecycleEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  emit(event: TerminalLifecycleEvent): void {
    this.listener?.(event);
  }
}

interface DrawerInternals {
  open(): Promise<void>;
  selectedNodeId: { set(value: string | null): void };
  cwd: { set(value: string): void };
}

function setup() {
  hoisted.terminals.length = 0;
  const fake = new FakeTerminalSession();
  TestBed.configureTestingModule({
    imports: [TerminalDrawerComponent],
    providers: [{ provide: TERMINAL_SESSION, useValue: fake }],
  });
  // <app-node-picker>'s stores lie dormant in jsdom; NO_ERRORS_SCHEMA keeps the
  // unit test on the drawer's own behaviour (binding validated by the prod
  // strictTemplates build). Matches loop-control.component.spec.
  TestBed.overrideComponent(TerminalDrawerComponent, {
    add: { schemas: [NO_ERRORS_SCHEMA] },
  });
  const fixture = TestBed.createComponent(TerminalDrawerComponent);
  fixture.detectChanges();
  const internals = fixture.componentInstance as unknown as DrawerInternals;
  return { fixture, fake, internals };
}

async function openSession(internals: DrawerInternals): Promise<void> {
  internals.selectedNodeId.set('windows-pc');
  internals.cwd.set('/work');
  await internals.open();
}

describe('TerminalDrawerComponent', () => {
  it('opens a remote session and streams data into the xterm terminal', async () => {
    const { fake, internals } = setup();

    await openSession(internals);
    expect(fake.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: 'windows-pc', cwd: '/work' }),
    );
    expect(hoisted.terminals).toHaveLength(1);

    fake.emit({ kind: 'data', sessionId: 's1', data: 'hello from worker' });
    expect(hoisted.terminals[0].written.join('')).toContain('hello from worker');
  });

  it('forwards keystrokes from xterm to the session', async () => {
    const { fake, internals } = setup();
    await openSession(internals);

    hoisted.terminals[0].dataCb?.('ls\r');
    expect(fake.write).toHaveBeenCalledWith('s1', 'ls\r');
  });

  it('refuses to open without a node and explains why', async () => {
    const { fixture, fake, internals } = setup();
    internals.cwd.set('/work'); // node intentionally left unset
    await internals.open();
    fixture.detectChanges();

    expect(fake.spawn).not.toHaveBeenCalled();
    const notice = (fixture.nativeElement as HTMLElement).querySelector('.terminal-drawer__notice');
    expect(notice?.textContent ?? '').toMatch(/worker node/i);
  });

  it('surfaces lifecycle errors in the notice line', () => {
    const { fixture, fake } = setup();

    fake.emit({ kind: 'error', sessionId: 's1', message: 'node disconnected' });
    fixture.detectChanges();

    const notice = (fixture.nativeElement as HTMLElement).querySelector('.terminal-drawer__notice');
    expect(notice?.textContent ?? '').toContain('node disconnected');
  });

  it('emits close when the close button is clicked', () => {
    const { fixture } = setup();
    let closed = false;
    fixture.componentInstance.closeRequested.subscribe(() => {
      closed = true;
    });

    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      'button[aria-label="Close terminal drawer"]',
    );
    button?.click();

    expect(closed).toBe(true);
  });
});
