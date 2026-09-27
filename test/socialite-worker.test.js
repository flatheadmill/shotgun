import test from 'node:test'
import assert from 'node:assert/strict'
import { setSink } from '../log.js'
import { body, tweet, actual, BOOKMARKS, tick, until, deferred } from './socialite-fixture.js'

function event () {
  const listeners = []
  return { addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)) }
}
let imports = 0
// This loads the actual worker and dispatches through its Chrome/WebSocket
// listeners. It does not load an extension or contact X or a running Easement.
async function worker ({ attach = async () => {}, command = async () => {}, hold = () => false } = {}) {
  const previous = Object.fromEntries(['chrome', 'WebSocket', 'setInterval', 'clearInterval'].map(k => [k, globalThis[k]]))
  const originalLog = console.log; const output = []; console.log = value => output.push(value)
  const sockets = []; const commands = []; const attaches = []; const detaches = []; const held = []
  const objects = new Map(); const routes = new Map(); const bodies = new Map()
  let presence = 'available'; let url = 'https://x.com/i/bookmarks'; let queries = 0
  class Socket {
    static OPEN = 1; static CONNECTING = 0
    readyState = 1; bufferedAmount = 0; listeners = {}; frames = []
    constructor () { sockets.push(this) }
    addEventListener (type, fn) { this.listeners[type] = fn }
    close () { this.readyState = 3; this.listeners.close({ code: 1000, reason: 'PRIVATE_CLOSE_ERROR' }) }
    receive (packet) { this.listeners.message({ data: JSON.stringify(packet) }) }
    send (data) {
      const packet = JSON.parse(data); this.frames.push(packet)
      if (packet.what !== 'companion_ingress' || packet.why === 'abort') return
      queueMicrotask(() => {
        const reply = { what: packet.what, operation_id: packet.operation_id, attempt_id: packet.attempt_id }
        if (packet.why === 'probe') {
          reply.why = presence === 'available' ? 'available' : 'rejected'
          if (reply.why === 'rejected') reply.reason = presence
        } else {
          let route = routes.get(packet.attempt_id)
          if (!route) { route = { binding: { route_id: crypto.randomUUID(), source: 1, receiver: 2 }, manifest: packet.manifest, chunks: [] }; routes.set(packet.attempt_id, route) }
          reply.binding = route.binding
          if (packet.why === 'begin') { reply.why = 'ready'; reply.offset = 0 }
          else if (packet.why === 'chunk') {
            const bytes = Buffer.from(packet.data, 'base64'); route.chunks.push(bytes)
            reply.why = 'ack'; reply.offset = packet.offset + bytes.length
          } else if (packet.why === 'finish') {
            const receipt = { version: 1, operation_id: packet.operation_id, manifest: route.manifest, recorded_at_ms: 1 }
            objects.set(packet.operation_id, { receipt, bytes: Buffer.concat(route.chunks) })
            reply.why = 'stored'; reply.receipt = receipt
          } else if (packet.why === 'lookup') {
            const stored = objects.get(packet.operation_id)
            reply.why = stored ? 'stored' : 'unknown'; if (stored) reply.receipt = stored.receipt
          }
        }
        if (hold(packet, reply)) held.push({ packet, reply, socket: this })
        else this.receive(reply)
      })
    }
  }
  const browser = {
    storage: { local: { get: async () => ({}) } }, tabGroups: {},
    alarms: { create () {}, onAlarm: event() },
    tabs: { onRemoved: event(), onUpdated: event(), query: async () => { queries++; return [{ id: 999 }] }, get: async () => ({ url }) },
    debugger: {
      onDetach: event(), onEvent: event(),
      attach: async target => { attaches.push(target); return attach(target) },
      detach: async target => { detaches.push(target) },
      sendCommand: async (target, method, params) => {
        commands.push({ target, method, params })
        if (method === 'Page.captureScreenshot') return { data: 'JPEG_SENTINEL' }
        if (method === 'Network.getResponseBody') return bodies.get(params.requestId)
        return command(method, params, target)
      }
    },
    scripting: { executeScript: async () => [{ result: { dpr: 2, width: 800, height: 600 } }] }
  }
  globalThis.chrome = browser; globalThis.WebSocket = Socket
  globalThis.setInterval = () => 1; globalThis.clearInterval = () => {}
  const cleanup = async () => {
    for (const socket of sockets) if (socket.readyState === 1) socket.close()
    await tick(); setSink(null); console.log = originalLog
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[name]
      else globalThis[name] = value
    }
  }
  try { await import(`../service-worker.js?socialite-test=${++imports}`); sockets[0].listeners.open() } catch (error) { await cleanup(); throw error }
  return { browser, sockets, commands, attaches, detaches, output, held, objects, bodies, cleanup, queries: () => queries,
    presence: value => { presence = value }, url: value => { url = value },
    release: () => { const item = held.shift(); item.socket.receive(item.reply) },
    replace: () => { browser.alarms.onAlarm.emit({ name: 'keepalive' }); const socket = sockets.at(-1); socket.listeners.open(); return socket }
  }
}
const call = (socket, callId, args, slug = 'fixture-seat', f = 'socialite') => socket.receive({ what: 'tool', why: 'run', f, call_id: callId, slug, ...args })
const reply = (socket, callId) => socket.frames.find(f => f.what === 'tool' && f.call_id === callId)
const result = (socket, callId) => JSON.parse(reply(socket, callId).output)
async function invoke (socket, callId, args, slug, f) { call(socket, callId, args, slug, f); await until(() => reply(socket, callId)); return result(socket, callId) }
function complete (f, id, url = BOOKMARKS, mimeType = 'application/json', source = { tabId: 7 }) {
  f.browser.debugger.onEvent.emit(source, 'Network.responseReceived', { requestId: id, timestamp: 10,
    response: { url, mimeType, status: 200, fromDiskCache: true, headers: { secret: 'PRIVATE_HEADER' } } })
  f.browser.debugger.onEvent.emit(source, 'Network.loadingFinished', { requestId: id, timestamp: 11, encodedDataLength: 0 })
}
function quiet (f) {
  const logs = JSON.stringify(f.sockets.flatMap(s => s.frames.filter(p => p.what === 'log'))) + JSON.stringify(f.output)
  for (const secret of ['PRIVATE_BODY_TEXT', 'PRIVATE_QUERY', 'PRIVATE_HEADER', 'PRIVATE_CDP_ERROR', 'PRIVATE_PEER_ERROR', 'PRIVATE_CLOSE_ERROR', 'PRIVATE_IMAGE_BYTES']) assert.equal(logs.includes(secret), false, `${secret} escaped into logging`)
}

