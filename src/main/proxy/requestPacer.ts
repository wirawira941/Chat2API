/**
 * Per-account request pacer.
 *
 * Provider web endpoints limit per account, and a burst of parallel requests on
 * one token looks exactly like a scraper. Every upstream call for a given
 * account therefore waits its turn: requests are serialised and a minimum gap
 * (plus jitter) is inserted between them. Different accounts keep independent
 * queues, so adding accounts still scales throughput.
 */
export class RequestPacer {
  /** Tail of each account's queue: the promise that resolves when it is free. */
  private tails: Map<string, Promise<void>> = new Map()
  /** Earliest wall-clock time the next request for an account may start. */
  private nextAllowedAt: Map<string, number> = new Map()

  private minInterval: number
  private jitter: number

  constructor(minInterval = 0, jitter = 0) {
    this.minInterval = Math.max(0, minInterval)
    this.jitter = Math.max(0, jitter)
  }

  setPolicy(minInterval: number, jitter: number): void {
    this.minInterval = Math.max(0, minInterval)
    this.jitter = Math.max(0, jitter)
  }

  /** Random extra wait in [0, jitter], so requests never form a fixed cadence. */
  private randomJitter(): number {
    return this.jitter > 0 ? Math.floor(Math.random() * this.jitter) : 0
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Wait until this account may issue its next upstream request.
   * Resolves when the caller is cleared to proceed; the next caller in line
   * inherits the slot after this one's minimum interval.
   */
  async acquire(accountId: string): Promise<void> {
    if (this.minInterval === 0 && this.jitter === 0) return

    const previous = this.tails.get(accountId) ?? Promise.resolve()

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    this.tails.set(accountId, gate)

    // Queue behind whoever holds the account right now.
    await previous

    const now = Date.now()
    const allowedAt = this.nextAllowedAt.get(accountId) ?? 0
    if (allowedAt > now) {
      await this.sleep(allowedAt - now)
    }

    // Book the next slot before releasing, so queued callers keep the gap.
    this.nextAllowedAt.set(accountId, Date.now() + this.minInterval + this.randomJitter())
    release()

    // Let the map shrink on a quiet account instead of growing forever.
    if (this.tails.get(accountId) === gate) {
      this.tails.delete(accountId)
    }
  }

  /** Drop all pacing state (used when config changes or accounts are removed). */
  reset(): void {
    this.tails.clear()
    this.nextAllowedAt.clear()
  }
}

export const requestPacer = new RequestPacer()
export default requestPacer
