export type InputRequiredScope = 'once' | 'session' | 'always';

export interface InputRequiredRequestLike {
  instanceId: string;
  requestType: string;
  permissionMetadata?: {
    type?: string;
  };
}

export function isPermissionDenialRequest(
  request: InputRequiredRequestLike,
): boolean {
  return request.requestType === 'input_required'
    && request.permissionMetadata?.type === 'permission_denial';
}

export function shouldClearInputRequiredForYolo(
  request: InputRequiredRequestLike,
): boolean {
  return request.requestType === 'input_required'
    && !isPermissionDenialRequest(request);
}

export function shouldClearRequestAfterYoloEnabled(
  request: InputRequiredRequestLike,
  instanceId: string,
): boolean {
  return request.instanceId === instanceId
    && shouldClearInputRequiredForYolo(request);
}

export function canResolveInputRequiredWithYolo(
  request: InputRequiredRequestLike,
): boolean {
  return request.requestType === 'input_required'
    && !isPermissionDenialRequest(request);
}

export function defaultInputRequiredScope(
  metadata: InputRequiredRequestLike['permissionMetadata'] | undefined,
): InputRequiredScope {
  return metadata?.type === 'permission_denial' ? 'always' : 'once';
}
