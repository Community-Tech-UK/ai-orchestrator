import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type {
  PlanQueueLinearConnectionSnapshot,
  PlanQueueLinearConnectorChoice,
  PlanQueueLinearIdentity,
} from '@contracts/schemas/plan-queue';
import { PlanQueueIpcService } from '../../../core/services/ipc/plan-queue-ipc.service';
import { SettingsStore } from '../../../core/state/settings.store';
import { PlanQueueLinearConnectionPanelComponent } from './plan-queue-linear-connection-panel.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './plan-queue-linear-connection-panel.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './plan-queue-linear-connection-panel.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('plan-queue-linear-connection-panel.component.html')) return Promise.resolve(template);
  if (url.endsWith('plan-queue-linear-connection-panel.component.scss')) return Promise.resolve(styles);
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

const ok = <T>(data: T) => ({ success: true, data });
const failed = (message: string) => ({ success: false, error: { message } });

function snapshot(overrides: Partial<PlanQueueLinearConnectionSnapshot> = {}): PlanQueueLinearConnectionSnapshot {
  return {
    state: 'not-set-up', usable: false, reason: null, connectorId: null, connectorName: null, userName: null,
    workspaceName: null, checkedAt: null, connectorProblem: null, unreachableCause: null, retryAt: null,
    ...overrides,
  };
}

function ready(overrides: Partial<PlanQueueLinearConnectionSnapshot> = {}): PlanQueueLinearConnectionSnapshot {
  return snapshot({
    state: 'ready', usable: true, connectorId: 'c1', connectorName: 'linear', userName: 'Pat Example',
    workspaceName: 'Example Workspace', checkedAt: 1, ...overrides,
  });
}

const CHOICE: PlanQueueLinearConnectorChoice = { connectorId: 'c1', name: 'linear', problem: null, problemReason: null };
const OTHER: PlanQueueLinearConnectorChoice = { connectorId: 'c2', name: 'linear-second', problem: null, problemReason: null };
const WHO: PlanQueueLinearIdentity = {
  connectorId: 'c1', userId: 'u-1', userName: 'Pat <b>Example</b>', userEmail: 'pat@example.test', workspaceName: 'Example Workspace',
};

