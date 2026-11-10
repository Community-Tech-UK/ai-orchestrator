import type { PersonInputOrigin } from '../../shared/types/input-provenance.types';

/**
 * The origin stored on a message a person typed. A caller-supplied time is
 * never later than now, so a renderer clock ahead of this one cannot make a
 * message look newer than it is.
 */
export function personInputOrigin(origin: PersonInputOrigin): PersonInputOrigin {
  return { kind: 'person', typedAt: Math.min(origin.typedAt, Date.now()) };
}

/** Metadata copied into another session: who typed it there does not carry over. */
export function withoutInputOrigin<T extends { inputOrigin?: unknown }>(metadata: T | undefined): Omit<T, 'inputOrigin'> {
  const { inputOrigin: _dropped, ...rest } = metadata ?? ({} as T);
  return rest;
}
