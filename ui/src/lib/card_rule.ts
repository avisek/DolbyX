/**
 * The card rule (CONTEXT.md "Row"): a `label` is its primary control's
 * hit area, but a click landing inside a nested control that manages
 * its own focus must keep it — otherwise the label would forward the
 * click to the `for` target. Returns the label's click guard: cancels
 * the activation when the target sits inside `selectors`.
 *
 * Bind it with `on:click` (a native listener, not Solid's delegated
 * one): the guard must have run by the time the label's activation
 * behavior asks whether the click was cancelled.
 */
export function cardRule(selectors: string): (event: MouseEvent) => void {
  return (event) => {
    if (event.target instanceof Element && event.target.closest(selectors)) {
      event.preventDefault()
    }
  }
}
