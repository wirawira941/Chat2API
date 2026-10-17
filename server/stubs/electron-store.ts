/**
 * Node replacement for `electron-store` (v10 is ESM-only and needs Electron's
 * `app` for its default cwd).
 *
 * Only the surface Chat2API actually uses is implemented: a lazily created JSON
 * file, `get`/`set`/`clear` on top-level keys, and `defaults` merging. Writes go
 * through a temp file + rename so a crash mid-write cannot truncate the store.
 *
 * Unlike the desktop build the file is NOT encrypted: the encryption key the
 * app passes is a hard-coded constant, so encrypting would add no secrecy while
 * making the file impossible to inspect with `cat`/`jq` on a phone.
 */

import fs from 'node:fs'
import path from 'node:path'

export interface StoreOptions<T extends Record<string, unknown>> {
  name?: string
  cwd?: string
  defaults?: T
  encryptionKey?: string
  clearInvalidConfig?: boolean
  fileExtension?: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value))
}

export default class Store<T extends Record<string, unknown>> {
  private readonly filePath: string
  private readonly defaults: T
  private cache: T

  constructor(options: StoreOptions<T> = {}) {
    const name = options.name ?? 'config'
    const ext = options.fileExtension ?? 'json'
    const dir = options.cwd ?? process.cwd()
    fs.mkdirSync(dir, { recursive: true })
    this.filePath = path.join(dir, `${name}.${ext}`)
    this.defaults = clone(options.defaults ?? ({} as T))
    this.cache = this.read()
  }

  private read(): T {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      if (!isPlainObject(raw)) return { ...this.defaults } as T
      // `defaults` are a template: keep stored values and fill in new keys so
      // upgrades that add config fields do not need a migration.
      return { ...this.defaults, ...raw } as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[store] cannot read ${this.filePath}, starting fresh:`, error)
      }
      return { ...this.defaults } as T
    }
  }

  private write(): void {
    const tmp = `${this.filePath}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.filePath)
  }

  get<K extends keyof T>(key: K): T[K]
  get<K extends keyof T>(key: K, defaultValue: T[K]): T[K]
  get(key: string, defaultValue?: unknown): unknown {
    const value = (this.cache as Record<string, unknown>)[key]
    return value === undefined ? defaultValue : clone(value)
  }

  set(key: string, value: unknown): void {
    ;(this.cache as Record<string, unknown>)[key] = clone(value)
    this.write()
  }

  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.cache, key)
  }

  delete(key: string): void {
    delete (this.cache as Record<string, unknown>)[key]
    this.write()
  }

  clear(): void {
    this.cache = { ...this.defaults } as T
    this.write()
  }

  get store(): T {
    return clone(this.cache)
  }

  set store(value: T) {
    this.cache = clone(value)
    this.write()
  }

  get path(): string {
    return this.filePath
  }

  get size(): number {
    return Object.keys(this.cache).length
  }

  onDidChange(): () => void {
    return () => {}
  }

  onDidAnyChange(): () => void {
    return () => {}
  }
}