describe('PlanQueueLinearConnectionPanelComponent', () => {
  let fixture: ComponentFixture<PlanQueueLinearConnectionPanelComponent>;
  let settings: ReturnType<typeof signal<{ planQueueLinearConnection?: unknown }>>;
  let ipc: Record<'linearList' | 'linearIdentify' | 'linearConfirm' | 'linearForget' | 'linearCheck', Mock>;

  async function flush(): Promise<void> {
    await new Promise((done) => setTimeout(done, 0));
    fixture.detectChanges();
    await fixture.whenStable();
  }

  async function mount(connectors: PlanQueueLinearConnectorChoice[], connection: PlanQueueLinearConnectionSnapshot): Promise<void> {
    ipc.linearList.mockResolvedValue(ok({ connectors, connection }));
    fixture = TestBed.createComponent(PlanQueueLinearConnectionPanelComponent);
    fixture.detectChanges();
    await flush();
  }

  const root = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const q = <T extends Element>(selector: string): T | null => root().querySelector(selector) as T | null;
  const text = (selector: string): string => q(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const click = async (selector: string): Promise<void> => {
    (q<HTMLButtonElement>(selector) as HTMLButtonElement).click();
    await flush();
  };
  async function choose(connectorId: string): Promise<void> {
    const select = q<HTMLSelectElement>('.pq-linear-select') as HTMLSelectElement;
    select.value = connectorId;
    select.dispatchEvent(new Event('change'));
    await flush();
  }

  beforeEach(async () => {
    settings = signal({});
    ipc = {
      linearList: vi.fn(),
      linearIdentify: vi.fn().mockResolvedValue(ok(WHO)),
      linearConfirm: vi.fn().mockResolvedValue(ok(ready())),
      linearForget: vi.fn().mockResolvedValue(ok(snapshot())),
      linearCheck: vi.fn().mockResolvedValue(ok(ready())),
    };
    await TestBed.configureTestingModule({
      imports: [PlanQueueLinearConnectionPanelComponent],
      providers: [
        provideRouter([]),
        { provide: PlanQueueIpcService, useValue: ipc },
        { provide: SettingsStore, useValue: { settings } },
      ],
    }).compileComponents();
  });

  describe('not set up', () => {
    it('says so in one sentence with a link to Settings → Connectors when no connector is Linear\'s', async () => {
      await mount([], snapshot());
      const sentence = text('.pq-linear-none').replace(text('.pq-linear-settings-link'), '').trim();
      expect(sentence).toBe('No Linear connector is set up in Harness yet.');
      expect(q<HTMLAnchorElement>('.pq-linear-settings-link')?.getAttribute('href')).toBe('/settings?tab=mcp');
      expect(q('.pq-linear-select')).toBeNull();
      expect(q('.pq-linear-problem')).toBeNull();
    });

    it('offers each Linear connector to choose, and asks nothing until one is chosen', async () => {
      await mount([CHOICE, OTHER], snapshot());
      const options = Array.from(root().querySelectorAll('.pq-linear-select option')).map((o) => (o as HTMLOptionElement).textContent?.trim());
      expect(options).toEqual(['Choose a connector', 'linear', 'linear-second']);
      expect(q<HTMLButtonElement>('.pq-linear-identify')?.disabled).toBe(true);
      expect(ipc.linearIdentify).not.toHaveBeenCalled();
    });

    it('chooses the only usable connector for you', async () => {
      await mount([CHOICE], snapshot());
      expect(q<HTMLButtonElement>('.pq-linear-identify')?.disabled).toBe(false);
    });

    it('lists a connector that is turned off with its reason, and does not offer it', async () => {
      const off: PlanQueueLinearConnectorChoice = {
        connectorId: 'c3', name: 'linear-off', problem: 'off', problemReason: 'Turn linear-off on in Settings → Connectors.',
      };
      await mount([off], snapshot());
      expect(q('.pq-linear-select')).toBeNull();
      expect(text('.pq-linear-blocked')).toContain('linear-off: Turn linear-off on in Settings → Connectors.');
      expect(q<HTMLButtonElement>('.pq-linear-identify')?.disabled).toBe(true);
    });

    it('"Check who this signs in as" asks the chosen connector, and saves nothing', async () => {
      await mount([CHOICE, OTHER], snapshot());
      await choose('c2');
      await click('.pq-linear-identify');
      expect(ipc.linearIdentify).toHaveBeenCalledWith('c2');
      expect(ipc.linearConfirm).not.toHaveBeenCalled();
    });

    it('shows a failure to identify in words, keeps the choice, and allows another try', async () => {
      ipc.linearIdentify.mockResolvedValueOnce(failed('Linear work is paused: sign in to "linear" again in Settings → Connectors.'));
      await mount([CHOICE, OTHER], snapshot());
      await choose('c2');
      await click('.pq-linear-identify');
      expect(text('.pq-linear-status-error')).toContain('Could not check who this signs in as: Linear work is paused: sign in');
      expect(q('.pq-linear-status-error')?.getAttribute('role')).toBe('alert');
      expect(q<HTMLSelectElement>('.pq-linear-select')?.value).toBe('c2');
      await click('.pq-linear-identify');
      expect(ipc.linearIdentify).toHaveBeenCalledTimes(2);
    });
  });

  describe('confirming', () => {
    async function openConfirm(): Promise<void> {
      await mount([CHOICE], snapshot());
      await click('.pq-linear-identify');
    }

    it('asks "Is this you?" with the name, email and workspace as plain text', async () => {
      await openConfirm();
      expect(text('.pq-linear-question')).toContain('signs in to Linear as Pat <b>Example</b> (pat@example.test), in Example Workspace. Is this you?');
      expect(root().querySelector('.pq-linear-confirm b')).toBeNull();
    });

    it('"Yes, use it" confirms the connector and the user it was shown, then shows the set-up panel', async () => {
      await openConfirm();
      await click('.pq-linear-yes');
      expect(ipc.linearConfirm).toHaveBeenCalledWith('c1', 'u-1');
      expect(q('.pq-linear-confirm')).toBeNull();
      expect(text('.pq-linear-summary')).toContain('Connector linear signs in to Linear as Pat Example, in Example Workspace.');
      expect(text('.pq-linear-status-ok')).toBe('Saved. Linear work can use this connection.');
    });

    it('"No" saves nothing and says so', async () => {
      await openConfirm();
      await click('.pq-linear-no');
      expect(ipc.linearConfirm).not.toHaveBeenCalled();
      expect(q('.pq-linear-confirm')).toBeNull();
      expect(text('.pq-linear-status')).toBe('Nothing was saved.');
    });

    it('shows a refusal because the sign-in changed, and asks again before another try', async () => {
      ipc.linearConfirm.mockResolvedValueOnce(failed('The Linear sign-in changed since it was shown to you. Check who it signs in as again.'));
      await openConfirm();
      await click('.pq-linear-yes');
      expect(text('.pq-linear-status-error')).toContain('Could not save: The Linear sign-in changed since it was shown to you.');
      expect(q('.pq-linear-confirm')).toBeNull();
      expect(q<HTMLButtonElement>('.pq-linear-identify')?.disabled).toBe(false);
    });
  });

  describe('set up', () => {
    it('shows the connector, who it signs in as, and no problem or badge when healthy', async () => {
      await mount([CHOICE], ready());
      expect(text('.pq-linear-summary')).toContain('Connector linear signs in to Linear as Pat Example, in Example Workspace.');
      expect(q('.pq-linear-problem')).toBeNull();
      expect(q('.pq-linear-status')).toBeNull();
      expect(q('.pq-linear-settings-link')).toBeNull();
    });

    it('"Test connection" runs the check and says the connection works', async () => {
      await mount([CHOICE], ready());
      await click('.pq-linear-test');
      expect(ipc.linearCheck).toHaveBeenCalledTimes(1);
      expect(text('.pq-linear-status-ok')).toBe('The connection works.');
    });

    it('"Test connection" that finds a problem shows its sentence and the one fix: a link to Connectors', async () => {
      const reason = 'Linear work is paused: sign in to "linear" again in Settings → Connectors.';
      ipc.linearCheck.mockResolvedValueOnce(ok(ready({ state: 'needs-sign-in', usable: false, reason })));
      await mount([CHOICE], ready());
      await click('.pq-linear-test');
      expect(text('.pq-linear-problem')).toBe(reason);
      expect(text('.pq-linear-status-error')).toContain('not working yet');
      expect(q<HTMLAnchorElement>('.pq-linear-settings-link')?.getAttribute('href')).toBe('/settings?tab=mcp');
      expect(q('.pq-linear-test')).not.toBeNull();
    });

    it('shows a failed test as an error that stays on screen', async () => {
      ipc.linearCheck.mockResolvedValueOnce(failed('No answer from Harness.'));
      await mount([CHOICE], ready());
      await click('.pq-linear-test');
      expect(text('.pq-linear-status-error')).toBe('Could not test the connection: No answer from Harness.');
    });

    it('offers "Check who this signs in as" for the saved connector when it now signs in as someone else', async () => {
      const reason = 'Linear work is paused: "linear" now signs in to Linear as someone other than the person you confirmed.';
      await mount([CHOICE], ready({ state: 'someone-else', usable: false, reason }));
      expect(text('.pq-linear-problem')).toBe(reason);
      expect(q('.pq-linear-settings-link')).toBeNull();
      await click('.pq-linear-identify');
      expect(ipc.linearIdentify).toHaveBeenCalledWith('c1');
      expect(q('.pq-linear-confirm')).not.toBeNull();
    });

    it('goes back to choosing a connector when the saved one was removed', async () => {
      const reason = 'Linear work is paused: the Linear connector you chose has been removed. Choose one on the Plan Queue page.';
      await mount([OTHER], ready({ state: 'connector-changed', usable: false, reason, connectorProblem: 'gone', connectorName: null }));
      expect(text('.pq-linear-problem')).toBe(reason);
      expect(q('.pq-linear-select')).not.toBeNull();
      expect(q('.pq-linear-summary')).toBeNull();
    });

    it('waits for the first check after a restart instead of staying on "checking"', async () => {
      ipc.linearCheck.mockResolvedValueOnce(ok(ready()));
      await mount([CHOICE], ready({ state: 'checking', usable: false, reason: 'Linear work is paused while Harness checks the connection to "linear".' }));
      expect(ipc.linearCheck).toHaveBeenCalledTimes(1);
      expect(q('.pq-linear-problem')).toBeNull();
    });
  });

  describe('stop using this connector', () => {
    it('asks first, saying that Linear work will stop, and calls nothing until yes', async () => {
      await mount([CHOICE], ready());
      await click('.pq-linear-stop');
      expect(text('.pq-linear-stop-confirm')).toContain('Linear work will stop until you choose a connector again.');
      expect(ipc.linearForget).not.toHaveBeenCalled();
      await click('.pq-linear-stop-no');
      expect(q('.pq-linear-stop-confirm')).toBeNull();
      expect(ipc.linearForget).not.toHaveBeenCalled();
    });

    it('forgets the connection on yes and goes back to choosing', async () => {
      await mount([CHOICE], ready());
      await click('.pq-linear-stop');
      await click('.pq-linear-stop-yes');
      expect(ipc.linearForget).toHaveBeenCalledTimes(1);
      expect(q('.pq-linear-summary')).toBeNull();
      expect(q('.pq-linear-select, .pq-linear-identify')).not.toBeNull();
      expect(text('.pq-linear-status-ok')).toContain('Linear work is paused until you choose a connector again.');
    });

    it('shows a failure to forget and keeps the connection', async () => {
      ipc.linearForget.mockResolvedValueOnce(failed('Settings could not be saved.'));
      await mount([CHOICE], ready());
      await click('.pq-linear-stop');
      await click('.pq-linear-stop-yes');
      expect(text('.pq-linear-status-error')).toBe('Could not stop using the connector: Settings could not be saved.');
      expect(q('.pq-linear-summary')).not.toBeNull();
    });
  });

  describe('following the saved setting', () => {
    it('reads the connection again when the saved connection changes elsewhere, and not otherwise', async () => {
      await mount([CHOICE], snapshot());
      expect(ipc.linearList).toHaveBeenCalledTimes(1);
      settings.set({ planQueueLinearConnection: null });
      await flush();
      expect(ipc.linearList).toHaveBeenCalledTimes(1);
      ipc.linearList.mockResolvedValue(ok({ connectors: [CHOICE], connection: ready() }));
      settings.set({ planQueueLinearConnection: { connectorId: 'c1' } });
      await flush();
      expect(ipc.linearList).toHaveBeenCalledTimes(2);
      expect(q('.pq-linear-summary')).not.toBeNull();
    });

    it('shows an error when the connection cannot be read', async () => {
      ipc.linearList.mockResolvedValue(failed('Not in Electron'));
      fixture = TestBed.createComponent(PlanQueueLinearConnectionPanelComponent);
      fixture.detectChanges();
      await flush();
      expect(text('.pq-linear-status-error')).toBe('Could not read the Linear connection: Not in Electron');
    });
  });
});
