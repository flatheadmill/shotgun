import test from 'node:test'
import assert from 'node:assert/strict'
import { setSink } from '../log.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred () {
  let resolve; let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function event () {
  const listeners = []
  return { addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)) }
}

let imports = 0
// Exercise the actual worker dispatch and Chrome listeners, with no extension
// load, page traffic, or Easement connection. Live reader checks are separate.
async function worker ({ attach = async () => {}, command = async () => {} } = {}) {
  const previous = Object.fromEntries(['chrome', 'WebSocket', 'setInterval', 'clearInterval'].map(k => [k, globalThis[k]]))
  const originalLog = console.log
  const output = []; console.log = value => output.push(value)
  const sockets = []; const commands = []; const attaches = []; const detaches = []
  let queries = 0
  class Socket {
    static OPEN = 1; static CONNECTING = 0
    readyState = 1; bufferedAmount = 0; listeners = {}; frames = []
    constructor () { sockets.push(this) }
    addEventListener (type, fn) { this.listeners[type] = fn }
    send (data) { this.frames.push(JSON.parse(data)) }
    close () { this.readyState = 3; this.listeners.close({ code: 1000 }) }
    receive (packet) { this.listeners.message({ data: JSON.stringify(packet) }) }
  }
  const browser = {
    storage: { local: { get: async () => ({}) } }, tabGroups: {},
    alarms: { create () {}, onAlarm: event() },
    tabs: { onRemoved: event(), onUpdated: event(), query: async () => { queries++; return [{ id: 999 }] },
      get: async () => ({ url: 'https://example.test/', title: 'Fixture' }) },
    debugger: {
      onDetach: event(), onEvent: event(),
      attach: async (target, version) => { attaches.push({ target, version }); return attach(target) },
      detach: async target => { detaches.push(target) },
      sendCommand: async (target, method, params) => {
        commands.push({ target, method, params })
        if (method === 'Page.captureScreenshot') return { data: 'JPEG_SENTINEL' }
        return command(method, params, target)
      }
    },
    scripting: { executeScript: async () => [{ result: { dpr: 2, width: 800, height: 600 } }] }
  }
  globalThis.chrome = browser; globalThis.WebSocket = Socket
  globalThis.setInterval = () => 1; globalThis.clearInterval = () => {}
  const cleanup = async () => {
    for (const socket of sockets) if (socket.readyState === 1) socket.close()
    await tick()
    setSink(null)
    console.log = originalLog
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[name]
      else globalThis[name] = value
    }
  }
  try {
    await import(`../service-worker.js?firehose-test=${++imports}`)
    sockets[0].listeners.open()
  } catch (error) { await cleanup(); throw error }
  return { browser, sockets, commands, attaches, detaches, output, cleanup, queries: () => queries }
}

const call = (socket, callId, args, slug = 'seat-a') => socket.receive({
  what: 'tool', why: 'run', f: 'firehose', call_id: callId, slug, ...args
})
const reply = (socket, callId) => socket.frames.find(f => f.what === 'tool' && f.call_id === callId)
const result = (socket, callId) => JSON.parse(reply(socket, callId).output)
function completed (browser, tabId, requestId) {
  browser.debugger.onEvent.emit({ tabId }, 'Network.responseReceived', {
    requestId, response: { url: 'https://example.test/API_SELECTOR_SENTINEL?PRIVATE_QUERY_SENTINEL',
      status: 200, headers: { private: 'PRIVATE_HEADER_SENTINEL' } }
  })
  browser.debugger.onEvent.emit({ tabId }, 'Network.loadingFinished', { requestId })
}

