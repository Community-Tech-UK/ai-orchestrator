/**
 * An error whose explanation the adapter already put in the transcript. Callers
 * that would otherwise print their own notice for it must not repeat it: the
 * adapter's notice is the accurate one, and a generic second notice (for
 * example "the initial message could not be delivered") can be false.
 */
export interface SurfacedToUserError extends Error {
  readonly surfacedToUser: true;
}

export function isSurfacedToUserError(error: unknown): error is SurfacedToUserError {
  return error instanceof Error && (error as Partial<SurfacedToUserError>).surfacedToUser === true;
}
