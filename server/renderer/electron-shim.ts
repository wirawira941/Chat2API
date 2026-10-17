/**
 * Browser replacement for the Electron preload bridge.
 *
 * `src/preload/index.ts` builds `window.electronAPI` on top of
 * `contextBridge` + `ipcRenderer`. By aliasing the `electron` module to this
 * file during the renderer build, the unmodified preload runs in a normal
 * browser and talks to the headless server over HTTP:
 *
 *   ipcRenderer.invoke(ch, ...args)  -> POST /api/ipc            (request/response)
 *   ipcRenderer.send(ch, ...args)    -> POST /api/ipc/send        (fire and forget)
 *   ipcRenderer.on(ch, cb)           -> Server-Sent Events /api/events
 *
 * This keeps the entire main-process API surface (105 channels) available
 * without duplicating any of it in the UI layer.
 */

type Listener = (...args: unknown[]) => void

/** Base URL of the server that served this page (works behind reverse proxies). */
const BASE = (() => {
  const origin = window.location.origin
  // Vite dev server proxies /api to the backend; in production they are the same origin.
  return `${origin}/api`
})()

const listeners = new Map<string, Set<Listener>>()

/**
 * Single SSE connection shared by every channel listener. Browsers cap
 * concurrent HTTP/1.1 connections per host, so one stream is the right shape.
 */
let eventSource: EventSource | null = null
let reconnectDelay = 500

function ensureEventSource(): void {
  if (eventSource) return

  const connect = () => {
    const source = new EventSource(`${BASE}/events`)
    eventSource = source

    source.onopen = () => {
      reconnectDelay = 500
    }

    source.onmessage = (message) => {
      let payload: { channel?: string; args?: unknown[] }
      try {
        payload = JSON.parse(message.data)
      } catch {
        return
      }
      if (!payload.channel) return
      const set = listeners.get(payload.channel)
      if (!set) return
      const args = payload.args ?? []
      for (const listener of set) {
        try {
          // First arg mirrors Electron's IpcRendererEvent; handlers never read it.
          listener({}, ...args)
        } catch (error) {
          console.error(`[ipc-shim] listener for ${payload.channel} threw:`, error)
        }
      }
    }

    source.onerror = () => {
      source.close()
      eventSource = null
      // EventSource retries on its own, but only while the instance lives.
      // Re-create it with a small backoff so a restarted server is picked up.
      reconnectDelay = Math.min(reconnectDelay * 2, 10_000)
      setTimeout(ensureEventSource, reconnectDelay)
    }
  }

  connect()
}

class HttpIpcError extends Error {
  constructor(message: string, readonly channel: string) {
    super(message)
    this.name = 'HttpIpcError'
  }
}

async function invoke(channel: string, ...args: unknown[]): Promise<any> {
  // In the desktop build this opens the OS browser via Electron's shell module.
  // In a browser there is no main process to do that, and routing it through
  // the server would lose the user-gesture context — popup blockers drop the
  // window. So handle it here, synchronously inside the click handler.
  if (channel === 'app:openExternal') {
    const url = String(args[0] ?? '')
    if (url) {
      const opened = window.open(url, '_blank', 'noopener,noreferrer')
      if (!opened) {
        // Popup blocked: fall back to same-tab navigation so the user still
        // reaches the login page instead of seeing nothing happen.
        window.location.href = url
      }
    }
    return undefined
  }

  const response = await fetch(`${BASE}/ipc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, args }),
  })

  // 4xx/5xx still carry a JSON body describing the failure.
  let body: { ok?: boolean; data?: unknown; error?: string }
  try {
    body = await response.json()
  } catch {
    throw new HttpIpcError(`${channel} failed: HTTP ${response.status}`, channel)
  }

  if (!response.ok || body.ok === false) {
    throw new HttpIpcError(body.error ?? `${channel} failed`, channel)
  }
  return body.data
}

export const ipcRenderer = {
  invoke,
  send(channel: string, ...args: unknown[]): void {
    void fetch(`${BASE}/ipc/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, args }),
    }).catch((error) => console.error(`[ipc-shim] send ${channel} failed:`, error))
  },
  on(channel: string, listener: Listener): void {
    let set = listeners.get(channel)
    if (!set) {
      set = new Set()
      listeners.set(channel, set)
    }
    set.add(listener)
    ensureEventSource()
  },
  once(channel: string, listener: Listener): void {
    const wrapped: Listener = (...args) => {
      ipcRenderer.removeListener(channel, wrapped)
      listener(...args)
    }
    ipcRenderer.on(channel, wrapped)
  },
  removeListener(channel: string, listener: Listener): void {
    listeners.get(channel)?.delete(listener)
  },
  removeAllListeners(channel: string): void {
    listeners.delete(channel)
  },
}

export const contextBridge = {
  exposeInMainWorld(key: string, api: unknown): void {
    ;(window as unknown as Record<string, unknown>)[key] = api
  },
}

// Preload also imports these indirectly through provider modules; keep them
// present so a stray import cannot break the bundle.
export const shell = { openExternal: (url: string) => window.open(url, '_blank', 'noopener') }
export const ipcMain = { handle: () => {}, on: () => {} }

export default { ipcRenderer, contextBridge, shell, ipcMain }
