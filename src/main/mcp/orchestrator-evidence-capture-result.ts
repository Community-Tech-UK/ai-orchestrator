export function hasFailedEvidenceCapture(value: unknown, conversationId: string): boolean {
  if (!value || typeof value !== 'object') return true;
  const capture = Reflect.get(value, 'capture');
  if (!capture || typeof capture !== 'object') return true;
  const status = Reflect.get(capture, 'status');
  if (status !== 'captured' && status !== 'duplicate') return true;
  const record = Reflect.get(capture, 'record');
  return !record || typeof record !== 'object'
    || typeof Reflect.get(record, 'id') !== 'string' || !Reflect.get(record, 'id')
    || Reflect.get(record, 'status') !== 'complete'
    || Reflect.get(record, 'conversationId') !== conversationId;
}

const CAPTURE_FAILURE_CODES = new Set([
  'CAPTURE_INVALID_REQUEST', 'CAPTURE_STAGE_FAILED', 'CAPTURE_IN_PROGRESS',
  'CAPTURE_INVALID_STATE', 'CAPTURE_FINALIZE_PENDING', 'CAPTURE_BLOB_WRITE_FAILED',
  'CAPTURE_EXISTING_RECORD_INVALID', 'EVIDENCE_CAPTURE_KEY_CONTENT_CONFLICT',
  'CAPTURE_IDENTITY_CHECK_FAILED',
]);

/** Never relay arbitrary storage exception/errorCode content into tool errors. */
export function evidenceCaptureFailureCode(value: unknown): string {
  if (!value || typeof value !== 'object') return 'CAPTURE_INVALID_RECEIPT';
  const capture = Reflect.get(value, 'capture');
  if (!capture || typeof capture !== 'object') return 'CAPTURE_INVALID_RECEIPT';
  const code = Reflect.get(capture, 'errorCode');
  return typeof code === 'string' && CAPTURE_FAILURE_CODES.has(code)
    ? code
    : 'CAPTURE_INVALID_RECEIPT';
}

export function providerResultAfterCapture(captureResult: unknown, fallback: unknown): unknown {
  if (!captureResult || typeof captureResult !== 'object') return fallback;
  return Object.prototype.hasOwnProperty.call(captureResult, 'providerResult')
    ? Reflect.get(captureResult, 'providerResult')
    : fallback;
}
