/**
 * Stub for `electron-updater`.
 *
 * Auto-update is an Electron-only capability: it reads the app bundle and swaps
 * it in place. The headless build is updated by pulling the repo / replacing the
 * bundle, so every operation reports a clear, non-fatal "unsupported" status
 * instead of crashing the dashboard's Settings page.
 */

import { EventEmitter } from 'node:events'

const UNSUPPORTED = 'Auto-update is not available in the headless web build.'

class StubAutoUpdater extends EventEmitter {
  autoDownload = false
  autoInstallOnAppQuit = false
  allowPrerelease = false
  allowDowngrade = false
  forceDevUpdateConfig = false
  logger: unknown = null

  async checkForUpdates(): Promise<null> {
    console.log('[updater] checkForUpdates skipped —', UNSUPPORTED)
    this.emit('update-not-available', { version: '0.0.0' })
    return null
  }

  async checkForUpdatesAndNotify(): Promise<null> {
    return await this.checkForUpdates()
  }

  async downloadUpdate(): Promise<never> {
    throw new Error(UNSUPPORTED)
  }

  quitAndInstall(): void {
    console.log('[updater] quitAndInstall skipped —', UNSUPPORTED)
  }

  setFeedURL(): void {}
}

export const autoUpdater = new StubAutoUpdater()
export type UpdateInfo = { version: string }
export type ProgressInfo = { percent: number }
export default { autoUpdater }
