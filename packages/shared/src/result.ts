/**
 * Minimal discriminated-union result type so packages can return failures
 * without throwing across extension message boundaries.
 */
export type Ok<T> = { ok: true; value: T };
export type Err<E = string> = { ok: false; error: E };
export type Result<T, E = string> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E = string>(error: E): Err<E> => ({ ok: false, error });
