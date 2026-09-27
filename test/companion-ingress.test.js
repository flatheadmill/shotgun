import test from 'node:test'
import assert from 'node:assert/strict'
import { LIMITS, IngressProducer } from '../companion-ingress.js'
import { peer, operation, until, tick } from './socialite-fixture.js'

test('probe is route-free and refuses missing or ambiguous companions', async () => {
  const p = peer()
  try {
    assert.equal(await p.ingress.probe(p.socket), true)
    assert.deepEqual(Object.keys(p.frames[0]).sort(), ['attempt_id', 'operation_id', 'what', 'why'])
    for (const reason of ['missing_companion', 'ambiguous_companion']) { p.presence(reason); await assert.rejects(p.ingress.probe(p.socket), new RegExp(reason)) }
    assert.equal(p.ingress.operations.size, 0)
  } finally { await p.close() }
})

test('exact credit preserves complete bytes and an empty input goes directly to finish', async () => {
  const p = peer({ hold: packet => packet.why === 'chunk' })
  try {
    const op = await operation('response', new Uint8Array(150000).fill(71))
    p.ingress.retain(op, p.socket); await until(() => p.held.length)
    assert.deepEqual(p.frames.map(f => f.why), ['begin', 'chunk'])
    for (let n = 0; n < 3; n++) { p.release(); if (n < 2) await until(() => p.held.length) }
    await until(() => !p.ingress.unresolved)
    assert.deepEqual(p.objects.get(op.operation_id).bytes, op.bytes)
    assert.deepEqual(p.objects.get(op.operation_id).receipt.manifest, op.manifest)
    const empty = await operation('response', new Uint8Array())
    p.ingress.retain(empty, p.socket); await until(() => !p.ingress.unresolved)
    assert.deepEqual(p.frames.filter(f => f.operation_id === empty.operation_id).map(f => f.why), ['begin', 'finish'])
  } finally { await p.close() }
})

test('held image credit does not block response or control exchanges', async () => {
  const image = await operation('image', new Uint8Array(100000))
  const p = peer({ hold: packet => packet.operation_id === image.operation_id && packet.why === 'chunk' })
  try {
    p.ingress.retain(image, p.socket); await until(() => p.held.length)
    const response = await operation(); p.ingress.retain(response, p.socket)
    await until(() => p.objects.has(response.operation_id))
    assert.equal(await p.ingress.probe(p.socket), true)
    assert.equal((await p.ingress.lookup(image.operation_id, p.socket)).outcome, 'unknown')
    assert.equal(p.frames.filter(f => f.operation_id === image.operation_id && f.why === 'chunk').length, 1)
    assert.equal(p.ingress.operations.get(image.operation_id).bytes.length, image.bytes.length)
  } finally { await p.close() }
})

test('lost final reply retains bytes and fresh lookup on a replacement socket resolves it', async () => {
  const p = peer({ hold: packet => packet.why === 'finish' })
  try {
    const op = await operation(); p.ingress.retain(op, p.socket); await until(() => p.held.length)
    p.ingress.disconnect(p.socket); await tick()
    assert.equal(p.ingress.operations.get(op.operation_id).state, 'unconfirmed')
    const socket = p.replace(); const before = p.frames.length
    await tick(); assert.equal(p.frames.length, before)
    assert.equal(p.ingress.receive(p.held[0].reply, socket), false)
    assert.equal((await p.ingress.lookup(op.operation_id, socket)).outcome, 'stored')
    assert.equal(p.ingress.unresolved, false)
    assert.equal(p.frames.filter(f => f.why === 'begin').length, 1)
  } finally { await p.close() }
})

test('abandon releases cargo but retains the full immutable manifest for lookup', async () => {
  const p = peer({ hold: packet => packet.why === 'finish' })
  try {
    const op = await operation(); p.ingress.retain(op, p.socket); await until(() => p.held.length)
    const state = p.ingress.abandon(op.operation_id)
    assert.equal(state.reason, 'remote_acceptance_unknown'); assert.equal(p.ingress.status().retainedBytes, 0)
    assert.deepEqual(p.ingress.tombstones.get(op.operation_id).manifest, op.manifest)
    assert.throws(() => { p.ingress.tombstones.get(op.operation_id).manifest.provenance.source = 'changed' })
    const summary = JSON.stringify(p.ingress.status()); assert.equal(summary.includes('PRIVATE_PROVENANCE'), false)
    assert.equal((await p.ingress.lookup(op.operation_id, p.socket)).outcome, 'stored')
    assert.equal(p.ingress.tombstones.size, 0)
  } finally { await p.close() }
})

