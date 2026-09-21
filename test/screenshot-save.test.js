import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { png, call, reply, tick } from './fixture.js'
import { LIMITS, decodePng, encodeChunk, capturePlan, resolveSaveTab, validateReceipt, ScreenshotSaver } from '../screenshot-save.js'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const captured = async (bytes = png()) => ({
  ...await decodePng(bytes.toString('base64')), tabId: 7,
  source_url: 'https://example.test/', captured_at: '2026-09-20T20:00:00.000Z'
})
function receipt (op, intent, fields = {}) {
  return {
    operation: { slug: op.slug, caller: 'shotgun', operation_id: op.operation_id },
    attempt: { call_id: 'original-call', attempt_id: 'original-attempt' },
    event_id: `screenshot-${hash(op.slug + '\0' + op.operation_id)}-terminal`,
    requested: intent, destination: intent.destination,
    verified: { mime_type: 'image/png', bytes: intent.bytes, sha256: intent.sha256, pixel_width: 1, pixel_height: 1 },
    accepted_at: '2026-09-20T20:00:00Z', observed_at: '2026-09-20T20:00:01Z', outcome: 'stored', ...fields
  }
}
function harness (options = {}) {
  const sent = []; const logs = []; const socket = {}; let captures = 0
  const saver = new ScreenshotSaver({
    send: (channel, packet) => { assert.equal(channel, socket); sent.push(packet); return true },
    capture: async args => { captures++; return captured(options.bytes) },
    observe: event => logs.push(event), ...options
  })
  return { saver, sent, logs, socket, captures: () => captures,
    answer: (why, fields = {}, request = sent.at(-1)) => saver.receive(reply(request, why, fields), socket) }
}
async function awaiting (h, why) {
  for (let n = 0; n < 100; n++) { if (h.sent.at(-1)?.why === why) return h.sent.at(-1); await tick() }
  assert.fail(`did not reach ${why}`)
}