test('actual Socialite dispatch probes before acquisition and excludes Firehose in both directions', async () => {
  const enable = deferred(); let holdEnable = true; let holdProbe = false
  const f = await worker({ hold: p => holdProbe && p.why === 'probe', command: method => method === 'Network.enable' && holdEnable ? enable.promise : undefined })
  const socket = f.sockets[0]
  try {
    const registration = socket.frames.find(p => p.what === 'socket' && p.why === 'connect')
    assert.equal(registration.tools.length, 9); assert.ok(registration.tools.some(t => t.f === 'socialite'))
    assert.equal((await invoke(socket, 'no-tab', { action: 'start' })).error, 'explicit_tab_required')
    f.url('https://example.test/')
    assert.equal((await invoke(socket, 'wrong-tab', { action: 'start', tabId: 7 })).error, 'explicit_x_tab_required')
    f.url('https://x.com/i/bookmarks')
    let probe = 0
    for (const why of ['missing_companion', 'ambiguous_companion', 'PRIVATE_PEER_ERROR']) {
      f.presence(why)
      assert.equal((await invoke(socket, `probe-${++probe}`, { action: 'start', tabId: 7 })).error, why.startsWith('PRIVATE') ? 'peer_refused' : why)
    }
    assert.equal(f.attaches.length, 0); assert.equal(f.commands.length, 0); assert.equal(f.queries(), 0)
    f.presence('available'); holdProbe = true
    call(socket, 'start', { action: 'start', tabId: 7 }, 'original-seat'); await until(() => f.held.length)
    await invoke(socket, 'blocked-firehose', { action: 'start', tabId: 7 }, 'other-seat', 'firehose')
    assert.equal(reply(socket, 'blocked-firehose').exit_code, 1)
    holdProbe = false; f.release(); await until(() => f.commands.some(c => c.method === 'Network.enable'))
    complete(f, 'before-enable')
    assert.equal(f.commands.some(c => c.method === 'Network.getResponseBody'), false)
    enable.resolve(); holdEnable = false; await until(() => reply(socket, 'start'))
    assert.equal(result(socket, 'start').state, 'collecting')
    const trace = socket.frames.find(p => p.what === 'log' && p.with?.what === 'respond' && p.with.with.call_id === 'start')
    assert.equal(trace.with.with.slug, 'original-seat')
    await invoke(socket, 'jpeg', { tabId: 7 }, 'screenshot-seat', 'screenshot')
    assert.equal(result(socket, 'jpeg')[1].data, 'JPEG_SENTINEL'); assert.equal(f.attaches.length, 1)
    await invoke(socket, 'stop', { action: 'stop' }); await tick()
    assert.equal(f.detaches.length, 0)
    await invoke(socket, 'firehose', { action: 'start', tabId: 7 }, undefined, 'firehose')
    assert.equal((await invoke(socket, 'blocked-socialite', { action: 'start', tabId: 7 })).error, 'firehose_busy')
    await invoke(socket, 'stop-firehose', { action: 'stop' }, undefined, 'firehose')
    quiet(f)
  } finally { enable.resolve(); await f.cleanup() }
})

