export function hasFailedEvidenceCapture(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const capture = Reflect.get(value, 'capture');
  return Boolean(
    capture
      && typeof capture === 'object'
      && Reflect.get(capture, 'status') === 'failed',
  );
}

export function providerResultAfterCapture(captureResult: unknown, fallback: unknown): unknown {
  if (!captureResult || typeof captureResult !== 'object') return fallback;
  return Object.prototype.hasOwnProperty.call(captureResult, 'providerResult')
    ? Reflect.get(captureResult, 'providerResult')
    : fallback;
}
