/**
 * Headless smoke test: drives the dashboard in real Chromium (installed on
 * Termux) and asserts the React UI mounts and can talk to the main process
 * through the HTTP/SSE bridge.
 *
 * Usage: node server/smoke.mjs [--url http://127.0.0.1:3000] [--screenshot out.png]
 *
 * Uses the DevTools protocol over a plain WebSocket, so it needs no Playwright /
 * Puppeteer download — only a chromium binary.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const getFlag = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}

const TARGET = getFlag('--url', process.env.CHAT2API_SMOKE_URL ?? 'http://127.0.0.1:3000')
const SCREENSHOT = getFlag('--screenshot', '')
const CHROME = process.env.CHROME_BIN ?? 'chromium'

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** Minimal DevTools-protocol client (no deps). */
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.sessions = new Map()
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      } else if (msg.method) {
        this.sessions.get(msg.sessionId)?.push(msg)
      }
    })
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true })
    })
    return new Cdp(ws)
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    this.ws.send(JSON.stringify(payload))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`))
      }, 30_000)
    })
  }
}

/** Runs an expression in the page and returns its JSON value. */
async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    sessionId
  )
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed')
  }
  return result.result.value
}

const waitFor = async (fn, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const main = async () => {
  if (typeof WebSocket === 'undefined') {
    console.error(
      '\x1b[31mThis Node has no global WebSocket (needs Node 22+).\x1b[0m\n' +
        `Running: ${process.version}. Upgrade Node, or skip the browser test.`
    )
    process.exit(2)
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2api-smoke-'))
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--window-size=1400,900',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )

  let stderr = ''
  chrome.stderr.on('data', (d) => (stderr += d.toString()))

  // Chromium prints the DevTools URL on stderr once the endpoint is live.
  const wsEndpoint = await waitFor(
    async () => {
      const match = stderr.match(/ws:\/\/[^\s]+/)
      return match ? match[0] : null
    },
    20_000,
    'chromium devtools endpoint'
  )

  const cdp = await Cdp.connect(wsEndpoint)
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })

  const consoleErrors = []
  cdp.sessions.set(sessionId, [])
  await cdp.send('Runtime.enable', {}, sessionId)
  await cdp.send('Log.enable', {}, sessionId)
  await cdp.send('Page.enable', {}, sessionId)

  // Collect console/log errors emitted while the SPA boots.
  const poll = setInterval(() => {
    const events = cdp.sessions.get(sessionId) ?? []
    for (const event of events.splice(0)) {
      if (event.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(event.params.exceptionDetails?.exception?.description ?? 'exception')
      }
      if (event.method === 'Log.entryAdded' && event.params.entry.level === 'error') {
        consoleErrors.push(event.params.entry.text)
      }
    }
  }, 100)

  try {
    await cdp.send('Page.navigate', { url: TARGET }, sessionId)
    await waitFor(
      async () => (await evaluate(cdp, sessionId, 'document.readyState')) === 'complete',
      30_000,
      'page load'
    )

    // 1. The preload shim must have installed the full API surface.
    const apiShape = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const api = window.electronAPI
         if (!api) return { ok: false }
         return {
           ok: true,
           groups: Object.keys(api).length,
           keys: Object.keys(api).sort(),
           hasInvoke: typeof api.invoke === 'function',
         }
       })()`
    )
    check('window.electronAPI installed', apiShape.ok, apiShape.ok ? `${apiShape.groups} groups` : '')
    check('electronAPI.invoke available', apiShape.hasInvoke === true)

    // 2. React must actually render.
    await waitFor(
      async () => (await evaluate(cdp, sessionId, 'document.querySelectorAll("#root *").length')) > 20,
      20_000,
      'React mount'
    )
    const nodeCount = await evaluate(cdp, sessionId, 'document.querySelectorAll("#root *").length')
    check('React UI mounted', nodeCount > 20, `${nodeCount} nodes`)

    // 3. IPC round-trip through HTTP works from the page.
    const version = await evaluate(cdp, sessionId, 'window.electronAPI.invoke("app:getVersion")')
    check('IPC round-trip (app:getVersion)', typeof version === 'string' && version.length > 0, version)

    // 4. Real domain call: builtin providers come back from the store.
    const providers = await evaluate(cdp, sessionId, 'window.electronAPI.providers.getBuiltin()')
    check(
      'providers.getBuiltin returns models',
      Array.isArray(providers) && providers.length > 0,
      `${providers?.length ?? 0} providers`
    )

    // 5. SSE wiring: a proxy start should push proxy:statusChanged to the page.
    const sse = await evaluate(
      cdp,
      sessionId,
      `new Promise((resolve) => {
         const timer = setTimeout(() => resolve({ received: false }), 8000)
         window.electronAPI.proxy.onStatusChanged((status) => {
           clearTimeout(timer)
           resolve({ received: true, isRunning: status?.isRunning })
         })
         window.electronAPI.invoke('proxy:start', [8080])
       })`
    )
    check('SSE push (proxy:statusChanged)', sse.received === true, JSON.stringify(sse))

    // 6. Dashboard route renders its own content (not just the shell).
    const text = await evaluate(cdp, sessionId, 'document.body.innerText.slice(0, 400)')
    check('dashboard renders text', typeof text === 'string' && text.trim().length > 10)

    if (consoleErrors.length) {
      check('no page console errors', false, consoleErrors.slice(0, 3).join(' | '))
    } else {
      check('no page console errors', true)
    }

    if (SCREENSHOT) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
      fs.writeFileSync(SCREENSHOT, Buffer.from(shot.data, 'base64'))
      console.log(`\n  screenshot -> ${SCREENSHOT}`)
    }
  } finally {
    clearInterval(poll)
    chrome.kill('SIGKILL')
    fs.rmSync(userDataDir, { recursive: true, force: true })
  }

  if (failures.length) {
    console.error(`\n\x1b[31m${failures.length} check(s) failed:\x1b[0m ${failures.join(', ')}`)
    process.exit(1)
  }
  console.log('\n\x1b[32mall smoke checks passed\x1b[0m')
}

main().catch((error) => {
  console.error('\x1b[31msmoke test crashed:\x1b[0m', error)
  process.exit(1)
})