// Bytes first: these assertions do not need Chrome or a transport implementation.
test('PNG bytes are unchanged; count, dimensions and SHA-256 describe that buffer', async () => {
  const bytes = png(3, 2)
  const value = await decodePng(bytes.toString('base64'))
  assert.deepEqual(Buffer.from(value.bytes), bytes)
  assert.equal(value.sha256, hash(bytes))
  assert.equal(value.pixel_width, 3); assert.equal(value.pixel_height, 2)
})
test('reject malformed, trailing, corrupted, animated and oversized PNG without quoting data', async () => {
  const bytes = png(); const corrupt = Buffer.from(bytes); corrupt[30] ^= 1
  for (const input of ['RAW_SCREENSHOT_SENTINEL', '!!!!', bytes.subarray(0, 20).toString('base64'),
    Buffer.concat([bytes, Buffer.from('secret')]).toString('base64'), corrupt.toString('base64'),
    png(1, 1, LIMITS.pngBytes).toString('base64'), png(1, 1, 0, { animated: true }).toString('base64')]) {
    await assert.rejects(decodePng(input), e => !e.message.includes('RAW_SCREENSHOT_SENTINEL'))
  }
  for (const shape of [{ width: LIMITS.dimension + 1 }, { width: 8192, height: 8192 }, { width: 0 }]) {
    await assert.rejects(decodePng(png(1, 1, 0, shape).toString('base64')), /dimensions exceed limits/)
  }
})
test('chunk base64 round trips arbitrary bytes at the 64 KiB boundary', () => {
  for (const size of [1, 2, 3, 4095, 65535, 65536]) {
    const bytes = Uint8Array.from({ length: size }, (_, n) => n % 256)
    assert.deepEqual(Buffer.from(encodeChunk(bytes), 'base64'), Buffer.from(bytes))
  }
  assert.throws(() => encodeChunk(new Uint8Array(65537)))
  assert.throws(() => encodeChunk(new Uint8Array(0)))
})
test('capture plans never resize, change quality, scroll or guess a DPR multiplier', () => {
  const metrics = { cssVisualViewport: { clientWidth: 800, clientHeight: 600, zoom: 1 }, cssContentSize: { x: 0, y: 0, width: 800, height: 2400 } }
  assert.deepEqual(capturePlan('viewport', metrics, 2), { format: 'png', fromSurface: true, captureBeyondViewport: false })
  assert.deepEqual(capturePlan('full_page', metrics, 2), { format: 'png', fromSurface: true, captureBeyondViewport: true, clip: { x: 0, y: 0, width: 800, height: 2400, scale: 1 } })
  assert.throws(() => capturePlan('full_page', { ...metrics, cssContentSize: { width: 32768, height: 32768 } }, 2))
})
test('50% browser zoom on Retina fills the full-page canvas at effective DPR 1', () => {
  // Recorded Chrome 153 fixture: CSS content 2946x2552, browser zoom .5,
  // physical display density 2. CDP clip dimensions are DIPs, not CSS pixels.
  // The old plan requested 2946x2552 DIPs, producing the observed 5892x5104
  // canvas with the 2946x2552 page occupying only its upper-left quarter.
  const metrics = {
    cssVisualViewport: { clientWidth: 2946, clientHeight: 1894, scale: 1, zoom: 0.5 },
    cssContentSize: { x: 0, y: 0, width: 2946, height: 2552 }
  }
  const { clip } = capturePlan('full_page', metrics, 1)
  const canvas = { width: Math.round(clip.width * 2 * clip.scale), height: Math.round(clip.height * 2 * clip.scale) }
  assert.deepEqual(canvas, { width: 2946, height: 2552 })
  assert.equal((2946 * 2552) / (canvas.width * canvas.height), 1)
  assert.equal(clip.scale, 1)
  assert.deepEqual(capturePlan('viewport', metrics, 1), { format: 'png', fromSurface: true, captureBeyondViewport: false })
})
test('full-page coordinates use measured browser zoom independently of density and pinch scale', () => {
  const metrics = {
    cssVisualViewport: { clientWidth: 800, clientHeight: 600, scale: 1, zoom: 1.25 },
    cssContentSize: { x: 1.5, y: -2.5, width: 800.5, height: 2400.5 }
  }
  const expected = { x: 1.875, y: -3.125, width: 1000.625, height: 3000.625, scale: 1 }
  for (const dpr of [1.25, 2.5]) {
    for (const scale of [1, 2]) {
      assert.deepEqual(capturePlan('full_page', { ...metrics, cssVisualViewport: { ...metrics.cssVisualViewport, scale } }, dpr).clip, expected)
    }
  }
})
test('full-page capture refuses missing or invalid browser zoom rather than guessing from DPR', () => {
  for (const zoom of [undefined, null, 0, -1, NaN, Infinity, '0.5']) {
    const metrics = { cssVisualViewport: { clientWidth: 800, clientHeight: 600, zoom }, cssContentSize: { x: 0, y: 0, width: 800, height: 2400 } }
    assert.throws(() => capturePlan('full_page', metrics, 1), /zoom/)
    assert.deepEqual(capturePlan('viewport', metrics, 1), { format: 'png', fromSurface: true, captureBeyondViewport: false })
  }
})
test('overlapping tab resolution keeps the supplied slug and explicit tab', async () => {
  const resolvers = new Map()
  const context = slug => new Promise(resolve => resolvers.set(slug, resolve))
  const active = async () => [{ id: 99 }]
  const first = resolveSaveTab(undefined, 'first', context, active)
  const second = resolveSaveTab(undefined, 'second', context, active)
  resolvers.get('second')({ currentTabId: 22 }); resolvers.get('first')({ currentTabId: 11 })
  assert.deepEqual(await Promise.all([first, second]), [11, 22])
  assert.equal(await resolveSaveTab(7, 'first', context, active), 7)
  assert.equal(await resolveSaveTab(undefined, 'missing', async () => ({}), active), 99)
})
test('strict receipts allow historical call IDs and canonical parent paths but reject forged facts', async () => {
  const c = await captured(); const op = call()
  const intent = { destination: op.destination, bytes: c.bytes.length, sha256: c.sha256, mode: op.mode, source_url: c.source_url, captured_at: c.captured_at }
  const good = receipt(op, intent)
  await validateReceipt(good, 'stored', op, { ...c, intent })
  await validateReceipt({ ...good, destination: '/canonical/capture.png' }, 'stored', op, { ...c, intent })
  for (const changed of [
    { operation: { ...good.operation, slug: 'another' } }, { event_id: 'forged' },
    { requested: { ...intent, destination: '/safe/other.png' } }, { destination: '/safe/other.png' },
    { verified: { ...good.verified, sha256: '0'.repeat(64) } }, { verified: { ...good.verified, pixel_width: 2 } },
    { accepted_at: null }, { outcome: 'aborted' }, { data: 'RAW_SCREENSHOT_SENTINEL' }
  ]) await assert.rejects(validateReceipt({ ...good, ...changed }, 'stored', op, { ...c, intent }))
})
test('required identity/action and absolute destination are validated before capture', async () => {
  for (const args of [{ action: undefined }, { operation_id: undefined }, { operation_id: '../escape' },
    { destination: 'relative.png' }, { destination: '/safe/../other.png' }, { where: 'remote' }]) {
    const h = harness(); const result = await h.saver.run(call(args), h.socket)
    assert.equal(result.why, 'rejected'); assert.equal(h.captures(), 0); assert.equal(h.sent.length, 0)
  }
})
test('status is first; each chunk waits for its exact ack; finish carries the unchanged manifest', async () => {
  const bytes = png(1, 1, 70000); const h = harness({ bytes })
  const done = h.saver.run(call(), h.socket)
  await awaiting(h, 'status'); assert.equal(h.captures(), 0); h.answer('unknown')
  const begin = await awaiting(h, 'begin'); assert.equal(h.captures(), 1)
  assert.equal(begin.intent.sha256, hash(bytes)); assert.equal(begin.intent.bytes, bytes.length)
  h.answer('ready', { next_offset: 0 })
  await awaiting(h, 'chunk'); await tick(); assert.equal(h.sent.filter(p => p.why === 'chunk').length, 1)
  const chunks = []
  while (h.sent.at(-1).why !== 'finish') {
    const packet = h.sent.at(-1); const decoded = Buffer.from(packet.data, 'base64'); chunks.push(decoded)
    assert.equal(packet.offset, Buffer.concat(chunks).length - decoded.length)
    assert.ok(decoded.length <= 65536)
    h.answer('ack', { next_offset: packet.offset + decoded.length }); await tick()
  }
  assert.deepEqual(Buffer.concat(chunks), bytes)
  const result = reply(h.sent.at(-1), 'stored', { receipt: receipt(call(), begin.intent) })
  h.saver.receive(result, h.socket)
  assert.deepEqual(await done, result); assert.equal(h.saver.retainedBytes, 0)
  assert.ok(!JSON.stringify(h.logs).includes(bytes.toString('base64')))
  assert.ok(!h.logs.some(e => e.what === 'store'))
})
test('status and memoryless retry never recapture unknown or receiving operations', async () => {
  for (const action of ['status', 'retry']) for (const why of ['unknown', 'receiving']) {
    const h = harness(); const done = h.saver.run(call({ action }), h.socket)
    const request = await awaiting(h, 'status'); const result = reply(request, why, why === 'receiving' ? { next_offset: 12 } : {})
    h.saver.receive(result, h.socket)
    assert.deepEqual(await done, result); assert.equal(h.captures(), 0); assert.equal(h.sent.length, 1)
  }
})
test('existing terminal status returns the original receipt for every action, without capture', async () => {
  const c = await captured(); const op = call()
  const intent = { destination: op.destination, bytes: c.bytes.length, sha256: c.sha256, mode: op.mode, source_url: c.source_url, captured_at: c.captured_at }
  for (const action of ['capture', 'retry', 'status']) {
    const h = harness(); const done = h.saver.run(call({ action }), h.socket)
    await awaiting(h, 'status'); h.answer('stored', { receipt: receipt(op, intent) })
    assert.equal((await done).why, 'stored'); assert.equal(h.captures(), 0)
  }
})
test('disconnect preserves same-worker bytes and retry uses a new attempt starting from status', async () => {
  const h = harness(); const done = h.saver.run(call(), h.socket)
  await awaiting(h, 'status'); h.answer('unknown'); await awaiting(h, 'begin')
  const oldAttempt = h.sent.at(-1).attempt_id
  h.saver.disconnect(h.socket)
  assert.equal((await done).why, 'unresolved'); assert.ok(h.saver.retainedBytes > 0)
  const retry = h.saver.run(call({ action: 'retry', call_id: 'call-2' }), h.socket)
  await awaiting(h, 'status'); assert.notEqual(h.sent.at(-1).attempt_id, oldAttempt); h.answer('receiving', { next_offset: 0 })
  await awaiting(h, 'begin'); assert.equal(h.captures(), 1)
  h.answer('rejected', { reason: 'writer refused' }); assert.equal((await retry).why, 'rejected')
})
test('conflicting intent cannot replace retained bytes', async () => {
  const h = harness(); const done = h.saver.run(call(), h.socket)
  await awaiting(h, 'status'); h.answer('unknown'); await awaiting(h, 'begin'); h.saver.disconnect(h.socket); await done
  const second = h.saver.run(call({ call_id: 'call-2', action: 'retry', destination: '/safe/different.png' }), h.socket)
  await awaiting(h, 'status'); h.answer('unknown')
  assert.equal((await second).why, 'rejected'); assert.equal(h.captures(), 1)
})
test('wrong channel, call, operation, attempt, credit or receipt cannot complete a save', async () => {
  const h = harness(); const done = h.saver.run(call(), h.socket)
  const query = await awaiting(h, 'status')
  assert.equal(h.saver.receive(reply(query, 'unknown'), {}), false)
  assert.equal(h.saver.receive({ ...reply(query, 'unknown'), call_id: 'other' }, h.socket), false)
  assert.equal(h.sent.length, 1)
  h.answer('unknown'); await awaiting(h, 'begin'); h.answer('ready', { next_offset: 0 }); await awaiting(h, 'chunk')
  h.answer('ack', { next_offset: 999 })
  assert.equal((await done).why, 'unresolved'); assert.equal(h.sent.some(p => p.why === 'finish'), false)
})
test('late replies and errors never echo screenshot bytes', async () => {
  const h = harness({ capture: async () => { throw Error('RAW_SCREENSHOT_SENTINEL') } })
  const done = h.saver.run(call(), h.socket)
  await awaiting(h, 'status'); h.answer('unknown')
  const result = await done
  assert.equal(result.why, 'rejected')
  assert.equal(JSON.stringify([result, h.logs]).includes('RAW_SCREENSHOT_SENTINEL'), false)
  assert.equal(h.saver.receive(reply(h.sent[0], 'unknown'), h.socket), false)
})

