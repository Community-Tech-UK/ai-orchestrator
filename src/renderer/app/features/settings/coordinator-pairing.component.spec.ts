import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { vi, type Mocked } from 'vitest';
import {
  PairBothIpcService,
  type PairBothCoordinatorStartResult,
} from '../../core/services/ipc/pair-both-ipc.service';
import { CLIPBOARD_SERVICE, type ClipboardService } from '../../core/services/clipboard.service';
import { CoordinatorPairingComponent } from './coordinator-pairing.component';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import type { PairBothCandidate, PairBothSessionState } from '../../../../shared/types/pair-both.types';
import type { RemoteNodeRosterEntry } from '../../../../shared/types/worker-node.types';

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn(async () => 'data:image/png;base64,qr'),
  },
}));

describe('CoordinatorPairingComponent', () => {
  let fixture: ComponentFixture<CoordinatorPairingComponent>;
  let pairBoth: Mocked<Pick<
    PairBothIpcService,
    | 'startCoordinatorPairing'
    | 'stopCoordinatorPairing'
    | 'approveCoordinatorPairing'
    | 'rejectCoordinatorPairing'
    | 'getCoordinatorState'
  >>;
  const connectedNodes = signal<Pick<RemoteNodeRosterEntry, 'id' | 'name'>[]>([]);
  /** What the next store refresh loads (null: leave the list as it is; 'fail': reject). */
  let nodesOnRefresh: Pick<RemoteNodeRosterEntry, 'id' | 'name'>[] | null | 'fail' = null;

  beforeEach(async () => {
    connectedNodes.set([]);
    nodesOnRefresh = null;
    pairBoth = {
      startCoordinatorPairing: vi.fn(),
      stopCoordinatorPairing: vi.fn().mockResolvedValue(undefined),
      approveCoordinatorPairing: vi.fn(),
      rejectCoordinatorPairing: vi.fn(),
      getCoordinatorState: vi.fn(),
    };

    const clipboard: Pick<ClipboardService, 'lastResult' | 'copyText'> = {
      lastResult: signal(null),
      copyText: vi.fn().mockResolvedValue({ ok: true }),
    };

    await TestBed.configureTestingModule({
      imports: [CoordinatorPairingComponent],
      providers: [
        { provide: PairBothIpcService, useValue: pairBoth },
        { provide: CLIPBOARD_SERVICE, useValue: clipboard },
        {
          provide: RemoteNodeStore,
          useValue: {
            connectedNodes,
            initialize: vi.fn().mockResolvedValue(undefined),
            refresh: vi.fn(async () => {
              if (nodesOnRefresh === 'fail') throw new Error('Remote node list unavailable');
              if (nodesOnRefresh) connectedNodes.set(nodesOnRefresh);
            }),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(CoordinatorPairingComponent);
    fixture.detectChanges();
  });

  it('keeps waiting when coordinator approves before the worker confirms the code', async () => {
    const candidate = makeCandidate();
    const confirming = makeState(candidate, {
      status: 'confirming',
      shortCode: '482 913',
      workerHello: {
        protocolVersion: '1',
        role: 'worker',
        machineName: 'Noah PC',
        nonce: 'worker-nonce',
        publicKey: 'worker-public-key-material',
        pairingSessionId: candidate.pairingSessionId,
      },
    });
    pairBoth.approveCoordinatorPairing.mockResolvedValueOnce(makeState(candidate, {
      ...confirming,
      coordinatorApproved: true,
    }));

    const component = fixture.componentInstance as unknown as {
      uiState: { set(value: string): void };
      session: { set(value: PairBothSessionState): void };
    };
    component.session.set(confirming);
    component.uiState.set('confirming');
    fixture.detectChanges();

    const approve = fixture.debugElement.query(By.css('.btn-primary'));
    approve.nativeElement.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(pairBoth.approveCoordinatorPairing).toHaveBeenCalledWith(candidate.pairingSessionId);
    expect(fixture.nativeElement.textContent).toContain('Waiting for Noah PC to confirm the code');
    expect(fixture.nativeElement.textContent).not.toContain('Pairing approved. The worker can now register normally.');
  });

  it('tells the user to start the worker, then says when it connects', async () => {
    connectedNodes.set([{ id: 'windows-pc', name: 'windows-pc' }]);
    const candidate = makeCandidate();
    const workerHello = {
      protocolVersion: '1',
      role: 'worker' as const,
      machineName: 'Noah PC',
      nonce: 'worker-nonce',
      publicKey: 'worker-public-key-material',
      pairingSessionId: candidate.pairingSessionId,
    };
    const component = fixture.componentInstance as unknown as {
      applySessionUiState(state: PairBothSessionState): void;
    };
    component.applySessionUiState(makeState(candidate, {
      status: 'completed',
      payloadDelivered: true,
      workerHello,
    }));
    await fixture.whenStable();
    fixture.detectChanges();

    const text = (): string => fixture.nativeElement.textContent;
    expect(text()).toContain('Paired with Noah PC.');
    expect(text()).toContain('Now press Start Worker on Noah PC.');
    expect(text()).not.toContain('register normally');

    connectedNodes.set([
      { id: 'windows-pc', name: 'windows-pc' },
      { id: 'other', name: 'other-laptop' },
      { id: 'node-9', name: 'Noah PC' },
    ]);
    fixture.detectChanges();

    // Prefers the computer named like the one that just paired.
    expect(text()).toContain('Noah PC is connected. Your main Harness can now send it work.');
  });

  it('does not mistake an already-online computer for the new one when the list loads late', async () => {
    // The store has not loaded yet; the refresh at completion loads windows-pc.
    nodesOnRefresh = [{ id: 'windows-pc', name: 'windows-pc' }];
    const component = fixture.componentInstance as unknown as {
      applySessionUiState(state: PairBothSessionState): void;
    };
    component.applySessionUiState(makeState(makeCandidate(), { status: 'completed', payloadDelivered: true }));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Now press Start Worker on the other computer.');
    expect(fixture.nativeElement.textContent).not.toContain('is connected');
  });

  it('names no computer when the node list could not be loaded', async () => {
    nodesOnRefresh = 'fail';
    const component = fixture.componentInstance as unknown as {
      applySessionUiState(state: PairBothSessionState): void;
    };
    component.applySessionUiState(makeState(makeCandidate(), { status: 'completed', payloadDelivered: true }));
    await fixture.whenStable();
    connectedNodes.set([{ id: 'windows-pc', name: 'windows-pc' }]);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Now press Start Worker on the other computer.');
    expect(fixture.nativeElement.textContent).not.toContain('is connected');
  });

  it('does not treat a similar but different name as the paired computer', async () => {
    const component = fixture.componentInstance as unknown as {
      applySessionUiState(state: PairBothSessionState): void;
    };
    component.applySessionUiState(makeState(makeCandidate(), {
      status: 'completed',
      payloadDelivered: true,
      workerHello: workerHelloFor('Noah PC'),
    }));
    await fixture.whenStable();
    connectedNodes.set([{ id: 'other', name: 'Noah-PC.local' }]);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).not.toContain('is connected');
  });

  it('names nobody when two new computers share the paired name', async () => {
    const component = fixture.componentInstance as unknown as {
      applySessionUiState(state: PairBothSessionState): void;
    };
    component.applySessionUiState(makeState(makeCandidate(), {
      status: 'completed',
      payloadDelivered: true,
      workerHello: workerHelloFor('Noah PC'),
    }));
    await fixture.whenStable();
    connectedNodes.set([{ id: 'a', name: 'Noah PC' }, { id: 'b', name: 'Noah PC' }]);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).not.toContain('is connected');
  });

  it('never names a different computer that happens to come online', async () => {
    const component = fixture.componentInstance as unknown as {
      applySessionUiState(state: PairBothSessionState): void;
    };
    component.applySessionUiState(makeState(makeCandidate(), {
      status: 'completed',
      payloadDelivered: true,
      workerHello: workerHelloFor('Noah PC'),
    }));
    await fixture.whenStable();
    connectedNodes.set([{ id: 'laptop', name: 'laptop' }]);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Now press Start Worker on Noah PC.');
    expect(fixture.nativeElement.textContent).not.toContain('is connected');
  });

  it('tries the node list again when it could not be loaded at first', async () => {
    vi.useFakeTimers();
    try {
      nodesOnRefresh = 'fail';
      const component = fixture.componentInstance as unknown as {
        applySessionUiState(state: PairBothSessionState): void;
      };
      component.applySessionUiState(makeState(makeCandidate(), {
        status: 'completed',
        payloadDelivered: true,
        workerHello: workerHelloFor('Noah PC'),
      }));
      await vi.advanceTimersByTimeAsync(0);
      nodesOnRefresh = [{ id: 'windows-pc', name: 'windows-pc' }];
      await vi.advanceTimersByTimeAsync(5_000);

      connectedNodes.set([{ id: 'windows-pc', name: 'windows-pc' }, { id: 'node-9', name: 'NOAH PC' }]);
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain('NOAH PC is connected.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts a re-paired computer that drops off and comes back as connected', async () => {
    connectedNodes.set([{ id: 'node-9', name: 'Noah PC' }]);
    const candidate = makeCandidate();
    const component = fixture.componentInstance as unknown as {
      applySessionUiState(state: PairBothSessionState): void;
    };
    component.applySessionUiState(makeState(candidate, {
      status: 'completed',
      payloadDelivered: true,
      workerHello: workerHelloFor('Noah PC'),
    }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Now press Start Worker on Noah PC.');

    connectedNodes.set([]);
    fixture.detectChanges();
    connectedNodes.set([{ id: 'node-9', name: 'Noah PC' }]);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Noah PC is connected.');
  });

  it('shows a QR fallback alongside the copyable pairing invitation', async () => {
    const candidate = makeCandidate();
    const state = makeState(candidate);
    const invitation = JSON.stringify(candidate);
    const active: PairBothCoordinatorStartResult = { state, candidate, invitation };
    pairBoth.startCoordinatorPairing.mockResolvedValueOnce(active);

    const startButton = fixture.debugElement.query(By.css('.btn-primary'));
    startButton.nativeElement.click();
    await fixture.whenStable();
    fixture.detectChanges();

    const qr = fixture.debugElement.query(By.css('img.invitation-qr'));
    expect(qr).not.toBeNull();
    expect(qr.nativeElement.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    expect(fixture.nativeElement.textContent).toContain('Copy Invitation');
  });
});

function workerHelloFor(machineName: string): NonNullable<PairBothSessionState['workerHello']> {
  return {
    protocolVersion: '1',
    role: 'worker',
    machineName,
    nonce: 'worker-nonce',
    publicKey: 'worker-public-key-material',
    pairingSessionId: 'session-1',
  };
}

function makeCandidate(): PairBothCandidate {
  return {
    id: 'pair-both:session-1:192.168.1.20:49152',
    product: 'Harness',
    protocol: 'aio-worker-pair-v1',
    protocolVersion: '1',
    pairingSessionId: 'session-1',
    friendlyName: 'James MacBook',
    namespace: 'default',
    port: 49152,
    coordinatorPublicKey: 'coordinator-public-key-material',
    expiresAt: Date.now() + 60_000,
    host: '192.168.1.20',
    addresses: ['192.168.1.20'],
  };
}

function makeState(
  candidate: PairBothCandidate,
  patch: Partial<PairBothSessionState> = {},
): PairBothSessionState {
  return {
    sessionId: candidate.pairingSessionId,
    status: 'waiting',
    protocolVersion: candidate.protocolVersion,
    machineName: candidate.friendlyName,
    namespace: candidate.namespace,
    listenerPort: candidate.port,
    coordinatorUrl: 'ws://192.168.1.20:4878',
    expiresAt: candidate.expiresAt,
    coordinatorHello: {
      protocolVersion: candidate.protocolVersion,
      role: 'coordinator',
      machineName: candidate.friendlyName,
      nonce: 'coordinator-nonce',
      publicKey: candidate.coordinatorPublicKey,
      pairingSessionId: candidate.pairingSessionId,
    },
    workerConfirmed: false,
    coordinatorApproved: false,
    payloadDelivered: false,
    ...patch,
  };
}
