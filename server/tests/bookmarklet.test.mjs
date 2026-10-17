/**
 * Unit test for the token bookmarklet.
 *
 * Proves the generated script extracts tokens from the shapes providers
 * actually use: a raw string, a JSON-quoted string, an object with nested
 * fields, a renamed key, and cookie-backed providers.
 *
 * The generator is TypeScript. Rather than reimplementing it, this test bundles
 * it once with esbuild (already a devDependency) and imports the result — the
 * same code path the app ships, not a copy.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2a-bookmarklet-'))
const bundlePath = path.join(tmpDir, 'bookmarklet.mjs')

/**
 * Bundle the real generator (TypeScript) instead of reimplementing it, so the
 * test exercises exactly the code the app ships. Uses esbuild's JS API because
 * the CLI wrapper's shebang is unreliable on Termux.
 */
let buildTokenHelperScript = null
try {
  const esbuild = await import('esbuild')
  await esbuild.build({
    entryPoints: [path.join(root, 'src/main/oauth/bookmarklet.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile: bundlePath,
    logLevel: 'error',
  })
  ;({ buildTokenHelperScript } = await import(pathToFileURL(bundlePath).href))
} catch (error) {
  console.warn('esbuild unavailable, skipping bookmarklet tests:', error.message)
}

if (!buildTokenHelperScript) {
  test('bookmarklet generator (skipped: esbuild not installed)', { skip: true }, () => {})
} else {

  const GUIDE = {
    loginUrl: 'https://chat.deepseek.com',
    steps: ['1. log in'],
    tokenKey: 'userToken',
    tokenLabel: 'Token',
    storageType: 'localStorage',
  }

  /**
   * Runs the helper script with stubbed browser globals and returns whatever it
   * would have copied (via clipboard API or the prompt() fallback).
   */
  function runScript(script, { localStorage: store = {}, cookies = '' } = {}) {
    let copied = null
    let alerted = null

    const localStorageStub = {
      getItem: (k) => (k in store ? store[k] : null),
      key: (i) => Object.keys(store)[i] ?? null,
      get length() {
        return Object.keys(store).length
      },
    }

    const sandbox = {
      localStorage: localStorageStub,
      document: { cookie: cookies },
      navigator: { clipboard: { writeText: (t) => ((copied = t), Promise.resolve()) } },
      alert: (m) => (alerted = m),
      window: { prompt: (_m, t) => (copied = t) },
    }

    // eslint-disable-next-line no-new-func
    new Function(...Object.keys(sandbox), script)(...Object.values(sandbox))
    return { copied, alerted }
  }

  test('extracts a raw token from localStorage', () => {
    const { copied } = runScript(buildTokenHelperScript(GUIDE), {
      localStorage: { userToken: 'eyJhbGciOiJIUzI1NiJ9.rawtoken' },
    })
    assert.equal(copied, 'eyJhbGciOiJIUzI1NiJ9.rawtoken')
  })

  test('unwraps a JSON-quoted token', () => {
    const { copied } = runScript(buildTokenHelperScript(GUIDE), {
      localStorage: { userToken: '"eyJhbGciOiJIUzI1NiJ9.quoted"' },
    })
    assert.equal(copied, 'eyJhbGciOiJIUzI1NiJ9.quoted')
  })

  test('unwraps an object-shaped token', () => {
    const { copied } = runScript(buildTokenHelperScript(GUIDE), {
      localStorage: { userToken: JSON.stringify({ value: 'objtoken', expiry: 1 }) },
    })
    assert.equal(copied, 'objtoken')
  })

  test('finds the token when the storage key was renamed', () => {
    const { copied } = runScript(buildTokenHelperScript(GUIDE), {
      localStorage: { DS_userToken_v2: '"renamedtoken"' },
    })
    assert.equal(copied, 'renamedtoken')
  })

  test('reads cookie-backed providers', () => {
    const guide = { ...GUIDE, tokenKey: 'tongyi_sso_ticket', storageType: 'cookie' }
    const { copied } = runScript(buildTokenHelperScript(guide), {
      cookies: 'other=1; tongyi_sso_ticket=ticket-abc123; x=2',
    })
    assert.equal(copied, 'ticket-abc123')
  })

  test('reports a clear message when no token is present', () => {
    const { copied, alerted } = runScript(buildTokenHelperScript(GUIDE), { localStorage: {} })
    assert.equal(copied, null)
    assert.match(alerted, /No Token found/)
  })

  test('plain script has no javascript: prefix', () => {
    assert.doesNotMatch(buildTokenHelperScript(GUIDE), /^javascript:/)
  })
}
