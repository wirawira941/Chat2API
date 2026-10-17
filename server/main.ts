/**
 * Headless entry point: boots Chat2API's real main process on plain Node and
 * puts an HTTP server in front of it.
 *
 * Importing `src/main/index.ts` runs the app exactly as Electron would: storage
 * init, IPC handler registration, tray creation (inert), auto-start proxy. The
 * only difference is what happens *after* — instead of a Chromium window, this
 * module serves the React UI and relays `window.electronAPI` calls over HTTP.
 */

import { createReadStream, existsSync, statSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { ipcMain, app, windowBus } from './electron-shim'

// Boot the real application (registers IPC handlers, initializes the store).
import '../src/main/index'

const here = __dirname
const rendererDir = process.env.CHAT2API_RENDERER_DIR
  ? path.resolve(process.env.CHAT2API_RENDERER_DIR)
  : path.join(here, 'renderer')

const PORT = Number(process.env.CHAT2API_WEB_PORT ?? process.env.PORT ?? 3000)
const HOST = process.env.CHAT2API_WEB_HOST ?? '0.0.0.0'

/** Bearer token for the web UI when it is exposed beyond loopback. */
const AUTH_TOKEN = process.env.CHAT2API_WEB_TOKEN ?? ''

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
}

/** SSE clients currently receiving main-process events. */
const clients = new Set<http.ServerResponse>()

/**
 * Renders listeners are attached lazily, so events emitted before the first
 * dashboard connects would be lost. Keep the last event per channel so a
 * freshly opened (or refreshed) tab can resync.
 */
const lastEvent = new Map<string, { channel: string; args: unknown[] }>()

windowBus.on('send', (channel: string, args: unknown[]) => {
  lastEvent.set(channel, { channel, args })
  broadcast(channel, args)
})

function broadcast(channel: string, args: unknown[]): void {
  const payload = `data: ${JSON.stringify({ channel, args })}\n\n`
  for (const client of clients) {
    try {
      client.write(payload)
    } catch {
      clients.delete(client)
    }
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body ?? null)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
  })
  res.end(json)
}

/** Serializes anything a handler returns, turning Errors into readable messages. */
function serializeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function readBody(req: http.IncomingMessage, limitBytes = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function checkAuth(req: http.IncomingMessage): boolean {
  if (!AUTH_TOKEN) return true
  const header = req.headers.authorization ?? ''
  if (header === `Bearer ${AUTH_TOKEN}`) return true
  return req.headers['x-chat2api-token'] === AUTH_TOKEN
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): void {
  // Resolve inside rendererDir only — no traversal out of the web root.
  const relative = decodeURIComponent(urlPath).replace(/^\/+/, '')
  let filePath = path.join(rendererDir, relative)
  if (!filePath.startsWith(rendererDir)) {
    res.writeHead(403).end('Forbidden')
    return
  }

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    // SPA fallback: unknown paths render the dashboard shell.
    filePath = path.join(rendererDir, 'index.html')
    if (!existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(
        'UI bundle not found.\nRun: npm run build:headless\n' +
          `Expected: ${path.join(rendererDir, 'index.html')}\n`
      )
      return
    }
  }

  const ext = path.extname(filePath).toLowerCase()
  const immutable = filePath.includes(`${path.sep}assets${path.sep}`)
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  createReadStream(filePath).pipe(res)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const { pathname } = url

  // The proxy and dashboard are separate origins only in dev; allow both.
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Chat2API-Token')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end()
    return
  }

  try {
    // -- health ------------------------------------------------------------
    if (pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        version: app.getVersion(),
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        ipcHandlers: ipcMain.handlers.size,
        rendererDir,
      })
      return
    }

    // -- IPC auth ----------------------------------------------------------
    if (pathname.startsWith('/api/') && !checkAuth(req)) {
      sendJson(res, 401, { ok: false, error: 'Unauthorized' })
      return
    }

    // -- request/response IPC ---------------------------------------------
    if (pathname === '/api/ipc' && req.method === 'POST') {
      const raw = await readBody(req)
      let payload: { channel?: string; args?: unknown[] }
      try {
        payload = JSON.parse(raw)
      } catch {
        sendJson(res, 400, { ok: false, error: 'Invalid JSON body' })
        return
      }
      const { channel, args = [] } = payload
      if (!channel) {
        sendJson(res, 400, { ok: false, error: 'Missing channel' })
        return
      }
      try {
        const data = await ipcMain.invoke(channel, { sender: null }, args)
        sendJson(res, 200, { ok: true, data })
      } catch (error) {
        console.error(`[ipc] ${channel} failed:`, error)
        sendJson(res, 200, { ok: false, error: serializeError(error) })
      }
      return
    }

    // -- fire-and-forget IPC (ipcRenderer.send) ---------------------------
    if (pathname === '/api/ipc/send' && req.method === 'POST') {
      const raw = await readBody(req)
      try {
        const { channel, args = [] } = JSON.parse(raw) as { channel?: string; args?: unknown[] }
        if (channel) ipcMain.emit(channel, { sender: null }, ...args)
      } catch {
        // Fire-and-forget: nothing to report.
      }
      sendJson(res, 200, { ok: true })
      return
    }

    // -- event stream (ipcRenderer.on) ------------------------------------
    if (pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write(': connected\n\n')
      clients.add(res)

      // Replay the latest state so a reloaded tab is not blind.
      for (const event of lastEvent.values()) {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }

      const keepAlive = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {
          clearInterval(keepAlive)
        }
      }, 25_000)

      req.on('close', () => {
        clearInterval(keepAlive)
        clients.delete(res)
      })
      return
    }

    // -- static UI --------------------------------------------------------
    serveStatic(req, res, pathname)
  } catch (error) {
    console.error('[web] unhandled request error:', error)
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: serializeError(error) })
    else res.end()
  }
})

server.on('clientError', (_error, socket) => {
  socket.destroy()
})

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST
  console.log(`\n  Chat2API web dashboard  ->  http://${shown}:${PORT}`)
  console.log(`  Data directory          ->  ${app.getPath('userData')}`)
})

// Booting the main process registers its IPC handlers asynchronously (it waits
// for storage init), so report the real count once it has settled.
setTimeout(() => {
  console.log(`  IPC handlers registered ->  ${ipcMain.handlers.size}\n`)
}, 1500).unref()

function shutdown(signal: string): void {
  console.log(`\n[web] ${signal} received, shutting down…`)
  for (const client of clients) client.end()
  server.close(() => {
    app.quit()
    process.exit(0)
  })
  // Do not wait forever on keep-alive sockets.
  setTimeout(() => process.exit(0), 3000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
