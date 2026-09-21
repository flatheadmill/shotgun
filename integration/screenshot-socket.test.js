import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { ScreenshotSaver, decodePng } from '../screenshot-save.js'
import { png } from '../test/fixture.js'

const root = fileURLToPath(new URL('..', import.meta.url))
async function port () {
  const listener = createServer()
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening')
  const number = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  return number
}
async function until (check) {
  for (let n = 0; n < 200; n++) { const result = await check(); if (result) return result; await delay(20) }
  throw new Error('local integration deadline elapsed')
}

test('actual producer/router/writer store identical PNG bytes, recover status and refuse clobber', { timeout: 20000 }, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'shotgun-socket-')))
  const number = await port()
  const url = `ws://127.0.0.1:${number}`
  await mkdir(join(home, 'pane/easement'), { recursive: true })
  const children = []; const sockets = []; const errors = []
  function start (binary, args = [], extra = {}) {
    // HOME is supplied only to disposable child processes. Never change this
    // process's HOME or point a test at the operator's journals.
    const child = spawn(binary, args, { env: { ...process.env, HOME: home, ...extra }, stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr.on('data', data => errors.push(data.toString()))
    children.push(child)
    return child
  }
  const bus = start(process.env.EASEMENT_TEST_BIN || resolve(root, '../easement/target/debug/easement'), [], { EASEMENT_PORT: String(number) })
  async function logs () { return readFile(join(home, `.local/state/easement/easement-${number}.jsonl`), 'utf8').catch(() => '') }
  let captured = 0
  const bytes = png(1, 1, 70000)
  const capture = async () => ({ ...await decodePng(bytes.toString('base64')), tabId: 7, source_url: 'https://example.test/', captured_at: '2026-09-20T20:00:00.000Z' })
  const requests = []
  async function producer () {
    const socket = new WebSocket(url); sockets.push(socket)
    const saver = new ScreenshotSaver({
      send: (channel, packet) => { requests.push(packet.why); if (channel.readyState !== WebSocket.OPEN) return false; channel.send(JSON.stringify(packet)); return true },
      capture: async () => { captured++; return capture() }
    })
    socket.addEventListener('close', () => saver.disconnect(socket))
    socket.addEventListener('message', async event => {
      const msg = JSON.parse(event.data)
      if (msg.what === 'screenshot_save') saver.receive(msg, socket)
      else if (msg.what === 'tool' && msg.why === 'run') {
        const outcome = await saver.run(msg, socket)
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ what: 'tool', why: 'response', call_id: msg.call_id, output: JSON.stringify(outcome), exit_code: outcome.why === 'stored' ? 0 : 1 }))
      }
    })
    await once(socket, 'open')
    socket.send(JSON.stringify({ what: 'socket', why: 'connect', who: 'shotgun', where: 'localhost', tools: [{ f: 'screenshot_save', description: 'integration fixture' }] }))
    return socket
  }
  async function call (args) {
    const response = await fetch(`http://127.0.0.1:${number}/mcp/easement/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'call', arguments: { who: 'shotgun', f: 'screenshot_save', args } } })
    })
    const value = await response.json()
    const content = value.result?.content?.find(c => c.type === 'text')?.text
    assert.ok(content, JSON.stringify(value))
    return JSON.parse(content.replace(/\n\[exit code: -?\d+\]$/, ''))
  }
  try {
    await until(async () => {
      if (bus.exitCode !== null) throw Error(errors.join(''))
      return fetch(`http://127.0.0.1:${number}/`).then(() => true).catch(() => false)
    })
    start(process.env.WICKET_TEST_BIN || resolve(root, '../wicket/target/debug/wicket'), [url, 'localhost'])
    let socket = await producer()
    await until(async () => (await logs()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(r => r.what?.who === 'websocket' && r.what?.what === 'connect' && r.what?.with?.tools).length >= 2)
    const destination = join(home, 'pane/easement/capture.png')
    const args = { action: 'capture', operation_id: 'fixture-save', destination, mode: 'viewport' }
    const stored = await call(args)
    assert.equal(stored.why, 'stored', JSON.stringify(stored))
    assert.deepEqual(await readFile(destination), bytes)
    assert.equal(stored.receipt.verified.sha256, (await capture()).sha256)
    assert.deepEqual(requests, ['status', 'begin', 'chunk', 'chunk', 'finish'])
    assert.equal(captured, 1)
    const failed = await call({ ...args, operation_id: 'existing-destination' })
    assert.equal(failed.why, 'failed', JSON.stringify(failed))
    assert.deepEqual(await readFile(destination), bytes)
    const status = await call({ action: 'status', operation_id: 'fixture-save' })
    assert.deepEqual(status.receipt, stored.receipt)
    assert.equal((await call({ action: 'status', operation_id: 'never-used' })).why, 'unknown')
    assert.equal((await call({ action: 'retry', operation_id: 'lost-worker-bytes' })).why, 'unknown')
    const beforeRestart = captured
    socket.close(); await once(socket, 'close'); socket = await producer()
    await delay(50)
    const restarted = await call({ action: 'retry', operation_id: 'fixture-save' })
    assert.deepEqual(restarted.receipt, stored.receipt)
    assert.equal(captured, beforeRestart)
    const records = (await logs()).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(records.filter(r => r.what?.what === 'store').length, 1)
    assert.equal((await logs()).includes(bytes.toString('base64').slice(0, 1000)), false)
  } finally {
    for (const socket of sockets) socket.close()
    for (const child of children.reverse()) {
      if (child.exitCode === null) { child.kill(); await once(child, 'exit') }
    }
    await rm(home, { recursive: true, force: true })
  }
})