test('actual Firehose dispatch keeps local replies, quiet capture, and shared screenshot attachment', async () => {
  let heldEnable = deferred()
  const body = deferred(); let bodies = 0
  const fixture = await worker({ command: method => {
    if (method === 'Network.enable' && heldEnable) return heldEnable.promise
    if (method === 'Network.getResponseBody') return bodies++ === 0 ? body.promise
      : Promise.reject(new Error('PRIVATE_ERROR_SENTINEL'))
  } })
  const { browser, sockets, commands, attaches, detaches, output } = fixture
  const first = sockets[0]
  try {
    const registration = first.frames.find(f => f.what === 'socket' && f.why === 'connect')
    assert.equal(registration.tools.length, 9)
    assert.ok(registration.tools.some(t => t.f === 'firehose'))
    assert.equal(registration.tools.some(t => t.f === 'read_network_requests'), false)
    call(first, 'unarmed', { action: 'read' })
    call(first, 'missing-tab', { action: 'start' })
    await tick()
    assert.equal(result(first, 'unarmed').hasCapture, false)
    assert.equal(reply(first, 'missing-tab').exit_code, 1)
    assert.equal(commands.length, 0)
    assert.equal(attaches.length, 0)
    assert.equal(fixture.queries(), 0)

    call(first, 'original-start', { action: 'start', tabId: 7 }, 'original-seat')
    await tick()
    call(first, 'other-slug', { action: 'read' }, 'other-seat')
    heldEnable.resolve(); heldEnable = null; await tick()
    assert.equal(result(first, 'original-start').tabId, 7)
    const trace = first.frames.find(f => f.what === 'log' && f.with?.what === 'respond' && f.with.with.call_id === 'original-start')
    assert.equal(trace.with.with.slug, 'original-seat')
    call(first, 'stop-first', { action: 'stop' }); await tick()

    heldEnable = deferred()
    call(first, 'disconnected-start', { action: 'start', tabId: 8,
      url: 'https://example.test/API_SELECTOR_SENTINEL' }, 'disconnected-seat')
    await tick()
    first.close()
    browser.alarms.onAlarm.emit({ name: 'keepalive' })
    const second = sockets[1]; second.listeners.open()
    call(second, 'replacement-read', { action: 'read' }, 'replacement-seat')
    heldEnable.resolve(); heldEnable = null; await tick()
    assert.equal(reply(first, 'disconnected-start'), undefined)
    assert.equal(reply(second, 'disconnected-start'), undefined, 'old call cannot reply on the new socket')
    call(second, 'armed', { action: 'read' })
    assert.equal(result(second, 'armed').tabId, 8)
    assert.equal(result(second, 'armed').state, 'collecting')

    browser.debugger.onEvent.emit({ tabId: 8, sessionId: 'child' }, 'Network.loadingFinished', { requestId: 'ignored-child' })
    completed(browser, 8, 'selected')
    second.receive({ what: 'tool', why: 'run', f: 'screenshot', call_id: 'jpeg', slug: 'screenshot-seat', tabId: 8 })
    await tick()
    assert.equal(result(second, 'jpeg')[1].data, 'JPEG_SENTINEL')
    assert.deepEqual(attaches.map(a => a.target.tabId), [7, 8])
    body.resolve({ body: 'PRIVATE_BODY_SENTINEL', base64Encoded: false }); await tick()
    call(second, 'inventory', { action: 'read' })
    const inventory = result(second, 'inventory')
    assert.equal(inventory.events, 3)
    assert.equal('body' in inventory.records[2], false)
    call(second, 'body', { action: 'read', body: 2 })
    assert.equal(result(second, 'body').record.body, 'PRIVATE_BODY_SENTINEL')
    completed(browser, 8, 'unavailable'); await tick()
    call(second, 'unavailable', { action: 'read', body: 5 })
    assert.equal(reply(second, 'unavailable').exit_code, 0)
    assert.equal(result(second, 'unavailable').record.error, 'PRIVATE_ERROR_SENTINEL')

    call(second, 'stop', { action: 'stop' }); await tick()
    completed(browser, 8, 'after-stop')
    call(second, 'frozen', { action: 'read' })
    assert.equal(result(second, 'frozen').events, 6)
    assert.equal(detaches.length, 0)
    call(second, 'restart', { action: 'start', tabId: 8 }); await tick()
    assert.equal(attaches.length, 2, 'stopping must keep the shared debugger attached')
    browser.debugger.onDetach.emit({ tabId: 8 }, 'canceled_by_user')
    call(second, 'detached', { action: 'read' })
    assert.equal(result(second, 'detached').reason, 'debugger_detached')
    call(second, 'another-tab', { action: 'start', tabId: 9 }); await tick()
    browser.tabs.onRemoved.emit(9)
    call(second, 'removed', { action: 'read' })
    assert.equal(result(second, 'removed').reason, 'tab_removed')
    assert.equal(fixture.queries(), 0)

    const logs = JSON.stringify(sockets.flatMap(s => s.frames.filter(f => f.what === 'log'))) + JSON.stringify(output)
    for (const secret of ['API_SELECTOR_SENTINEL', 'PRIVATE_QUERY_SENTINEL', 'PRIVATE_HEADER_SENTINEL', 'PRIVATE_BODY_SENTINEL', 'PRIVATE_ERROR_SENTINEL']) {
      assert.equal(logs.includes(secret), false, `${secret} escaped into logging`)
    }
  } finally {
    heldEnable?.resolve(); body.resolve({ body: '', base64Encoded: false }); await tick()
    await fixture.cleanup()
  }
})

test('actual shared attachment rejects stale completion without retiring its replacement', async () => {
  const old = deferred(); const fresh = deferred(); let count = 0
  const fixture = await worker({ attach: () => count++ === 0 ? old.promise : fresh.promise })
  const { browser, sockets, attaches, commands } = fixture
  const socket = sockets[0]
  try {
    call(socket, 'old', { action: 'start', tabId: 7 }); await tick()
    browser.debugger.onDetach.emit({ tabId: 7 }, 'canceled_by_user')
    call(socket, 'fresh', { action: 'start', tabId: 7 }); await tick()
    old.resolve(); await tick()
    assert.equal(reply(socket, 'old').exit_code, 1)
    assert.equal(reply(socket, 'fresh'), undefined)
    socket.receive({ what: 'tool', why: 'run', f: 'screenshot', call_id: 'parallel-jpeg', slug: 'another-seat', tabId: 7 })
    await tick()
    assert.equal(attaches.length, 2, 'screenshot must join the replacement attachment')
    assert.equal(commands.length, 0, 'stale attach must not mark the tab attached')
    fresh.resolve(); await tick()
    assert.equal(reply(socket, 'fresh').exit_code, 0)
    assert.equal(result(socket, 'parallel-jpeg')[1].data, 'JPEG_SENTINEL')
    assert.equal(commands.filter(c => c.method === 'Network.enable').length, 1)
  } finally {
    old.resolve(); fresh.resolve(); await tick()
    await fixture.cleanup()
  }
})