test('a dropped finish reply stays unknown; retry recovers the original stored receipt', async () => {
  const h = harness(); const done = h.saver.run(call(), h.socket)
  await awaiting(h, 'status'); h.answer('unknown'); const begin = await awaiting(h, 'begin')
  h.answer('ready', { next_offset: 0 }); const chunk = await awaiting(h, 'chunk')
  h.answer('ack', { next_offset: chunk.offset + Buffer.from(chunk.data, 'base64').length })
  await awaiting(h, 'finish'); h.saver.disconnect(h.socket)
  assert.equal((await done).why, 'unresolved'); assert.ok(h.saver.retainedBytes > 0)
  const retry = h.saver.run(call({ action: 'retry', call_id: 'call-2' }), h.socket)
  await awaiting(h, 'status'); const original = receipt(call(), begin.intent)
  h.answer('stored', { receipt: original })
  assert.deepEqual((await retry).receipt, original)
  assert.equal(h.captures(), 1); assert.equal(h.saver.retainedBytes, 0)
})
test('failed, aborted and published-unconfirmed are distinct, matching terminal outcomes', async () => {
  const c = await captured(); const op = call()
  const intent = { destination: op.destination, bytes: c.bytes.length, sha256: c.sha256, mode: op.mode, source_url: c.source_url, captured_at: c.captured_at }
  for (const [why, outcome] of [['failed', { failed: { action: 'publish', reason: 'exists' } }], ['aborted', 'aborted'],
    ['published', { published_durability_unconfirmed: { reason: 'directory sync' } }]]) {
    const h = harness(); const done = h.saver.run(call({ action: 'retry' }), h.socket)
    await awaiting(h, 'status'); h.answer(why, { receipt: receipt(op, intent, { outcome }) })
    assert.equal((await done).why, why); assert.equal(h.captures(), 0)
  }
  const key = hash(op.slug + '\0' + op.operation_id)
  const temporary = receipt(op, intent, { event_id: `.wicket-screenshot-${key}-${'a'.repeat(32)}.stage-1-temporary`, accepted_at: null, verified: null, outcome: 'aborted' })
  await validateReceipt(temporary, 'aborted', op)
  await assert.rejects(validateReceipt({ ...temporary, outcome: 'stored' }, 'stored', op))
})
test('receipt mismatch is unresolved and retains bytes; it cannot silently become success', async () => {
  const h = harness(); const done = h.saver.run(call(), h.socket)
  await awaiting(h, 'status'); h.answer('unknown'); const begin = await awaiting(h, 'begin')
  h.answer('ready', { next_offset: 0 }); const chunk = await awaiting(h, 'chunk')
  h.answer('ack', { next_offset: Buffer.from(chunk.data, 'base64').length }); await awaiting(h, 'finish')
  h.answer('stored', { receipt: receipt(call(), begin.intent, { event_id: 'forged' }) })
  assert.equal((await done).why, 'unresolved'); assert.ok(h.saver.retainedBytes > 0)
})
test('wrong operation and attempt replies stop only their own call', async () => {
  for (const fields of [{ operation_id: 'wrong-op' }, { attempt_id: 'old-attempt' }]) {
    const h = harness(); const done = h.saver.run(call(), h.socket)
    const query = await awaiting(h, 'status')
    h.saver.receive({ ...reply(query, 'unknown'), ...fields }, h.socket)
    assert.equal((await done).why, 'unresolved'); assert.equal(h.captures(), 0)
  }
})
test('timeout releases the waiter without claiming failed or aborted publication', async () => {
  const h = harness({ timeout: 5 }); const done = h.saver.run(call(), h.socket)
  await awaiting(h, 'status')
  assert.equal((await done).why, 'unresolved'); assert.equal(h.saver.calls.size, 0); assert.equal(h.captures(), 0)
})
test('capture reservations bound concurrent memory even while CDP is pending', async () => {
  const pending = []; const h = harness({ capture: () => new Promise(resolve => pending.push(resolve)) })
  const runs = []
  for (let n = 0; n < 3; n++) {
    runs.push(h.saver.run(call({ call_id: `call-${n}`, operation_id: `op-${n}` }), h.socket))
    await awaiting(h, 'status'); h.answer('unknown'); await tick()
  }
  assert.equal(pending.length, 2); assert.equal(h.saver.retainedBytes, LIMITS.totalBytes)
  assert.equal((await runs[2]).why, 'rejected')
  h.saver.disconnect(h.socket)
  for (const resolve of pending) resolve(await captured())
  assert.equal((await runs[0]).why, 'unresolved'); assert.equal((await runs[1]).why, 'unresolved')
  assert.equal(h.saver.retainedBytes, png().length * 2)
})
test('same ID in different slugs has independent state; same operation cannot overlap itself', async () => {
  const h = harness()
  const first = h.saver.run(call(), h.socket); await awaiting(h, 'status')
  const duplicate = await h.saver.run(call({ call_id: 'duplicate' }), h.socket)
  assert.equal(duplicate.why, 'rejected')
  const second = h.saver.run(call({ slug: 'other-slug', call_id: 'call-2', action: 'status' }), h.socket)
  await awaiting(h, 'status'); h.answer('unknown'); assert.equal((await second).why, 'unknown')
  h.saver.disconnect(h.socket); assert.equal((await first).why, 'unresolved')
})

