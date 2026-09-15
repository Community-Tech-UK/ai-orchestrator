/** Folder presets carry host provenance in browser history, never just a URL path. */
export function newSessionPresetState(hostId: string | null | undefined, directory: string | undefined) {
  return { mobileNewSessionPreset: { hostId: hostId ?? null, directory: directory ?? '' } };
}

export function trustedNewSessionDirectory(state: unknown, hostId: string, directory: string): string {
  if (!hostId || !directory || directory === '__no_workspace__' || !state || typeof state !== 'object') return '';
  const preset = (state as Record<string, unknown>)['mobileNewSessionPreset'];
  if (!preset || typeof preset !== 'object') return '';
  const value = preset as Record<string, unknown>;
  return value['hostId'] === hostId && value['directory'] === directory ? directory : '';
}
