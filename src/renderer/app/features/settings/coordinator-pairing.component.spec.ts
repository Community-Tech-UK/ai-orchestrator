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
import type { PairBothCandidate, PairBothSessionState } from '../../../../shared/types/pair-both.types';

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

  beforeEach(async () => {
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
