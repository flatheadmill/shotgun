import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { png, call, reply, tick } from './fixture.js'

// Load the actual worker with browser boundary doubles. This is not a claim
// that Chrome or a display was exercised; loaded-extension checks are separate.
test('actual worker closes explicit tabs, routes quiet save status, and preserves JPEG screenshot content', async () => {
  const previous = Object.fromEntries(['chrome', 'WebSocket', 'setInterval', 'clearInterval', 'createImageBitmap'].map(k => [k, globalThis[k]]))
  const originalLog = console.log
  const output = []; console.log = value => output.push(value)
  const frames = []; const commands = []; const removals = []; let captures = 0
  const event = { addListener () {} }
  let socket
  let holdAttach = false
  const pendingAttaches = []
  class Socket {
    static OPEN = 1; static CONNECTING = 0
    readyState = 1; bufferedAmount = 0; listeners = {}
    constructor () { socket = this }
    addEventListener (type, fn) { this.listeners[type] = fn }
    send (data) { frames.push(JSON.parse(data)) }
    close () { this.readyState = 3; this.listeners.close({ code: 1000 }) }
    receive (packet) { this.listeners.message({ data: JSON.stringify(packet) }) }
  }
  globalThis.WebSocket = Socket
  globalThis.setInterval = () => 1; globalThis.clearInterval = () => {}
  globalThis.chrome = {
    storage: { local: { get: async () => ({}) } }, tabGroups: {},
    alarms: { create () {}, onAlarm: event },
    tabs: {
      onRemoved: event, onUpdated: event, query: async () => [{ id: 7 }], get: async () => ({ url: 'https://example.test/', title: 'Fixture' }),
      remove: async tabId => {
        removals.push(tabId)
        if (tabId === 9) throw new Error('No tab with id: 9')
      }
    },
    debugger: { onDetach: event, onEvent: event, attach: async () => { if (holdAttach) await new Promise(resolve => pendingAttaches.push(resolve)) }, sendCommand: async (target, command, params) => {
      commands.push({ target, command, params })
      if (command === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 }, cssContentSize: { x: 0, y: 0, width: 800, height: 2400 } }
      captures++
      return { data: params.format === 'jpeg' ? 'JPEG_SENTINEL' : png().toString('base64') }
    } },
    scripting: { executeScript: async () => [{ result: { dpr: 2, width: 800, height: 600, devicePixelRatio: 2, scrollX: 0, scrollY: 0 } }] }
  }
  globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close () {} })
  try {
    await import('../service-worker.js')
    socket.listeners.open()
    const registered = frames.find(f => f.what === 'socket' && f.why === 'connect')
    assert.ok(registered.tools.some(t => t.f === 'screenshot_save'))
    assert.ok(registered.tools.some(t => t.f === 'tabs_close'))
    assert.equal(registered.tools.length, 10)
    socket.receive({ what: 'tool', why: 'run', f: 'tabs_close', call_id: 'close-success', slug: 'easement', tabId: 12 })
    await tick()
    assert.deepEqual(removals, [12])
    assert.deepEqual(frames.find(f => f.what === 'tool' && f.call_id === 'close-success'), {
      what: 'tool', why: 'response', call_id: 'close-success', output: 'Closed tab 12', exit_code: 0
    })
    for (const [n, tabId] of [undefined, null, 0, -1, 1.5, '7', true, [], [7], {}, Number.MAX_SAFE_INTEGER + 1].entries()) {
      const call_id = `close-invalid-${n}`
      socket.receive({ what: 'tool', why: 'run', f: 'tabs_close', call_id, slug: 'easement', tabId })
      await tick()
      const response = frames.find(f => f.what === 'tool' && f.call_id === call_id)
      assert.equal(response.exit_code, 1)
      assert.match(response.output, /tabId.*positive safe integer/)
      assert.deepEqual(removals, [12], 'invalid IDs must not call chrome.tabs.remove')
    }
    socket.receive({ what: 'tool', why: 'run', f: 'tabs_close', call_id: 'close-failure', slug: 'easement', tabId: 9 })
    await tick()
    assert.deepEqual(removals, [12, 9])
    const closeFailure = frames.find(f => f.what === 'tool' && f.call_id === 'close-failure')
    assert.equal(closeFailure.exit_code, 1)
    assert.equal(closeFailure.output, 'No tab with id: 9')
    socket.receive({ ...call({ action: 'status' }), what: 'tool', why: 'run', f: 'screenshot_save' })
    await tick()
    const query = frames.find(f => f.what === 'screenshot_save' && f.why === 'status')
    const status = reply(query, 'unknown')
    socket.receive(status)
    await tick()
    const response = frames.find(f => f.what === 'tool' && f.call_id === 'call-1')
    assert.deepEqual(JSON.parse(response.output), status)
    assert.equal(captures, 0)
    socket.receive({ ...call({ action: 'abandon', call_id: 'abandon-call', operation_id: 'abandon-op' }), what: 'tool', why: 'run', f: 'screenshot_save' })
    await tick()
    const abandonStatus = frames.find(f => f.what === 'screenshot_save' && f.why === 'status' && f.call_id === 'abandon-call')
    socket.receive(reply(abandonStatus, 'unknown'))
    await tick()
    const abandon = frames.find(f => f.what === 'screenshot_save' && f.why === 'abandon' && f.call_id === 'abandon-call')
    socket.receive(reply(abandon, 'abandoned'))
    await tick()
    const abandoned = frames.find(f => f.what === 'tool' && f.call_id === 'abandon-call')
    assert.equal(JSON.parse(abandoned.output).why, 'abandoned')
    assert.equal(abandoned.exit_code, 0)
    socket.receive({ what: 'screenshot_save', why: 'chunk', call_id: 'retired', data: 'RAW_SCREENSHOT_SENTINEL' })
    socket.listeners.message({ data: '{RAW_SCREENSHOT_SENTINEL' })
    socket.receive({ what: 'tool', why: 'run', f: 'screenshot', call_id: 'jpeg-call', slug: 'easement', tabId: 7 })
    await tick()
    const legacy = frames.find(f => f.what === 'tool' && f.call_id === 'jpeg-call')
    assert.deepEqual(JSON.parse(legacy.output), [{ type: 'text', text: 'screenshot (image/jpeg)' }, { type: 'image', data: 'JPEG_SENTINEL', mimeType: 'image/jpeg' }])
    const capture = commands.at(-1)
    assert.equal(capture.params.format, 'jpeg'); assert.equal(capture.params.quality, 75)
    assert.equal(capture.params.captureBeyondViewport, false)
    assert.equal(JSON.stringify(frames.filter(f => f.what === 'log')).includes('RAW_SCREENSHOT_SENTINEL'), false)
    assert.equal(JSON.stringify(output).includes('RAW_SCREENSHOT_SENTINEL'), false)
    holdAttach = true
    for (let n = 0; n < 2; n++) {
      socket.receive({ ...call({ call_id: `parallel-${n}`, operation_id: `parallel-${n}`, tabId: 8 }), what: 'tool', why: 'run', f: 'screenshot_save' })
    }
    await tick()
    const queries = frames.filter(f => f.what === 'screenshot_save' && f.why === 'status' && f.call_id.startsWith('parallel-'))
    assert.equal(queries.length, 2)
    for (const query of queries) socket.receive(reply(query, 'unknown'))
    await tick()
    assert.equal(pendingAttaches.length, 1, 'concurrent saves must share the in-flight debugger attachment')
    for (const resolve of pendingAttaches.splice(0)) resolve()
    const beginPackets = () => frames.filter(f => f.what === 'screenshot_save' && f.why === 'begin' && f.call_id.startsWith('parallel-'))
    // Web Crypto and bitmap decoding can settle on different event-loop turns.
    // Wait for the protocol observation, with a deadline, rather than assuming
    // that one tick represents completion of both independent captures.
    const deadline = performance.now() + 2000
    while (beginPackets().length < 2 && performance.now() < deadline) await delay(5)
    const begins = beginPackets()
    assert.equal(begins.length, 2, 'both concurrent captures must reach begin before the deadline')
    for (const begin of begins) socket.receive(reply(begin, 'rejected', { reason: 'test complete' }))
    await tick()
    const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url)))
    assert.equal(manifest.permissions.includes('unlimitedStorage'), false)
  } finally {
    socket?.close()
    for (const resolve of pendingAttaches.splice(0)) resolve()
    await tick()
    console.log = originalLog
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[name]
      else globalThis[name] = value
    }
  }
})
