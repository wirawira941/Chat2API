/**
 * Minimal `electron` module shim for running Chat2API's main process under plain Node.
 *
 * The upstream app is an Electron app, but the parts that actually matter for
 * headless operation (store, providers, oauth, proxy) only touch a handful of
 * Electron APIs. This module provides just enough of them to boot the real main
 * process code unchanged:
 *
 *   app            -> paths, version, lifecycle events
 *   safeStorage    -> AES-256-GCM via node:crypto (instead of OS keychain)
 *   BrowserWindow  -> null-object window with a webContents EventEmitter
 *   ipcMain        -> handler registry consumed by the HTTP bridge
 *   shell          -> no-op URL opener (browser opens the URL itself)
 *   net            -> node http/https request with Electron-ish events
 *   Tray/Menu/...  -> inert stubs (no system tray on a headless box)
 *
 * Anything that cannot meaningfully work without Chromium (in-app login
 * window, auto-updater, tray) degrades to a no-op instead of throwing, so the
 * web dashboard stays fully usable.
 */

import { EventEmitter } from 'node:events'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as https from 'node:https'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'

// This module stands in for Electron, so its mere presence means "no Chromium".
// Platform code checks this flag to degrade gracefully (e.g. the in-app login
// window reports "not available" instead of waiting out its timeout).
process.env.CHAT2API_HEADLESS = '1'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Everything Chat2API persists lives next to the source checkout by default.
 * CHAT2API_HOME lets a packaged install point somewhere else (e.g. ~/.chat2api).
 */
function resolveHomeDir(): string {
  const fromEnv = process.env.CHAT2API_HOME
  if (fromEnv) return path.resolve(fromEnv)
  return path.resolve(process.cwd())
}

function resolveUserData(): string {
  return process.env.CHAT2API_USER_DATA
    ? path.resolve(process.env.CHAT2API_USER_DATA)
    : path.join(resolveHomeDir(), '.chat2api-web')
}

function resolveAppPath(): string {
  return process.env.CHAT2API_APP_PATH
    ? path.resolve(process.env.CHAT2API_APP_PATH)
    : resolveHomeDir()
}

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------

type AppEvent = 'ready' | 'window-all-closed' | 'before-quit' | 'will-quit' | 'activate' | 'second-instance'

class ShimApp extends EventEmitter {
  isQuitting = false
  isPackaged = false
  private readyEmitted = false

  getVersion(): string {
    const pkgPath = path.join(resolveAppPath(), 'package.json')
    try {
      return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version ?? '0.0.0'
    } catch {
      return '0.0.0'
    }
  }

  getName(): string {
    return 'Chat2API'
  }

  getAppPath(): string {
    return resolveAppPath()
  }

  getPath(name: string): string {
    const userData = resolveUserData()
    const map: Record<string, string> = {
      userData,
      appData: path.dirname(userData),
      sessionData: userData,
      temp: os.tmpdir(),
      home: os.homedir(),
      logs: path.join(userData, 'logs'),
      cache: path.join(userData, 'cache'),
      exe: process.execPath,
      desktop: os.homedir(),
      documents: os.homedir(),
      downloads: os.homedir(),
      music: os.homedir(),
      pictures: os.homedir(),
      videos: os.homedir(),
    }
    const resolved = map[name] ?? userData
    fs.mkdirSync(resolved, { recursive: true })
    return resolved
  }

  requestSingleInstanceLock(): boolean {
    return true
  }

  releaseSingleInstanceLock(): void {}

  /**
   * Electron fires 'ready' on its own once the runtime boots. Nothing here does
   * that, so schedule it after the current module graph has finished loading —
   * that is when src/main/index.ts has attached its `app.on('ready')` listeners.
   */
  private scheduleReady(): void {
    setImmediate(() => {
      this.readyEmitted = true
      this.emit('ready')
    })
  }

  whenReady(): Promise<void> {
    return new Promise((resolve) => {
      if (this.readyEmitted) return resolve()
      this.once('ready', () => resolve())
    })
  }

  quit(): void {
    this.isQuitting = true
    this.emit('before-quit')
    this.emit('will-quit')
    // The HTTP bridge owns the process lifetime; it decides when to exit.
  }

  exit(code = 0): void {
    process.exit(code)
  }

  relaunch(): void {
    console.warn('[shim] app.relaunch() is a no-op headless; restart the service instead')
  }

  setAppUserModelId(): void {}

  commandLine = {
    appendSwitch: (_key: string, _value?: string) => {},
    appendArgument: (_value: string) => {},
    hasSwitch: (_key: string) => false,
    getSwitchValue: (_key: string) => '',
  }

