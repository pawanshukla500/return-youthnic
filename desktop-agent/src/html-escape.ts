/**
 * Escaping for the small HTML pages the engine and the desktop shell render
 * themselves.
 *
 * Two contexts must never be confused:
 *
 *   - Text and attribute values need HTML entity escaping, or a quote in the
 *     value closes the attribute and the rest is parsed as markup.
 *   - A value embedded in an inline `<script>` must be a valid JavaScript
 *     literal *and* must not be able to close the script element. `JSON.stringify`
 *     gives the first, but it leaves `<` alone, so a value containing
 *     `</script>` would end the block and the remainder would be parsed as
 *     markup. Escaping `<` as `\u003c` fixes that; the two Unicode line
 *     separators are also escaped because they are literal line breaks in
 *     JavaScript source and would break a string literal.
 *
 * Pure, so both are covered by desktop-agent/html-escape.test.ts. The values
 * here are operator-controlled (a configured engine URL, a Chromium failure
 * message), not attacker-supplied, but the renderer carries the preload bridge,
 * so this is not a boundary worth leaving to luck.
 */

/** Escape a value for HTML text and double- or single-quoted attributes. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/**
 * Render a value as an inline-script-safe JavaScript literal.
 *
 * Use the result directly after `=`, or as a function argument. The result is
 * already a complete literal (quoted when it is a string), so it is never
 * wrapped in quotes at the call site.
 */
export function scriptLiteral(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}