test('disconnect during pending CDP returns promptly without releasing uncompleted capture memory', async () => {
  let finish
  const h = harness({ capture: () => new Promise(resolve => { finish = resolve }) })
  const done = h.saver.run(call(), h.socket)
  await awaiting(h, 'status'); h.answer('unknown'); await tick()
  assert.equal(h.saver.retainedBytes, LIMITS.pngBytes)
  h.saver.disconnect(h.socket)
  assert.equal((await done).why, 'unresolved'); assert.equal(h.saver.calls.size, 0)
  assert.equal(h.saver.retainedBytes, LIMITS.pngBytes)
  finish(await captured()); await tick()
  assert.equal(h.saver.retainedBytes, png().length)
  assert.equal(h.sent.some(p => p.why === 'begin'), false)
})
test('a forged terminal status remains unresolved even before any new capture', async () => {
  const h = harness(); const done = h.saver.run(call({ action: 'status' }), h.socket)
  await awaiting(h, 'status'); h.answer('stored', { receipt: {} })
  assert.equal((await done).why, 'unresolved'); assert.equal(h.captures(), 0)
})

test('a terminal status cannot release the allocation of an obsolete pending capture early', async () => {
  let finish
  const h = harness({ capture: () => new Promise(resolve => { finish = resolve }) })
  const done = h.saver.run(call(), h.socket)
  await awaiting(h, 'status'); h.answer('unknown'); await tick(); h.saver.disconnect(h.socket); await done
  const retry = h.saver.run(call({ action: 'retry', call_id: 'call-2' }), h.socket)
  await awaiting(h, 'status')
  const c = await captured()
  const intent = { destination: call().destination, bytes: c.bytes.length, sha256: c.sha256, mode: 'viewport', source_url: c.source_url, captured_at: c.captured_at }
  h.answer('stored', { receipt: receipt(call(), intent) }); assert.equal((await retry).why, 'stored')
  assert.equal(h.saver.retainedBytes, LIMITS.pngBytes)
  finish(c); await tick(); assert.equal(h.saver.retainedBytes, 0)
})