  disableHardwareAcceleration(): void {}

  on(event: AppEvent, listener: (...args: any[]) => void): this {
    return super.on(event, listener)
  }
}

export const app = new ShimApp()
app.scheduleReady()

// ---------------------------------------------------------------------------
// safeStorage
// ---------------------------------------------------------------------------

/**
 * Electron's safeStorage is backed by the OS keychain. Headless boxes (and
 * Termux) have no such thing, so credentials are sealed with a 32-byte key in
 * the user data dir. That is not keychain-grade security, but it is
 * consistently available and keeps the exact same call contract as Electron.
 */
class ShimSafeStorage {
  private keyCache: Buffer | null = null

  private keyFile(): string {
    return path.join(resolveUserData(), 'safe-storage.key')
  }

  private getKey(): Buffer {
    if (this.keyCache) return this.keyCache
    const file = this.keyFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try {
      const existing = fs.readFileSync(file)
      if (existing.length === 32) {
        this.keyCache = existing
        return existing
      }
    } catch {
      // fall through and generate
    }
    const key = crypto.randomBytes(32)
    fs.writeFileSync(file, key, { mode: 0o600 })
    this.keyCache = key
    return key
  }

  isEncryptionAvailable(): boolean {
    return true
  }

  getSelectedStorageBackend(): string {
    return 'chat2api-headless-aes-256-gcm'
  }

  encryptString(plainText: string): Buffer {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.getKey(), iv)
    const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    // iv | tag | ciphertext
    return Buffer.concat([iv, tag, ciphertext])
  }

  decryptString(encrypted: Buffer): string {
    const iv = encrypted.subarray(0, 12)
    const tag = encrypted.subarray(12, 28)
    const ciphertext = encrypted.subarray(28)
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.getKey(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  }
}

export const safeStorage = new ShimSafeStorage()

// ---------------------------------------------------------------------------
// ipcMain / ipcRenderer
// ---------------------------------------------------------------------------

type IpcHandler = (event: any, ...args: any[]) => any

export interface IpcInvokeRecord {
  channel: string
  args: unknown[]
  at: number
}

class ShimIpcMain extends EventEmitter {
  readonly handlers = new Map<string, IpcHandler>()
  /** Recently invoked channels, exposed on /healthz for troubleshooting. */
  readonly recent: IpcInvokeRecord[] = []

  handle(channel: string, handler: IpcHandler): void {
    if (this.handlers.has(channel)) {
      throw new Error(`Attempted to register a second handler for '${channel}'`)
    }
    this.handlers.set(channel, handler)
  }

  handleOnce(channel: string, handler: IpcHandler): void {
    this.handle(channel, handler)
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }

  async invoke(channel: string, event: any, args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) {
      throw new Error(`No handler registered for '${channel}'`)
    }
    this.recent.push({ channel, args, at: Date.now() })
    if (this.recent.length > 200) this.recent.shift()
    return await handler(event, ...args)
  }
}

export const ipcMain = new ShimIpcMain()

// ---------------------------------------------------------------------------
// BrowserWindow (null object)
// ---------------------------------------------------------------------------

/**
 * The main process only uses BrowserWindow to push events to the UI and to
 * host the in-app login window. Headless, the "window" is the SSE stream, so a
 * BrowserWindow instance is a stub whose webContents re-broadcasts to a bus the
 * HTTP layer listens on.
 */
class ShimWebContents extends EventEmitter {
  send(channel: string, ...args: unknown[]): void {
    windowBus.emit('send', channel, args)
  }

  isDestroyed(): boolean {
    return false
  }

  setWindowOpenHandler(): void {}
  on(): this { return this }

  async executeJavaScript(): Promise<unknown> {
    return undefined
  }

  openDevTools(): void {}

  getURL(): string {
    return 'http://localhost/'
  }
}

class ShimBrowserWindow extends EventEmitter {
  webContents = new ShimWebContents()
  id = 1
  isDestroyedFlag = false

  constructor(public options: Record<string, unknown> = {}) {
    super()
  }

  static getAllWindows(): ShimBrowserWindow[] {
    return [mainWindowRef as ShimBrowserWindow]
  }
  static getFocusedWindow(): ShimBrowserWindow | null {
    return mainWindowRef as ShimBrowserWindow
  }
  static fromWebContents(): ShimBrowserWindow | null {
    return mainWindowRef as ShimBrowserWindow
  }

