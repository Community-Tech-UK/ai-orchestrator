/**
 * Continuity payload envelope serialisation.
 *
 * Continuity files store their payload as a JSON string inside an envelope:
 * `{"encrypted":false,"data":"<the payload's own JSON>"}`. Building that with
 * `JSON.stringify({ encrypted, data })` hands V8 one string as long as the
 * whole session state, and the V8 in Electron 40 (14.4) aborts the process
 * instead of throwing when that string is long enough: its fast stringifier
 * reserves 8 output characters per input character up front, and a
 * reservation over INT_MAX bytes is a fatal "Zone" OOM. For a two-byte string
 * that is anything over ~134M characters. A restored 19k-message Codex thread
 * produced a 198M-character state and took the whole app down on 2026-10-08.
 * Upstream fix: v8/v8@8a1da7c84b ("Bailout to slow-path if a string could
 * exceed max len"), not yet in any Electron release.
 *
 * The helpers here produce exactly the bytes `JSON.stringify` would, but never
 * pass V8 a string longer than {@link JSON_STRING_CHUNK_CHARS}, so the file
 * format and every reader stay unchanged.
 */

/** Largest slice handed to `JSON.stringify`; reserves at most 16 MiB. */
export const JSON_STRING_CHUNK_CHARS = 1 << 20;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Byte-for-byte equivalent of `JSON.stringify(value)` for a string, escaped in
 * bounded slices. A slice never ends between the halves of a surrogate pair:
 * `JSON.stringify` would escape each half on its own and the output would
 * differ from a single call.
 */
export function stringifyJsonStringLiteral(
  value: string,
  chunkChars = JSON_STRING_CHUNK_CHARS,
): string {
  if (!Number.isInteger(chunkChars) || chunkChars < 1) {
    throw new RangeError(`chunkChars must be a positive integer, got ${chunkChars}`);
  }
  if (value.length <= chunkChars) {
    return JSON.stringify(value);
  }

  const parts: string[] = ['"'];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(start + chunkChars, value.length);
    if (
      end < value.length
      && isHighSurrogate(value.charCodeAt(end - 1))
      && isLowSurrogate(value.charCodeAt(end))
    ) {
      end += 1;
    }
    const escaped = JSON.stringify(value.slice(start, end));
    parts.push(escaped.slice(1, -1));
    start = end;
  }
  parts.push('"');
  return parts.join('');
}

/**
 * The continuity envelope, identical to
 * `JSON.stringify({ encrypted, data })` but safe for any `data` length.
 */
export function stringifyContinuityEnvelope(encrypted: boolean, data: string): string {
  return `{"encrypted":${encrypted},"data":${stringifyJsonStringLiteral(data)}}`;
}
