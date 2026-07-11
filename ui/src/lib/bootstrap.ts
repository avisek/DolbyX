import type { ParameterDef } from './parameters'
import type { StateSnapshot } from './ws'

/**
 * The daemon replaces `<!--BOOTSTRAP-->` in the served HTML at request
 * time with a script defining `window.__BOOTSTRAP__` (ADR-0006): the full
 * parameter table + initial state, read synchronously at module init so
 * the first paint is fully populated. Produced by Slice 04 (#12); there
 * is deliberately no `/api/*`.
 */
export interface Bootstrap {
  readonly params: readonly ParameterDef[]
  readonly state: StateSnapshot
}

declare global {
  interface Window {
    /** Absent when :5173 is visited directly — `main.tsx` redirects. */
    __BOOTSTRAP__?: Bootstrap
  }
}
