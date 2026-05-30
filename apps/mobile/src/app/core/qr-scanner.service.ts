import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';

/**
 * Thin wrapper over the device camera barcode scanner. Returns the decoded text
 * of the first QR found (the desktop pairing payload), or null if scanning is
 * unavailable (web/dev) or the user cancels.
 */
@Injectable({ providedIn: 'root' })
export class QrScannerService {
  /** True only where a native camera scanner is available. */
  get available(): boolean {
    return Capacitor.isNativePlatform();
  }

  async scan(): Promise<string | null> {
    if (!Capacitor.isNativePlatform()) {
      return null;
    }
    try {
      const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning');
      const permission = await BarcodeScanner.requestPermissions();
      if (permission.camera !== 'granted' && permission.camera !== 'limited') {
        return null;
      }
      const { barcodes } = await BarcodeScanner.scan();
      return barcodes[0]?.rawValue ?? null;
    } catch {
      return null;
    }
  }
}
