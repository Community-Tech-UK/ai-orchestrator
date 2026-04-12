/**
 * Adler-32 rolling checksum — used as the "weak" hash in the rsync delta
 * algorithm. O(1) to slide the window by one byte, which makes scanning
 * for matching blocks very fast.
 *
 * The checksum is split into two 16-bit halves:
 *   a = 1 + sum of all bytes         (mod MOD)
 *   b = sum of all running `a` values (mod MOD)
 *   digest = (b << 16) | a
 *
 * Rolling update when the window slides by one position:
 *   a' = a - oldByte + newByte
 *   b' = b - windowSize * oldByte + a'
 */

const MOD = 65521; // largest prime < 2^16

export class RollingChecksum {
  private a = 1;
  private b = 0;
  private count = 0;

  /** Feed a full buffer to initialise the checksum. */
  update(buf: Buffer, offset = 0, length?: number): void {
    const end = offset + (length ?? buf.length - offset);
    for (let i = offset; i < end; i++) {
      this.a = (this.a + buf[i]) % MOD;
      this.b = (this.b + this.a) % MOD;
      this.count++;
    }
  }

  /** Slide the window by one byte — O(1). */
  roll(oldByte: number, newByte: number, windowSize: number): void {
    this.a = (this.a - oldByte + newByte + MOD) % MOD;
    this.b =
      (this.b -
        windowSize * oldByte +
        this.a -
        1 +
        MOD * Math.ceil((windowSize * 256) / MOD)) %
      MOD;
  }

  /** Return the 32-bit digest. */
  digest(): number {
    return ((this.b & 0xffff) << 16) | (this.a & 0xffff);
  }

  /** Reset to initial state. */
  reset(): void {
    this.a = 1;
    this.b = 0;
    this.count = 0;
  }
}

/**
 * Compute Adler-32 for a buffer in one shot (non-rolling).
 * Useful for computing block signatures.
 */
export function adler32(buf: Buffer, offset = 0, length?: number): number {
  const rc = new RollingChecksum();
  rc.update(buf, offset, length);
  return rc.digest();
}
