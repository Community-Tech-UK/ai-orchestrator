import { NO_ERRORS_SCHEMA } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostStore } from '../../core/host-store';
import { QrScannerService } from '../../core/qr-scanner.service';
import { AddHostComponent } from './add-host.component';

const payload = { v: 1, host: 'example.test', port: 4879, pairingToken: 'PLACEHOLDER_PAIRING', secure: true };
function setup(native = false) {
  const scan = vi.fn().mockResolvedValue(JSON.stringify(payload));
  const addHost = vi.fn().mockResolvedValue(undefined);
  const setActive = vi.fn().mockResolvedValue(undefined);
  const navigate = vi.fn();
  TestBed.configureTestingModule({ imports: [AddHostComponent], providers: [
    { provide: HostStore, useValue: { addHost, setActive } },
    { provide: Router, useValue: { navigate } },
    { provide: QrScannerService, useValue: { available: native, scan } },
  ] });
  TestBed.overrideComponent(AddHostComponent, { set: { imports: [FormsModule], schemas: [NO_ERRORS_SCHEMA] } });
  const fixture = TestBed.createComponent(AddHostComponent);
  fixture.detectChanges();
  const button = (label: string) => [...fixture.nativeElement.querySelectorAll('button')].find((el) => (el as HTMLButtonElement).textContent?.trim() === label) as HTMLButtonElement;
  const enter = async (selector: string, value: string) => {
    const input = fixture.nativeElement.querySelector(selector) as HTMLInputElement;
    input.value = value; input.dispatchEvent(new Event('input')); fixture.detectChanges(); await fixture.whenStable();
  };
  return { fixture, button, enter, scan, addHost, setActive, navigate };
}
afterEach(() => vi.unstubAllGlobals());

describe('guided host pairing', () => {
  it('keeps technical fields behind Manual setup', () => {
    const { fixture, button } = setup();
    expect(fixture.nativeElement.querySelector('input[type=number]')).toBeNull();
    expect(button('Paste connection code')).toBeTruthy();
    button('Manual setup').click(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('input[type=number]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[autocomplete="new-password"]').type).toBe('password');
  });

  it('reviews a scanned connection without sending a pairing request', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const { fixture, button } = setup(true);
    button('Scan QR code').click(); await fixture.whenStable(); fixture.detectChanges();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('.connection-summary').textContent).toContain('example.test:4879');
    expect(fixture.nativeElement.textContent).not.toContain(payload.pairingToken);
    expect(button('Pair host')).toBeTruthy();
  });

  it('pairs from the pasted summary and selects the returned device identity', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ deviceId: 'device-new', token: 'PLACEHOLDER_DEVICE', hostName: 'Example', expiresAt: 100 }) });
    vi.stubGlobal('fetch', fetchMock);
    const { fixture, button, enter, addHost, setActive, navigate } = setup();
    button('Paste connection code').click(); fixture.detectChanges();
    await enter('#connection-code', JSON.stringify(payload));
    button('Review connection').click(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#connection-code')).toBeNull();
    button('Pair host').click(); await fixture.whenStable(); fixture.detectChanges();
    expect(fetchMock.mock.calls[0][0]).toBe('https://example.test:4879/pair');
    expect(addHost).toHaveBeenCalledWith(expect.objectContaining({ id: 'device-new', host: payload.host, token: 'PLACEHOLDER_DEVICE', secure: true }));
    expect(setActive).toHaveBeenCalledWith('device-new');
    expect(navigate).toHaveBeenCalledWith(['/projects']);
  });

  it('rejects an incomplete replacement code instead of reusing the previous token', async () => {
    const { fixture, button, enter } = setup();
    button('Paste connection code').click(); fixture.detectChanges();
    await enter('#connection-code', JSON.stringify(payload)); button('Review connection').click(); fixture.detectChanges();
    button('Use another code').click(); fixture.detectChanges();
    await enter('#connection-code', JSON.stringify({ v: 1, host: 'other.test', port: 4879 }));
    button('Review connection').click(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role=alert]').textContent).toContain('pairing token');
    expect(button('Pair host')).toBeUndefined();
  });

  it('moves keyboard focus to the summary after parsing', async () => {
    const { fixture, button, enter } = setup();
    button('Paste connection code').click(); fixture.detectChanges();
    await enter('#connection-code', JSON.stringify(payload));
    button('Review connection').click(); fixture.detectChanges(); await fixture.whenStable();
    expect(document.activeElement).toBe(fixture.nativeElement.querySelector('#connection-summary-title'));
  });

  it('keeps manual validation next to the form and pairs from its reviewed values', async () => {
    const { fixture, button, enter } = setup();
    button('Manual setup').click(); fixture.detectChanges();
    await enter('[placeholder="Host IP or name"]', 'example.test');
    await enter('[placeholder="One-time token"]', 'PLACEHOLDER_PAIRING');
    await enter('input[type=number]', '65536');
    button('Review connection').click(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role=alert]').textContent).toContain('65535');
    await enter('input[type=number]', '4879');
    button('Review connection').click(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.connection-summary').textContent).toContain('example.test:4879');
    expect(fixture.nativeElement.querySelector('input[type=password]')).toBeNull();
  });

  it('blocks duplicate pairing and provides safe retry guidance after rejection', async () => {
    let finish!: (response: unknown) => void;
    const fetchMock = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const { fixture, button, enter } = setup();
    button('Paste connection code').click(); fixture.detectChanges();
    await enter('#connection-code', JSON.stringify(payload)); button('Review connection').click(); fixture.detectChanges();
    const pairButton = button('Pair host'); pairButton.click(); pairButton.click(); fixture.detectChanges();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(button('Use another code').disabled).toBe(true);
    finish({ ok: false, status: 403, json: async () => ({ error: 'PLACEHOLDER_PRIVATE_RESPONSE' }) });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[role=alert]')?.textContent).toContain('Generate a new code');
    });
    expect(fixture.nativeElement.textContent).not.toContain('PLACEHOLDER');
    expect(button('Use another code').disabled).toBe(false);
  });
});