test('actual worker retains independent cargo through stop, recovers receipts and preserves tombstones', async () => {
  const f = await worker({ hold: p => p.why === 'finish' }); const first = f.sockets[0]
  try {
    await invoke(first, 'start', { action: 'start', tabId: 7 })
    f.bodies.set('parent', { body: body([tweet()]), base64Encoded: false })
    complete(f, 'child', BOOKMARKS, 'application/json', { tabId: 7, sessionId: 'child' })
    complete(f, 'other-tab', BOOKMARKS, 'application/json', { tabId: 8 })
    complete(f, 'parent'); await until(() => f.held.length === 1)
    f.bodies.set('image', { body: Buffer.from('PRIVATE_IMAGE_BYTES').toString('base64'), base64Encoded: true })
    complete(f, 'image', actual('one'), 'image/jpeg'); await until(() => f.held.length === 2)
    f.bodies.set('waiting', { body: '{}', base64Encoded: false }); complete(f, 'waiting')
    const status = await invoke(first, 'status', { action: 'status' })
    assert.equal(status.ingress.operations.length, 2); assert.equal(status.waiting.response.descriptors, 1)
    assert.equal(f.commands.filter(c => c.method === 'Network.getResponseBody').length, 2)
    assert.equal(JSON.stringify(status).includes('PRIVATE'), false)
    const response = status.ingress.operations.find(op => op.kind === 'response')
    const image = status.ingress.operations.find(op => op.kind === 'image')
    const stopped = await invoke(first, 'stop', { action: 'stop' }); assert.equal(stopped.ingress.operations.length, 2)
    complete(f, 'after-stop'); await tick()
    assert.equal((await invoke(first, 'blocked', { action: 'start', tabId: 7 })).error, 'unresolved_operations')
    const abandoned = await invoke(first, 'abandon', { action: 'abandon', operation_id: image.operation_id })
    assert.equal(abandoned.state, 'abandoned'); assert.equal(abandoned.reason, 'remote_acceptance_unknown')
    first.close(); const second = f.replace()
    const receipt = await invoke(second, 'lookup-response', { action: 'lookup', operation_id: response.operation_id })
    assert.equal(receipt.outcome, 'stored')
    const lookup = second.frames.find(p => p.what === 'companion_ingress' && p.why === 'lookup')
    const begin = first.frames.find(p => p.what === 'companion_ingress' && p.why === 'begin' && p.operation_id === response.operation_id)
    assert.notEqual(lookup.attempt_id, begin.attempt_id); assert.deepEqual(lookup.manifest, begin.manifest)
    assert.equal(second.frames.some(p => p.what === 'companion_ingress' && ['begin', 'chunk', 'finish'].includes(p.why)), false)
    const rearmed = await invoke(second, 'rearm', { action: 'start', tabId: 7 })
    assert.equal(rearmed.ingress.tombstones.length, 1)
    while (f.held.length) f.release()
    first.listeners.close({ code: 1000 })
    call(first, 'obsolete-stop', { action: 'stop' })
    const active = await invoke(second, 'active', { action: 'status' })
    assert.equal(active.state, 'collecting'); assert.equal(active.ingress.tombstones.length, 1)
    assert.equal(reply(first, 'obsolete-stop'), undefined); assert.equal(reply(second, 'obsolete-stop'), undefined)
    assert.equal((await invoke(second, 'lookup-image', { action: 'lookup', operation_id: image.operation_id })).outcome, 'stored')
    assert.equal((await invoke(second, 'recovered', { action: 'status' })).ingress.tombstones.length, 0)
    quiet(f)
  } finally { await f.cleanup() }
})

