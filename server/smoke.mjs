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

/**
 * Polls `fn` until it returns something truthy and returns that value.
 * Returning the value (not just `true`) matters: callers use it to pick up the
 * discovered DevTools URL.
 */
const waitFor = async (fn, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
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
  // A fixed port plus /json/version discovery is far more reliable than
  // scraping the DevTools URL from stderr, which Chromium only prints once and
  // in a format that has changed between versions.
  const debugPort = Number(process.env.CHAT2API_DEBUG_PORT ?? 9333)
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      '--window-size=1400,900',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )

  let stderr = ''
  chrome.stderr.on('data', (d) => (stderr += d.toString()))

  const wsEndpoint = await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`)
        if (!response.ok) return null
        const info = await response.json()
        return info.webSocketDebuggerUrl ?? null
      } catch {
        return null
      }
    },
    30_000,
    'chromium devtools endpoint'
  ).catch((error) => {
    throw new Error(`${error.message}\nchromium stderr:\n${stderr.slice(-2000)}`)
  })

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

    // 5. SSE wiring: observe EventSource state and proxy:statusChanged.
    const sse = await evaluate(
      cdp,
      sessionId,
      `new Promise((resolve) => {
         const timer = setTimeout(() => {
           resolve({
             received: false,
             reason: 'timeout',
             readyState: window._esReadyState,
             eventsSeen: window._eventsSeen || [],
           })
         }, 10000)

         try {
           window._eventsSeen = []
           const source = new EventSource('/api/events')
           source.onopen = () => {
             window._esReadyState = 'open'
             // Trigger status change after confirmed connection
             window.electronAPI.invoke('proxy:stop')
               .then(() => window.electronAPI.invoke('proxy:start', [30128]))
           }
           source.onerror = (e) => {
             window._esReadyState = 'error'
           }
           source.onmessage = (msg) => {
             try {
               const parsed = JSON.parse(msg.data)
               window._eventsSeen.push(parsed.channel)
               if (parsed.channel === 'proxy:statusChanged') {
                 clearTimeout(timer)
                 source.close()
                 resolve({ received: true, isRunning: parsed.args?.[0]?.isRunning })
               }
             } catch {}
           }
         } catch (outerErr) {
           clearTimeout(timer)
           resolve({ received: false, error: String(outerErr) })
         }
       })`
    )
    check('SSE push (proxy:statusChanged)', sse.received === true, JSON.stringify(sse))

    // 6. Dashboard route renders its own content (not just the shell).
    const text = await evaluate(cdp, sessionId, 'document.body.innerText.slice(0, 400)')
    check('dashboard renders text', typeof text === 'string' && text.trim().length > 10)

    // 7. OAuth fallback: with no Chromium window, the UI must offer the
    // "open provider site + paste token" flow instead of a dead popup.
    const oauthFallback = await evaluate(
      cdp,
      sessionId,
      `(async () => {
         const guides = await window.electronAPI.oauth.getGuides()
         const ds = guides?.deepseek
         const login = await window.electronAPI.oauth.startInAppLogin('deepseek', 'deepseek')
         return {
           hasDeepseekGuide: !!ds,
           loginUrl: ds?.loginUrl ?? null,
           tokenKey: ds?.tokenKey ?? null,
           stepCount: ds?.steps?.length ?? 0,
           loginFailedFast: login?.success === false,
           error: login?.error ?? null,
         }
       })()`
    )
    check('oauth guide available for deepseek', oauthFallback.hasDeepseekGuide, oauthFallback.loginUrl ?? '')
    check('oauth guide lists copy steps', oauthFallback.stepCount > 0, `${oauthFallback.stepCount} steps`)
    check(
      'startInAppLogin reports unavailable (no hang)',
      oauthFallback.loginFailedFast === true,
      oauthFallback.error ?? ''
    )

    // 8. The guide panel must actually reach the DOM. Both provider dialogs
    // call startInAppLogin, and a fix in only one of them is what made the UI
    // show a bare "not available" error. Driven via stable test ids so a
    // translation change or a stray clickable cannot break the test (a random
    // click once navigated the page away mid-run).
    const guidePanel = await evaluate(
      cdp,
      sessionId,
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
         const $ = (id) => document.querySelector('[data-testid="' + id + '"]')
         const results = {}

         location.hash = '#/providers'
         await sleep(400)

         // Wait for the page to actually render instead of assuming a fixed
         // delay; a cold SPA load can take well over a second.
         for (let i = 0; i < 40 && !$('add-provider-button') && !$('add-provider-empty-button'); i++) {
           await sleep(250)
         }

         // Providers page -> "Add Provider" -> pick a builtin -> OAuth tab.
         // An empty install shows the empty-state button instead of the toolbar
         // one, so accept either.
         const addProvider = $('add-provider-button') || $('add-provider-empty-button')
         results.sawAddProvider = !!addProvider

         if (addProvider) {
           addProvider.click()
           await sleep(800)

           // The builtin list appears in the dialog; choose any provider card.
           const builtin = [...document.querySelectorAll('[role="dialog"] button, [role="dialog"] [role="button"]')]
             .find((el) => /deepseek|qwen|kimi|glm|minimax/i.test(el.textContent || ''))
           results.sawBuiltin = !!builtin
           if (builtin) {
             builtin.click()
             await sleep(700)
           }
         }

         // Click the OAuth tab first: the login trigger only exists there.
         const oauthTab = [...document.querySelectorAll('[role="tab"]')].find((el) =>
           /oauth/i.test(el.textContent || '')
         )
         results.sawOauthTab = !!oauthTab
         if (oauthTab) {
           oauthTab.click()
           // Radix mounts tab content asynchronously.
           for (let i = 0; i < 20 && !$('oauth-login-button'); i++) {
             await sleep(200)
           }
         }

         // Click the OAuth trigger if present; in the web build this is what
         // must degrade into the guide panel.
         const oauthBtn = $('oauth-login-button')
         results.sawOauthButton = !!oauthBtn
         if (!oauthBtn && !results.sawAddProvider) {
           return {
             reached: false,
             reason: 'providers page never rendered',
             hash: location.hash,
             testIds: [...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')).slice(0, 20),
             text: document.body.innerText.slice(0, 200),
             ...results,
           }
         }
         if (oauthBtn) {
           oauthBtn.click()
         } else {
           return { reached: false, reason: 'no oauth button', ...results }
         }

         for (let i = 0; i < 40; i++) {
           await sleep(250)
           if ($('web-login-guide')) {
             return {
               reached: true,
               hasBookmarklet: !!document.querySelector('[data-testid="web-login-guide"] a[href^="javascript:"]'),
               showsRawError: /In-app login window is not available/i.test(document.body.innerText),
               ...results,
             }
           }
         }

         return {
           reached: false,
           reason: 'guide panel never appeared',
           bodyText: document.body.innerText.slice(0, 240),
           ...results,
         }
       })()`
    )
    check('guide panel renders after OAuth click', guidePanel.reached === true, JSON.stringify(guidePanel).slice(0, 220))
    if (guidePanel.reached) {
      check('guide panel shows bookmarklet', guidePanel.hasBookmarklet === true)
      check('guide panel replaces raw error', guidePanel.showsRawError === false)
    }

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
    try {
      chrome.kill('SIGKILL')
      // Let the OS release file handles before removing the temp profile.
      await new Promise((r) => setTimeout(r, 1000))
      fs.rmSync(userDataDir, { recursive: true, force: true })
    } catch (cleanupError) {
      console.warn('cleanup error (ignored):', cleanupError?.message || cleanupError)
    }
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
