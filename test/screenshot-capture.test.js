import test from 'node:test'
import assert from 'node:assert/strict'
import { capturePng } from '../screenshot-capture.js'
import { png, call } from './fixture.js'

function browser (options = {}) {
  const commands = []; const tabs = []; let closed = false
  const bytes = png(3, 2)
  const env = {
    chrome: {
      tabs: { get: async tabId => { tabs.push(tabId); return { url: 'https://example.test/', title: 'Fixture' } }, query: async () => [{ id: 99 }] },
      debugger: { sendCommand: async (target, method, params) => {
        commands.push({ target, method, params })
        if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 3, clientHeight: 2, zoom: 0.5 }, cssContentSize: { x: 0, y: 0, width: 3, height: 10 } }
        return { data: bytes.toString('base64') }
      } },
      scripting: { executeScript: async () => [{ result: { dpr: 2 } }] }
    },
    getContext: async slug => ({ currentTabId: slug === 'first' ? 11 : 22 }),
    ensureDebugger: async tabId => commands.push({ attach: tabId }),
    decodeImage: async blob => { assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes); return { width: 3, height: 2, close: () => { closed = true } } },
    ...options
  }
  return { env, commands, tabs, bytes, closed: () => closed }
}

test('exact capture uses the selected tab, PNG CDP, bounded decode, and retains observed dimensions', async () => {
  const b = browser()
  const image = await capturePng(call({ slug: 'first' }), b.env)
  assert.deepEqual(b.tabs, [11])
  assert.deepEqual(Buffer.from(image.bytes), b.bytes)
  assert.deepEqual(b.commands.at(-1).params, { format: 'png', fromSurface: true, captureBeyondViewport: false })
  assert.equal(image.tabId, 11); assert.equal(image.source_title, 'Fixture'); assert.equal(image.capture_metrics.dpr, 2)
  assert.equal(image.pixel_width, 3); assert.equal(image.pixel_height, 2); assert.ok(b.closed())
})
test('full page takes one surface capture with the CSS rectangle converted to DIPs', async () => {
  const b = browser()
  await capturePng(call({ mode: 'full_page', tabId: 7 }), b.env)
  assert.deepEqual(b.commands.at(-1).params.clip, { x: 0, y: 0, width: 1.5, height: 5, scale: 1 })
  assert.equal(b.commands.filter(c => c.method === 'Page.captureScreenshot').length, 1)
  assert.deepEqual(b.tabs, [7])
})
test('decode mismatch closes the bitmap and rejects; capture does not produce a manifest', async () => {
  let closed = false
  const b = browser({ decodeImage: async () => ({ width: 30, height: 2, close: () => { closed = true } }) })
  await assert.rejects(capturePng(call(), b.env), /decoded dimensions differ/)
  assert.ok(closed)
})
test('concurrent captures do not exchange slug-selected tabs', async () => {
  const b = browser()
  const result = await Promise.all([capturePng(call({ slug: 'first' }), b.env), capturePng(call({ slug: 'second' }), b.env)])
  assert.deepEqual(result.map(r => r.tabId), [11, 22])
})
