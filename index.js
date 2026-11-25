/**
 * Host half of the context-inspector bundle.
 *
 * The panel is a browser-side view: it folds the Session event window the
 * client already holds and reads the `tokenUsage`, `contextPressure`, and
 * `contextBreakdown` projections the token-meter unit serves. Nothing is
 * registered on the Host, no tool or prompt section is added, and the bundle
 * makes no model calls.
 */
export function apply() {}
