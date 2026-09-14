/**
 * Time as an injectable dependency. Domain code takes a `Clock` instead of calling `Date.now()`
 * so tests can pin the time without faking global timers.
 */

/** Returns the current time in epoch milliseconds. */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();
