import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { IngressProducer } from '../companion-ingress.js'
import { Socialite } from '../socialite.js'
import { body, tweet, descriptor, BOOKMARKS } from '../test/socialite-fixture.js'
import { png } from '../test/fixture.js'

const root = fileURLToPath(new URL('..', import.meta.url))
async function until (check) {
  for (let n = 0; n < 300; n++) { const value = await check(); if (value) return value; await delay(10) }
  throw Error('disposable Socialite integration deadline elapsed')
}

test('actual helper/producer/router/companion preserve complete bytes and recover a lost receipt', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shotgun-socialite-'))
  const children = []; const sockets = []; const errors = []; const frames = []
  let app; let current; let heldAck; let droppedStored; let imageId
  function start (binary, args, extra = {}) {
    const child = spawn(binary, args, { env: { ...process.env, ...extra }, stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr.on('data', data => errors.push(data.toString()))
    children.push(child); return child
  }
  const ingress = new IngressProducer({ send: (socket, packet) => {
    if (socket !== current || socket.readyState !== WebSocket.OPEN) return false
    frames.push(structuredClone(packet))
    if (packet.why === 'begin' && packet.manifest.kind === 'image') imageId = packet.operation_id
    socket.send(JSON.stringify(packet)); return true
  } })
  try {
    const listener = createServer()
    listener.listen(0, '127.0.0.1'); await once(listener, 'listening')
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve))
    const url = `ws://127.0.0.1:${port}/`; const logsPath = join(directory, 'logs', `easement-${port}.jsonl`)
    const bus = start(process.env.EASEMENT_TEST_BIN || resolve(root, '../easement/target/debug/easement'), [], {
      EASEMENT_PORT: String(port), EASEMENT_LOG_DIR: join(directory, 'logs')
    })
    async function peers (who, count) {
      await until(async () => {
        if (bus.exitCode !== null) throw Error('disposable Easement exited')
        try { return (await (await fetch(`${url.replace('ws:', 'http:')}status`)).json()).sockets.filter(p => p.who === who).length === count } catch { return false }
      })
    }
    await peers('shotgun', 0)
    async function connect () {
      const socket = new WebSocket(url); sockets.push(socket); current = socket
      socket.addEventListener('close', () => { ingress.disconnect(socket); app?.disconnect(socket) })
      socket.addEventListener('message', event => {
        const packet = JSON.parse(event.data)
        if (packet.what !== 'companion_ingress') return
        if (packet.operation_id === imageId && packet.why === 'ack' && !heldAck) { heldAck = { packet, socket }; return }
        if (packet.operation_id === imageId && packet.why === 'stored' && !droppedStored) { droppedStored = packet; return }
        ingress.receive(packet, socket)
      })
      await once(socket, 'open')
      socket.send(JSON.stringify({ what: 'socket', why: 'connect', who: 'shotgun', where: 'localhost', tools: [] }))
      await peers('shotgun', 1); return socket
    }
    let socket = await connect()
    await assert.rejects(ingress.probe(socket), /missing_companion/)
    start(process.env.SOCIALITE_TEST_BIN || resolve(root, '../socialite/target/debug/socialite'), ['--store', join(directory, 'store'), '--url', url])
    await peers('socialite', 1)
    const bodies = new Map()
    app = new Socialite({ ingress, socket: () => current, firehoseBusy: () => false,
      attach: async () => {}, getTab: async () => ({ url: 'https://x.com/i/bookmarks?SYNTHETIC_PRIVATE_URL' }),
      command: async (tab, method, params) => method === 'Network.getResponseBody' ? bodies.get(params.requestId) : undefined })
    await app.start({ tabId: 7 }, socket)
    function complete (id, url = BOOKMARKS, mimeType = 'application/json') {
      app.onEvent(7, 'Network.responseReceived', { requestId: id, response: { url, mimeType, status: 200, fromDiskCache: true } })
      app.onEvent(7, 'Network.loadingFinished', { requestId: id, encodedDataLength: 0 })
    }
    const value = JSON.parse(body([tweet('1', [{ type: 'photo', media_url_https: descriptor('specimen') }])]))
    value.synthetic = 'SYNTHETIC_PRIVATE_BODY'
    const text = JSON.stringify(value).padEnd(177277, ' ')
    bodies.set('parent', { body: text, base64Encoded: false }); complete('parent')
    await until(() => app.status().eligibilityReferences === 1)
    const image = png(1, 1, 606762 - png().length)
    assert.equal(image.length, 606762)
    bodies.set('image', { body: image.toString('base64'), base64Encoded: true })
    complete('image', 'https://pbs.twimg.com/media/specimen?format=png&name=900x900', 'image/png')
    await until(() => heldAck && ingress.counts.stored === 1)
    bodies.set('second', { body: '{}', base64Encoded: false }); complete('second')
    await until(() => ingress.counts.stored === 2)
    assert.equal(ingress.operations.get(imageId).state, 'transferring')
    ingress.receive(heldAck.packet, heldAck.socket)
    await until(() => droppedStored)
    assert.equal(ingress.operations.get(imageId).state, 'finishing')
    const begins = frames.filter(p => p.why === 'begin')
    for (const begin of begins) {
      const expected = begin.operation_id === imageId ? image : begin.manifest.bytes === 177277 ? Buffer.from(text) : Buffer.from('{}')
      assert.deepEqual(await readFile(join(directory, 'store/objects', begin.manifest.sha256)), expected)
      const receipt = JSON.parse(await readFile(join(directory, 'store/receipts', `${begin.operation_id}.json`)))
      assert.deepEqual(receipt.manifest, begin.manifest)
    }
    assert.equal(frames.filter(p => p.why === 'chunk' && p.operation_id === imageId).length, 10)
    assert.equal(frames.filter(p => p.why === 'chunk' && p.operation_id === begins.find(p => p.manifest.bytes === 177277).operation_id).length, 3)
    app.stop(); socket.close(); await once(socket, 'close'); await peers('shotgun', 0)
    socket = await connect()
    await assert.rejects(app.start({ tabId: 7 }, socket), /unresolved_operations/)
    assert.equal(ingress.abandon(imageId).state, 'abandoned')
    assert.equal((await ingress.lookup(imageId, socket)).outcome, 'stored')
    assert.equal(ingress.tombstones.size, 0); assert.equal(ingress.status().retainedBytes, 0)
    assert.equal(frames.filter(p => p.why === 'begin').length, 3, 'replacement and lookup must not retransmit')
    const logs = await readFile(logsPath, 'utf8')
    for (const secret of ['SYNTHETIC_PRIVATE_BODY', 'SYNTHETIC_PRIVATE_URL', 'PRIVATE_BODY_TEXT', image.toString('base64').slice(0, 1000)]) {
      assert.equal(logs.includes(secret), false); assert.equal(errors.join('').includes(secret), false)
    }
  } finally {
    app?.stop()
    for (const socket of sockets) { ingress.disconnect(socket); socket.close() }
    for (const child of children.reverse()) if (child.exitCode === null) { child.kill(); await once(child, 'exit') }
    await rm(directory, { recursive: true, force: true })
  }
})