  loadURL(): Promise<void> { return Promise.resolve() }
  loadFile(): Promise<void> { return Promise.resolve() }
  show(): void {}
  hide(): void {}
  focus(): void {}
  blur(): void {}
  close(): void {}
  destroy(): void { this.isDestroyedFlag = true }
  isDestroyed(): boolean { return this.isDestroyedFlag }
  isMinimized(): boolean { return false }
  isVisible(): boolean { return true }
  minimize(): void {}
  maximize(): void {}
  restore(): void {}
  setTitle(): void {}
  setMenu(): void {}
  setMenuBarVisibility(): void {}
  removeMenu(): void {}
  setAlwaysOnTop(): void {}
  setIgnoreMouseEvents(): void {}
  setBounds(): void {}
  getBounds() { return { x: 0, y: 0, width: 1200, height: 800 } }
  getPosition(): [number, number] { return [0, 0] }
  setPosition(): void {}
  getSize(): [number, number] { return [1200, 800] }
  setSize(): void {}
  showInactive(): void {}
  center(): void {}
  moveTop(): void {}
}

/** At most one logical window exists; handlers pass it around by reference. */
let mainWindowRef: ShimBrowserWindow | null = null

function ensureMainWindow(): ShimBrowserWindow {
  if (!mainWindowRef) mainWindowRef = new ShimBrowserWindow()
  return mainWindowRef
}

export class BrowserWindow extends ShimBrowserWindow {
  constructor(options: Record<string, unknown> = {}) {
    super(options)
    mainWindowRef = this
  }
}

export namespace BrowserWindow {
  export function getAllWindows(): ShimBrowserWindow[] {
    return mainWindowRef ? [mainWindowRef] : []
  }
  export function getFocusedWindow(): ShimBrowserWindow | null {
    return mainWindowRef
  }
  export function fromWebContents(): ShimBrowserWindow | null {
    return mainWindowRef
  }
}

/** Creates (once) the logical window the IPC handlers broadcast to. */
export function getOrCreateBrowserWindow(): ShimBrowserWindow {
  return ensureMainWindow()
}

// ---------------------------------------------------------------------------
// windowBus: main -> renderer event fan-out
// ---------------------------------------------------------------------------

class WindowBus extends EventEmitter {}

/**
 * Every `webContents.send(channel, ...)` in the main process lands here; the
 * HTTP bridge relays it to connected SSE clients.
 */
export const windowBus = new WindowBus()

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------

export const shell = {
  async openExternal(url: string): Promise<void> {
    // Print it so the operator can copy/paste it into a phone browser.
    console.log(`[openExternal] ${url}`)
  },
  async openPath(p: string): Promise<string> {
    console.log(`[openPath] ${p}`)
    return ''
  },
  showItemInFolder(): void {},
  beep(): void {},
}

// ---------------------------------------------------------------------------
// net (Electron net.request -> node http)
// ---------------------------------------------------------------------------

export interface ShimClientRequest extends EventEmitter {
  write(chunk: any): void
  end(): void
  abort(): void
  setHeader(name: string, value: string): void
  getHeader(name: string): string | undefined
  followRedirect(): void
}

class NodeClientRequest extends EventEmitter implements ShimClientRequest {
  private req: http.ClientRequest | null = null
  private headers: Record<string, string> = {}
  private body: Buffer[] = []
  private ended = false

  constructor(
    private options: {
      method?: string
      url: string
      headers?: Record<string, string>
      redirect?: string
      session?: unknown
    }
  ) {
    super()
    this.headers = { ...(options.headers ?? {}) }
  }

  setHeader(name: string, value: string): void {
    this.headers[name] = value
  }

  getHeader(name: string): string | undefined {
    return this.headers[name]
  }

  followRedirect(): void {}

  write(chunk: any): void {
    this.body.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    this.start()
  }

  private start(): void {
    const target = new URL(this.options.url)
    const isHttps = target.protocol === 'https:'
    const payload = this.body.length ? Buffer.concat(this.body) : null
    const headers = { ...this.headers }
    if (payload && !headers['Content-Length'] && !headers['content-length']) {
      headers['Content-Length'] = String(payload.length)
    }

    const req = (isHttps ? https : http).request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: this.options.method ?? 'GET',
        headers,
      },
      (res) => {
        const incoming = new EventEmitter() as EventEmitter & {
          statusCode: number
          headers: Record<string, string | string[] | undefined>
        }
        incoming.statusCode = res.statusCode ?? 0
        incoming.headers = res.headers

        res.on('data', (chunk: Buffer) => incoming.emit('data', chunk))
        res.on('end', () => {
          incoming.emit('end')
          this.emit('response', incoming)
        })
        res.on('error', (err) => this.emit('error', err))
      }
    )

    req.on('error', (err) => this.emit('error', err))
    if (payload) req.write(payload)
    req.end()
    this.req = req
  }

  abort(): void {
    this.req?.destroy()
    this.emit('abort')
  }
}

