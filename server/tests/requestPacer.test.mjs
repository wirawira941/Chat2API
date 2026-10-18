import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// requestPacer is TypeScript, and the rest of the suite runs on plain node --test
// without a TS loader. Compile just this module to a temp file and import it.
let RequestPacer

test('set up requestPacer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pacer-'))
  const out = join(dir, 'requestPacer.mjs')
  await build({
    entryPoints: ['src/main/proxy/requestPacer.ts'],
    outfile: out,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  })
  ;({ RequestPacer } = await import(pathToFileURL(out).href))
  globalThis.__pacerDir = dir
})

test('serialises requests per account and keeps the minimum gap', async () => {
  const pacer = new RequestPacer(120, 0)
  const started = []

  await Promise.all(
    [0, 1, 2, 3].map(async () => {
      await pacer.acquire('acc-a')
      started.push(Date.now())
    })
  )

  assert.equal(started.length, 4)
  // Every adjacent pair must respect the interval (couple ms of timer slop);
  // the point is that they are not all fired in the same tick.
  for (let i = 1; i < started.length; i++) {
    const gap = started[i] - started[i - 1]
    assert.ok(gap >= 110, `gap ${i} was ${gap}ms, expected >= 110ms`)
  }
})

test('different accounts do not block each other', async () => {
  const pacer = new RequestPacer(300, 0)
  const t0 = Date.now()

  await Promise.all([pacer.acquire('acc-a'), pacer.acquire('acc-b')])
  const elapsed = Date.now() - t0

  assert.ok(elapsed < 150, `independent accounts waited ${elapsed}ms`)
})

test('a zero policy never waits', async () => {
  const pacer = new RequestPacer(0, 0)
  const t0 = Date.now()
  for (let i = 0; i < 50; i++) await pacer.acquire('acc-a')
  assert.ok(Date.now() - t0 < 100, 'pacer throttled with a zero policy')
})

test('tear down', () => {
  if (globalThis.__pacerDir) rmSync(globalThis.__pacerDir, { recursive: true, force: true })
})
