import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { escapeHtml, scriptLiteral } from "./src/html-escape.js"

/**
 * The desktop shell renders a small offline page when the engine cannot be
 * reached. It interpolates the engine URL and the Chromium failure message into
 * both HTML and an inline script, in a window that carries the preload bridge.
 * CodeAnt flagged the URL's quote handling; these tests pin the escaping so a
 * single quote in a URL fragment can never end a JavaScript string literal.
 */

describe("HTML escaping", () => {
  it("escapes the characters that change the parse", () => {
    assert.equal(escapeHtml(`<script>alert("x")</script>`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;")
    assert.equal(escapeHtml("it's"), "it&#39;s")
    assert.equal(escapeHtml("a & b"), "a &amp; b")
  })

  it("escapes the ampersand first so an entity is not double-decoded", () => {
    assert.equal(escapeHtml("&lt;"), "&amp;lt;")
    assert.equal(escapeHtml("&"), "&amp;")
  })

  it("handles empty and non-string values", () => {
    assert.equal(escapeHtml(""), "")
    assert.equal(escapeHtml(null), "")
    assert.equal(escapeHtml(undefined), "")
    assert.equal(escapeHtml(0), "0")
  })

  it("leaves an ordinary URL readable", () => {
    assert.equal(escapeHtml("http://127.0.0.1:3005/"), "http://127.0.0.1:3005/")
  })
})

describe("inline script literals", () => {
  it("quotes a string and escapes an embedded quote", () => {
    assert.equal(scriptLiteral("plain"), '"plain"')
    assert.equal(scriptLiteral(`a'b"c`), `"a'b\\"c"`)
  })

  it("cannot close the surrounding script element", () => {
    // '</script>' inside a literal would end the block; '<' becomes \u003c.
    assert.equal(scriptLiteral("</script>"), '"\\u003c/script>"')
    assert.ok(!scriptLiteral("x</script><img src=x onerror=alert(1)>").includes("</script>"))
    assert.ok(!scriptLiteral("x</script>").includes("<"))
  })

  it("cannot break out of the literal, which is the flagged case", () => {
    // A URL fragment carrying a quote is the reported vector.
    const hostile = "https://engine.example.com/#x'-alert(1)-'"
    const literal = scriptLiteral(hostile)
    // eslint-disable-next-line no-new-func
    const roundTripped = new Function(`return ${literal}`)()
    assert.equal(roundTripped, hostile, "the literal must evaluate back to the exact URL, not execute its contents")
  })

  it("round-trips a URL with a quote through a real script parse", () => {
    for (const url of [
      "https://engine.example.com/#x'-alert(1)-'",
      'https://engine.example.com/#y"-alert(2)-"',
      "https://engine.example.com/#</script>",
      "http://127.0.0.1:3005/",
    ]) {
      const literal = scriptLiteral(url)
      // eslint-disable-next-line no-new-func
      assert.equal(new Function(`return ${literal}`)(), url)
    }
  })

  it("escapes the Unicode line separators that are literal breaks in JS source", () => {
    assert.equal(scriptLiteral("a\u2028b"), '"a\\u2028b"')
    assert.equal(scriptLiteral("a\u2029b"), '"a\\u2029b"')
    // eslint-disable-next-line no-new-func
    assert.equal(new Function(`return ${scriptLiteral("a\u2028b\u2029c")}`)(), "a\u2028b\u2029c")
  })

  it("handles null and undefined as a JSON null", () => {
    assert.equal(scriptLiteral(null), "null")
    assert.equal(scriptLiteral(undefined), "null")
  })
})