export const net = {
  request(options: {
    method?: string
    url: string
    headers?: Record<string, string>
    redirect?: string
    session?: unknown
  }): ShimClientRequest {
    return new NodeClientRequest(options)
  },
  async fetch(input: string, init?: RequestInit): Promise<Response> {
    return await fetch(input, init)
  },
  isOnline(): boolean {
    return true
  },
}

// ---------------------------------------------------------------------------
// Inert UI shells
// ---------------------------------------------------------------------------

export class Tray extends EventEmitter {
  constructor(_icon?: unknown) { super() }
  setToolTip(): void {}
  setTitle(): void {}
  setContextMenu(): void {}
  popUpContextMenu(): void {}
  destroy(): void {}
  isDestroyed(): boolean { return true }
}

export class Menu {
  static buildFromTemplate(template: unknown[]): Menu { return new Menu(template) }
  static setApplicationMenu(): void {}
  static getApplicationMenu(): null { return null }
  constructor(public items: unknown[] = []) {}
  popup(): void {}
  closePopup(): void {}
}

export class MenuItem {
  constructor(public options: Record<string, unknown> = {}) {}
}

export const nativeImage = {
  createFromPath(_p: string) {
    return { isEmpty: () => true, resize: () => nativeImage.createEmpty(), toPNG: () => Buffer.alloc(0) }
  },
  createFromBuffer(_b: Buffer, _opts?: unknown) {
    return { isEmpty: () => true, resize: () => nativeImage.createEmpty(), toPNG: () => Buffer.alloc(0) }
  },
  createEmpty() {
    return { isEmpty: () => true, resize: () => nativeImage.createEmpty(), toPNG: () => Buffer.alloc(0) }
  },
}

export const screen = {
  getPrimaryDisplay() {
    return { id: 1, bounds: { x: 0, y: 0, width: 1200, height: 800 }, workArea: { x: 0, y: 0, width: 1200, height: 800 }, scaleFactor: 1 }
  },
  getAllDisplays() {
    return [screen.getPrimaryDisplay()]
  },
}

class ShimSession extends EventEmitter {
  setProxy(): Promise<void> { return Promise.resolve() }
  clearStorageData(): Promise<void> { return Promise.resolve() }
  cookies = {
    get: async () => [],
    set: async () => {},
    remove: async () => {},
    flushStore: async () => {},
  }
  webRequest = {
    onBeforeSendHeaders: () => {},
    onHeadersReceived: () => {},
    onCompleted: () => {},
    onResponseStarted: () => {},
  }
  protocol = { handle: () => {} }
}

const defaultSession = new ShimSession()

export const session = Object.assign(defaultSession, {
  fromPartition: (_partition: string) => new ShimSession(),
  defaultSession,
})

export const contextBridge = {
  exposeInMainWorld(_key: string, _api: unknown): void {
    // Only meaningful in a renderer process; the browser build uses its own shim.
  },
}

export const ipcRenderer = {
  invoke: async (): Promise<never> => {
    throw new Error('ipcRenderer is not available in the main process')
  },
  send: (): void => {},
  on: (): void => {},
  removeListener: (): void => {},
  removeAllListeners: (): void => {},
}

export const dialog = {
  async showMessageBox(): Promise<{ response: number }> { return { response: 0 } },
  async showOpenDialog(): Promise<{ canceled: boolean; filePaths: string[] }> {
    return { canceled: true, filePaths: [] }
  },
  async showSaveDialog(): Promise<{ canceled: boolean; filePath?: string }> {
    return { canceled: true }
  },
}

export const clipboard = {
  writeText: (): void => {},
  readText: (): string => '',
}

export const powerMonitor = new EventEmitter()

export const globalShortcut = {
  register: (): boolean => false,
  unregisterAll: (): void => {},
}

export const protocol = {
  registerSchemesAsPrivileged: (): void => {},
  handle: (): void => {},
}

export default {
  app,
  BrowserWindow,
  safeStorage,
  ipcMain,
  ipcRenderer,
  shell,
  net,
  Tray,
  Menu,
  MenuItem,
  nativeImage,
  screen,
  session,
  contextBridge,
  dialog,
  clipboard,
  powerMonitor,
  globalShortcut,
  protocol,
}