test('wrong sockets, changed receipts and incorrect ack offsets never grant authority', async () => {
  for (const phase of ['begin', 'chunk', 'finish']) {
    const p = peer({ hold: packet => packet.why === phase })
    try {
      const op = await operation(); p.ingress.retain(op, p.socket); await until(() => p.held.length)
      const h = p.held[0]
      assert.equal(p.ingress.receive(h.reply, {}), false)
      if (phase === 'begin') h.reply.binding.source = -1
      if (phase === 'chunk') h.reply.offset++
      if (phase === 'finish') h.reply.receipt.manifest = { ...h.reply.receipt.manifest, provenance: { replaced: true } }
      p.release(); await until(() => p.ingress.operations.get(op.operation_id)?.state === 'unconfirmed')
      assert.equal(p.ingress.status().retainedBytes, op.bytes.length)
    } finally { await p.close() }
  }
})

test('unknown and receiving lookup responses grant no offset or retry', async () => {
  const p = peer({ hold: packet => ['begin', 'lookup'].includes(packet.why) })
  try {
    const op = await operation(); p.ingress.retain(op, p.socket); await until(() => p.held.length)
    p.ingress.disconnect(p.socket); await tick(); p.held.length = 0
    for (const why of ['unknown', 'receiving']) {
      const query = p.ingress.lookup(op.operation_id, p.socket); await until(() => p.held.length)
      p.held[0].reply.why = why; p.release()
      assert.equal((await query).outcome, why); assert.equal(p.ingress.unresolved, true)
    }
    assert.equal(p.frames.filter(f => f.why === 'begin').length, 1)
    assert.equal(p.frames.filter(f => f.why === 'chunk').length, 0)
  } finally { await p.close() }
})

test('timeout retains bytes, peer error text is reduced to a fixed code', async () => {
  const p = peer({ hold: packet => packet.why === 'begin', timeout: 10 })
  try {
    const op = await operation(); p.ingress.retain(op, p.socket)
    await until(() => p.ingress.operations.get(op.operation_id)?.state === 'unconfirmed')
    assert.equal(p.ingress.operations.get(op.operation_id).reason, 'reply_timeout')
    p.ingress.abandon(op.operation_id)
    const op2 = await operation(); p.ingress.retain(op2, p.socket); await until(() => p.held.some(h => h.packet.operation_id === op2.operation_id))
    const h = p.held.find(h => h.packet.operation_id === op2.operation_id)
    p.ingress.receive({ what: h.reply.what, operation_id: h.reply.operation_id, attempt_id: h.reply.attempt_id, why: 'rejected', reason: 'PRIVATE_ERROR_TEXT' }, p.socket)
    await until(() => p.ingress.operations.get(op2.operation_id)?.state === 'unconfirmed')
    assert.equal(p.ingress.operations.get(op2.operation_id).reason, 'peer_refused')
    assert.equal(JSON.stringify(p.ingress.status()).includes('PRIVATE_ERROR_TEXT'), false)
  } finally { await p.close() }
})

test('operation, control and tombstone pressure never silently discards evidence', async () => {
  const p = peer({ hold: () => true })
  try {
    for (let n = 0; n < LIMITS.tombstones; n++) { const op = await operation(); p.ingress.retain(op, p.socket); p.ingress.abandon(op.operation_id) }
    const op = await operation(); p.ingress.retain(op, p.socket)
    assert.throws(() => p.ingress.abandon(op.operation_id), /tombstone_capacity/)
    assert.equal(p.ingress.operations.get(op.operation_id).bytes.length, op.bytes.length)
    assert.throws(() => p.ingress.retain({ ...op, operation_id: crypto.randomUUID() }, p.socket), /capacity/)
    const queries = [p.ingress.probe(p.socket), p.ingress.probe(p.socket)]
    const settled = Promise.allSettled(queries)
    await assert.rejects(p.ingress.probe(p.socket), /control_capacity/)
    p.ingress.disconnect(p.socket); await settled
    assert.equal(p.ingress.status().tombstones.length, LIMITS.tombstones)
  } finally { await p.close() }
})
