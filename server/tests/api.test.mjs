/**
 * Headless API tests — no framework, no browser.
 *
 * Exercises the HTTP bridge end to end against a running server: IPC
 * request/response, the SSE event stream, static UI serving, and a real proxy
 * start/stop cycle. Runs on a phone or a CI runner.
 *
 * Usage: node --test server/tests/api.test.mjs --url http://127.0.0.1:3000
 *    or: node server/tests/api.test.mjs --url http://127.0.0.1:3000
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const argUrl = (() => {
  const i = process.argv.indexOf('--url')
  return i === -1 ? null : process.argv[i + 1]
})()

const BASE = argUrl ?? process.env.CHAT2API_TEST_URL ?? 'http://127.0.0.1:3000'

/**
 * `/api/health` reports how many IPC handlers registered. If it is 0 the main
 * process failed to boot, and every other assertion below would fail with a
 * confusing error, so check it up front.
 */
test('server is up with IPC handlers registered', async () => {
  const response = await fetch(`${BASE}/api/health`)
  assert.equal(response.status, 200)
  const health = await response.json()
  assert.equal(health.ok, true)
  assert.ok(health.ipcHandlers > 50, `expected >50 handlers, got ${health.ipcHandlers}`)
})

test('IPC request/response round-trip', async () => {
  const response = await fetch(`${BASE}/api/ipc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'app:getVersion', args: [] }),
  })
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.match(body.data, /^\d+\.\d+\.\d+/)
})

test('unknown channel reports an error instead of crashing', async () => {
  const response = await fetch(`${BASE}/api/ipc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'does:notExist', args: [] }),
  })
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.match(body.error, /No handler registered/)
  // The server must still be alive.
  const health = await (await fetch(`${BASE}/api/health`)).json()
  assert.equal(health.ok, true)
})

test('builtin providers are served from the real store', async () => {
  const response = await fetch(`${BASE}/api/ipc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'providers:getBuiltin', args: [] }),
  })
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.ok(Array.isArray(body.data))
  assert.ok(body.data.length >= 5, `expected builtin providers, got ${body.data.length}`)
  for (const provider of body.data) {
    assert.ok(provider.id, 'provider has an id')
  }
})

test('config round-trip persists proxy port', async () => {
  const get = async () =>
    (
      await (
        await fetch(`${BASE}/api/ipc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: 'config:get', args: [] }),
        })
      ).json()
    ).data

  const before = await get()
  assert.ok(typeof before.proxyPort === 'number')

  const update = await (
    await fetch(`${BASE}/api/ipc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'config:update', args: [{ proxyPort: 18080 }] }),
    })
  ).json()
  assert.equal(update.ok, true)

  const after = await get()
  assert.equal(after.proxyPort, 18080)

  // Restore so a reused server is not left reconfigured.
  await fetch(`${BASE}/api/ipc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'config:update', args: [{ proxyPort: before.proxyPort }] }),
  })
})

test('SSE stream delivers main-process events', async () => {
  const controller = new AbortController()
  const response = await fetch(`${BASE}/api/events`, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  // Trigger an event while the stream is open.
  await fetch(`${BASE}/api/ipc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'proxy:start', args: [18081] }),
  })

  let buffer = ''
  const deadline = Date.now() + 15_000
  let sawStatus = false

  while (Date.now() < deadline && !sawStatus) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    if (buffer.includes('proxy:statusChanged')) sawStatus = true
  }

  controller.abort()

  // Clean up the proxy the test started.
  await fetch(`${BASE}/api/ipc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'proxy:stop', args: [] }),
  })

  assert.equal(sawStatus, true, 'expected a proxy:statusChanged event on the SSE stream')
})

test('dashboard HTML and JS bundle are served', async () => {
  const html = await fetch(`${BASE}/`)
  assert.equal(html.status, 200)
  const body = await html.text()
  assert.match(body, /<div id="root">/)

  const bundlePath = body.match(/src="\.?\/?(assets\/index-[^"]+\.js)"/)?.[1]
  assert.ok(bundlePath, 'index.html references a JS bundle')

  const bundle = await fetch(`${BASE}/${bundlePath}`)
  assert.equal(bundle.status, 200)
  assert.match(bundle.headers.get('content-type') ?? '', /javascript/)
})

test('unknown paths fall back to the SPA shell', async () => {
  const response = await fetch(`${BASE}/some/deep/route`)
  assert.equal(response.status, 200)
  assert.match(await response.text(), /<div id="root">/)
})

test('oauth guides are exposed for manual token login', async () => {
  const call = async (channel, args = []) =>
    (
      await (
        await fetch(`${BASE}/api/ipc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel, args }),
        })
      ).json()
    )

  const guides = await call('oauth:getGuides')
  assert.equal(guides.ok, true)
  assert.ok(guides.data.deepseek, 'deepseek guide present')
  assert.match(guides.data.deepseek.loginUrl, /^https:\/\//)
  assert.ok(guides.data.deepseek.steps.length > 0)
  assert.ok(guides.data.deepseek.tokenKey)

  // The desktop build would open a Chromium window here; the web build must
  // fail fast so the UI can show the paste-token guide instead of hanging.
  const started = Date.now()
  const login = await call('oauth:startInAppLogin', [
    { providerId: 'deepseek', providerType: 'deepseek' },
  ])
  const elapsed = Date.now() - started

  assert.equal(login.ok, true)
  assert.equal(login.data.success, false)
  assert.match(login.data.error, /not available/i)
  assert.ok(elapsed < 5000, `should fail fast, took ${elapsed}ms`)

  // The bookmarklet is the mobile path: login happens in the real browser, the
  // script only copies the resulting token out of that page.
  const bookmarklet = await call('oauth:getBookmarklet', ['deepseek'])
  assert.equal(bookmarklet.ok, true)
  assert.ok(bookmarklet.data, 'bookmarklet returned')
  assert.match(bookmarklet.data, /^javascript:/)
  assert.ok(bookmarklet.data.includes('userToken'), 'targets the provider token key')
  assert.ok(bookmarklet.data.includes('localStorage'), 'reads localStorage')

  // Unknown providers must not produce a script.
  const missing = await call('oauth:getBookmarklet', ['not-a-provider'])
  assert.equal(missing.data, null)
})

// ---------------------------------------------------------------------------
// Self-starting mode: `node server/tests/api.test.mjs` without a running server
// ---------------------------------------------------------------------------

if (!argUrl && !process.env.CHAT2API_TEST_URL) {
  // The tests above assume a server; nothing to do here beyond documenting it.
  console.log(`\nTests ran against ${BASE}. Use --url to point elsewhere.`)
}
