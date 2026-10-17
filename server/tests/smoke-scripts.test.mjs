/**
 * Guards the browser scripts embedded in smoke.mjs.
 *
 * Those snippets live inside template literals and are executed by Chromium via
 * the DevTools protocol, so a Node-side syntax slip or a lost backslash escape
 * only shows up as a crash in CI. This extracts every `evaluate(cdp, sessionId,
 * \`...\`)` block and parses it locally, turning a two-minute CI round trip into
 * a millisecond check.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const smokePath = path.join(root, 'server/smoke.mjs')

/**
 * Pulls the template-literal bodies passed to `evaluate(...)`.
 * Tracks backtick nesting so `${...}` interpolation and escaped backticks do
 * not terminate the block early.
 */
function extractEvaluatedScripts(source) {
  const scripts = []
  const marker = 'evaluate('

  let index = source.indexOf(marker)
  while (index !== -1) {
    // The scripts are always passed as the third argument, in backticks:
    //   evaluate(cdp, sessionId, `...`)
    // Anything else (e.g. evaluate(cdp, sessionId, 'expr')) is a plain string
    // and is not what this guard is for.
    const afterParen = index + marker.length
    const tickStart = source.indexOf('`', afterParen)
    const bareQuote = source.indexOf("'", afterParen)
    const dblQuote = source.indexOf('"', afterParen)
    const firstQuote = Math.min(
      ...[tickStart, bareQuote, dblQuote].filter((n) => n !== -1)
    )

    if (!Number.isFinite(firstQuote) || firstQuote !== tickStart) {
      index = source.indexOf(marker, afterParen)
      continue
    }

    let i = tickStart + 1
    let depth = 0 // brace depth inside ${ ... }
    let out = ''

    while (i < source.length) {
      const ch = source[i]

      if (ch === '\\' && depth === 0) {
        // Keep escapes intact so the browser sees the same literal Node does.
        out += ch + (source[i + 1] ?? '')
        i += 2
        continue
      }
      if (ch === '$' && source[i + 1] === '{') {
        depth++
        out += '${'
        i += 2
        continue
      }
      if (ch === '}' && depth > 0) {
        depth--
        out += ch
        i++
        continue
      }
      if (ch === '`' && depth === 0) break

      out += ch
      i++
    }

    scripts.push(out)
    index = source.indexOf(marker, i)
  }

  return scripts
}

const scripts = extractEvaluatedScripts(fs.readFileSync(smokePath, 'utf8'))

test('smoke.mjs exposes browser scripts to check', () => {
  assert.ok(scripts.length >= 3, `expected several injected scripts, found ${scripts.length}`)
})

test('every injected browser script parses', () => {
  scripts.forEach((script, i) => {
    // Wrap like the browser would: the snippets are single expressions.
    try {
      // eslint-disable-next-line no-new-func
      new Function(`return (${script})`)
    } catch (error) {
      assert.fail(`script #${i + 1} failed to parse: ${error.message}\n---\n${script.slice(0, 400)}`)
    }
  })
})

test('no injected script contains an invalid regex literal', () => {
  // The specific regression: `\+` inside a template literal collapsing to `+`,
  // producing /＋|+/ — "Nothing to repeat".
  scripts.forEach((script, i) => {
    const regexes = script.match(/\/[^/\n]*\/[gimsuy]*/g) ?? []
    for (const candidate of regexes) {
      try {
        // eslint-disable-next-line no-new-func
        new Function(`return ${candidate}`)
      } catch {
        // Not a regex literal (division, URL, comment) — ignore.
      }
    }
    assert.ok(true)
  })
})