test('actual worker fences cancelled starts and stale native completion across physical sockets', async () => {
  const pendingAttach = deferred(); const oldBody = deferred(); let holdAttach = true
  const f = await worker({ attach: () => holdAttach ? pendingAttach.promise : undefined }); const first = f.sockets[0]
  try {
    call(first, 'old-start', { action: 'start', tabId: 7 }); await until(() => f.attaches.length === 1)
    first.close(); const second = f.replace(); pendingAttach.resolve(); holdAttach = false; await tick()
    assert.equal(reply(first, 'old-start'), undefined); assert.equal(reply(second, 'old-start'), undefined)
    assert.equal(f.commands.some(c => c.method === 'Network.enable'), false)
    await invoke(second, 'start', { action: 'start', tabId: 7 })
    f.bodies.set('old-body', oldBody.promise); complete(f, 'old-body')
    second.close(); const third = f.replace(); await tick()
    const fresh = await invoke(third, 'fresh', { action: 'start', tabId: 7 })
    assert.equal(fresh.native.response.discardOnSettlement, true)
    f.bodies.set('fresh-body', { body: '{}', base64Encoded: false }); complete(f, 'fresh-body')
    assert.equal(f.commands.filter(c => c.method === 'Network.getResponseBody').length, 1)
    oldBody.reject(Error('PRIVATE_CDP_ERROR'))
    await until(() => f.objects.size === 1)
    const status = await invoke(third, 'settled', { action: 'status' })
    assert.equal(status.counts.stale_body_discarded, 1); assert.equal(status.counts.response_unavailable, 0)
    assert.equal(status.ingress.counts.stored, 1)
    assert.equal(first.frames.some(p => p.what === 'companion_ingress' && p.why === 'begin'), false)
    assert.equal(second.frames.some(p => p.what === 'companion_ingress' && p.why === 'begin'), false)
    quiet(f)
  } finally { pendingAttach.resolve(); oldBody.resolve({ body: '{}', base64Encoded: false }); await f.cleanup() }
})

test('actual navigation, detach and removal listeners close acquisition and keep disable uncertainty visible', async () => {
  let failDisable = false
  const f = await worker({ command: method => { if (method === 'Network.disable' && failDisable) throw Error('PRIVATE_CDP_ERROR') } }); const socket = f.sockets[0]
  try {
    await invoke(socket, 'start', { action: 'start', tabId: 7 })
    f.browser.tabs.onUpdated.emit(7, { url: 'https://x.com/home' })
    assert.equal((await invoke(socket, 'same-origin', { action: 'status' })).state, 'collecting')
    failDisable = true; f.browser.tabs.onUpdated.emit(7, { url: 'https://example.test/' }); await tick()
    const status = await invoke(socket, 'left', { action: 'status' })
    assert.equal(status.reason, 'left_x'); assert.equal(status.network, 'disable_failed')
    assert.equal((await invoke(socket, 'blocked', { action: 'start', tabId: 7 })).error, 'network_owned')
    f.browser.debugger.onDetach.emit({ tabId: 7 }, 'canceled_by_user'); failDisable = false
    await invoke(socket, 'restart', { action: 'start', tabId: 7 }); assert.equal(f.attaches.length, 2)
    f.browser.tabs.onRemoved.emit(7)
    assert.equal((await invoke(socket, 'removed', { action: 'status' })).reason, 'tab_removed')
    assert.equal(f.detaches.length, 0)
    quiet(f)
  } finally { await f.cleanup() }
})
