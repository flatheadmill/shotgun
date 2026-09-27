import test from 'node:test'
import assert from 'node:assert/strict'
import { Firehose, LIMITS, ENABLE_PARAMS } from '../firehose.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred () {
  let resolve; let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture ({ attach = async () => {}, command = () => ({ body: 'payload', base64Encoded: false }) } = {}) {
  const calls = []
  const tap = new Firehose({ attach, command: (tabId, method, params) => {
    calls.push({ tabId, method, params })
    return command(method, params)
  } })
  const event = (event, params, tabId = 7) => tap.onEvent(tabId, `Network.${event}`, params)
  const response = (id, url = 'https://example.test/api?cursor=1', extra = {}) => event('responseReceived', {
    requestId: id, timestamp: 1, type: 'Fetch', response: { url, status: 200, mimeType: 'application/json', ...extra }
  })
  const finish = id => event('loadingFinished', { requestId: id, timestamp: 2, encodedDataLength: 12 })
  return { tap, calls, event, response, finish, bodies: () => calls.filter(c => c.method === 'Network.getResponseBody') }
}

test('explicit arming, literal validation, and reads never capture or alter the selection', async () => {
  const { tap, calls, response, finish } = fixture()
  assert.equal(tap.read().hasCapture, false)
  for (const tabId of [undefined, 0, -1, 1.1, '7']) await assert.rejects(tap.start({ tabId }), /explicit/)
  for (const url of ['', null, 'not a URL', 'https://example.test/api?q=1', 'https://example.test/api#x',
    'https://example.test/a\nb', 'https://example.test/a b', 'https://example.test/\\a']) {
    await assert.rejects(tap.start({ tabId: 7, url }), /url/)
  }
  assert.deepEqual(calls, [])
  await tap.start({ tabId: 7, url: 'https://example.test/api' })
  assert.deepEqual(calls[0], { tabId: 7, method: 'Network.enable', params: ENABLE_PARAMS })
  await assert.rejects(tap.start({ tabId: 8 }), /already collecting/)
  response('selected', 'https://example.test/api?count=40#fragment', { status: 500, mimeType: 'text/html' })
  finish('selected')
  await tick()
  const inventory = tap.read()
  assert.equal(inventory.url, 'https://example.test/api')
  assert.equal(inventory.matched, 1)
  assert.equal(inventory.records[0].response.url, 'https://example.test/api?count=40#fragment')
  assert.equal(inventory.records[0].response.status, 500)
  assert.equal('body' in inventory.records[2], false)
  assert.equal(tap.read({ body: 2 }).record.body, 'payload')
  const before = calls.length
  tap.read({ from: 1, limit: 1 }); tap.read({ body: 2 })
  assert.equal(calls.length, before)
  assert.throws(() => tap.read({ from: -1 }), /from/)
  assert.throws(() => tap.read({ limit: 101 }), /limit/)
  assert.throws(() => tap.read({ body: 0 }), /body-outcome/)
  assert.throws(() => tap.read({ body: 2, from: 0 }), /either/)
})

test('partial lifecycles, redirects and nonmatching metadata remain supplied events', async () => {
  const { tap, event, response, finish, bodies } = fixture()
  await tap.start({ tabId: 7, url: 'https://example.test/api' })
  event('requestWillBeSent', { requestId: 'redirect', request: { url: 'https://example.test/api', method: 'GET' } })
  event('requestWillBeSent', { requestId: 'redirect', request: { url: 'https://example.test/elsewhere', method: 'GET' },
    redirectResponse: { url: 'https://example.test/api', status: 302, headers: { location: '/elsewhere' } } })
  response('redirect', 'https://example.test/elsewhere')
  finish('redirect')
  finish('missing-response')
  event('dataReceived', { requestId: 'ignored' })
  event('responseReceived', { requestId: 'other-tab', response: { url: 'https://example.test/api' } }, 8)
  assert.equal(bodies().length, 0)
  // No requestWillBeSent is required for a final response already in progress.
  response('partial')
  finish('partial')
  await tick()
  const records = tap.read().records
  assert.equal(records.length, 8)
  assert.equal(records[1].redirectResponse.status, 302)
  assert.equal(records[0].request.url, 'https://example.test/api')
  assert.equal(records[7].response, 5)
  assert.equal(records[7].finished, 6)
  assert.equal(records[7].requestId, 'partial')
  assert.equal(bodies().length, 1)
})

test('overlapping completions use one native body slot with explicit busy and no queue', async () => {
  const held = deferred()
  const { tap, response, finish, bodies } = fixture({ command: method => method === 'Network.getResponseBody' ? held.promise : undefined })
  await tap.start({ tabId: 7 })
  response('a'); finish('a'); response('b'); finish('b')
  assert.equal(bodies().length, 1)
  assert.equal(tap.read({ body: 4 }).record.outcome, 'busy')
  held.resolve({ body: '', base64Encoded: false })
  await tick()
  assert.equal(bodies().length, 1, 'busy did not enqueue another native command')
  const body = tap.read({ body: 5 }).record
  assert.equal(body.outcome, 'retained')
  assert.equal(body.body, '')
  assert.equal(body.returnedBytes, 0)
  assert.equal(body.clipped, false)
  assert.equal(body.response, 0)
  assert.equal(body.finished, 1)
})

test('base64 is preserved, network failure is distinct, and retrieval errors are bounded', async () => {
  let count = 0
  const message = 'Chrome refused: ' + '😀'.repeat(1000)
  const { tap, event, response, finish, bodies } = fixture({ command: method => {
    if (method !== 'Network.getResponseBody') return
    if (count++ === 0) return { body: 'AAH+/w==', base64Encoded: true }
    return Promise.reject(new Error(message))
  } })
  await tap.start({ tabId: 7 })
  response('base64'); finish('base64'); await tick()
  assert.equal(tap.read({ body: 2 }).record.body, 'AAH+/w==')
  assert.equal(tap.read({ body: 2 }).record.base64Encoded, true)
  response('failed')
  event('loadingFailed', { requestId: 'failed', errorText: 'net::ERR_ABORTED', canceled: true })
  assert.equal(bodies().length, 1)
  response('unavailable'); finish('unavailable'); await tick()
  const records = tap.read().records
  assert.equal(records[4].event, 'Network.loadingFailed')
  assert.equal(records[4].errorText, 'net::ERR_ABORTED')
  assert.equal('status' in records[4], false)
  const unavailable = tap.read({ body: 7 }).record
  assert.equal(unavailable.outcome, 'unavailable')
  assert.ok(Buffer.byteLength(unavailable.error) <= LIMITS.errorBytes)
  assert.ok(message.startsWith(unavailable.error))
  assert.equal(unavailable.error.includes('\uFFFD'), false)
})

test('body clipping respects Unicode, base64 quartets and the escaped result bound', async () => {
  for (const result of [
    { body: '😀'.repeat(LIMITS.bodyBytes / 4 + 3), base64Encoded: false },
    { body: 'A'.repeat(LIMITS.bodyBytes + 12), base64Encoded: true },
    { body: '\u0001'.repeat(LIMITS.bodyBytes), base64Encoded: false }
  ]) {
    const { tap, response, finish } = fixture({ command: () => result })
    await tap.start({ tabId: 7 })
    response('clipped'); finish('clipped'); await tick()
    const read = tap.read({ body: 2 })
    const record = read.record
    assert.equal(record.clipped, true)
    assert.equal(record.returnedBytes, Buffer.byteLength(result.body))
    assert.equal(record.retainedBytes, Buffer.byteLength(record.body))
    assert.ok(record.retainedBytes <= LIMITS.bodyBytes)
    assert.ok(Buffer.byteLength(JSON.stringify(read)) <= LIMITS.readBytes)
    assert.ok(result.body.startsWith(record.body))
    assert.equal(/[\uD800-\uDBFF]$/.test(record.body), false)
    if (result.base64Encoded) assert.equal(record.body.length % 4, 0)
  }
})

test('event count stops at full without eviction or further commands', async () => {
  const { tap, calls, finish } = fixture()
  await tap.start({ tabId: 7 })
  for (let i = 0; i < LIMITS.events; i++) finish(`r${i}`)
  const full = tap.read({ limit: 1 })
  assert.equal(full.state, 'full')
  assert.equal(full.reason, 'event_limit')
  assert.equal(full.events, LIMITS.events)
  assert.equal(full.records[0].requestId, 'r0')
  assert.equal(calls.filter(c => c.method === 'Network.disable').length, 1)
  finish('after-full')
  assert.equal(tap.read().seen, LIMITS.events)
})

test('an oversized metadata event ends collection without retaining unreadable data', async () => {
  for (const [size, reason] of [[LIMITS.bytes, 'byte_limit'], [LIMITS.readBytes, 'read_limit']]) {
    const { tap, event } = fixture()
    await tap.start({ tabId: 7 })
    event('requestWillBeSent', { requestId: 'huge', request: { url: 'https://example.test/', method: 'POST', headers: { huge: 'x'.repeat(size) } } })
    const read = tap.read()
    assert.equal(read.state, 'full')
    assert.equal(read.reason, reason)
    assert.equal(read.events, 0)
    assert.equal(read.seen, 1)
    assert.equal(read.omitted.event, 'Network.requestWillBeSent')
    assert.equal(read.omitted.outcome, 'not_retained')
  }
  const { tap, response } = fixture()
  await tap.start({ tabId: 7 })
  response('large-response', undefined, { headers: { huge: 'x'.repeat(LIMITS.bytes) } })
  const read = tap.read()
  assert.deepEqual(read.omitted, { event: 'Network.responseReceived', outcome: 'not_retained' })
  assert.ok(Buffer.byteLength(JSON.stringify(read)) <= LIMITS.readBytes, 'rejected response metadata cannot escape into the control header')
})

test('aggregate body bytes stop the pile and report the unretained outcome', async () => {
  const { tap, response, finish } = fixture({ command: () => ({ body: 'x'.repeat(LIMITS.bodyBytes), base64Encoded: false }) })
  await tap.start({ tabId: 7 })
  for (let i = 0; i < 20 && tap.read().state === 'collecting'; i++) {
    response(`r${i}`); finish(`r${i}`); await tick()
  }
  const full = tap.read()
  assert.equal(full.state, 'full')
  assert.equal(full.reason, 'byte_limit')
  assert.ok(full.bytes <= LIMITS.bytes)
  assert.equal(full.omitted.event, 'body')
  assert.equal(full.omitted.outcome, 'not_retained')
  assert.equal(full.outstandingBodyAtStop, null, 'the body command already settled before its outcome filled the pile')
  assert.equal(full.records[0].requestId, 'r0')
  assert.equal(tap.read({ body: 2 }).record.body.length, LIMITS.bodyBytes)
})

test('inventory slices fit the result bound and remain repeatable', async () => {
  const { tap, event } = fixture()
  await tap.start({ tabId: 7 })
  for (let i = 0; i < 6; i++) event('requestWillBeSent', { requestId: `${i}`, request: {
    url: 'https://example.test/', method: 'POST', postData: '"'.repeat(100000)
  } })
  const first = tap.read()
  assert.ok(first.records.length > 0 && first.records.length < 6)
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= LIMITS.readBytes)
  const next = tap.read({ from: first.next })
  assert.equal(first.records.length + next.records.length, 6)
  assert.deepEqual(tap.read(), first)
})

test('stop freezes evidence and an old pending body still occupies the replacement slot', async () => {
  const held = deferred()
  let count = 0
  const { tap, response, finish, bodies } = fixture({ command: method => method !== 'Network.getResponseBody' ? undefined
    : count++ === 0 ? held.promise : { body: 'new', base64Encoded: false } })
  await tap.start({ tabId: 7 })
  response('old'); finish('old')
  const stopped = tap.stop()
  assert.equal(stopped.outstandingBodyAtStop.outcome, 'discard_on_settlement')
  const frozen = tap.read().records
  response('ignored'); finish('ignored')
  assert.deepEqual(tap.read().records, frozen)
  await tick()
  await tap.start({ tabId: 7 })
  assert.equal(tap.read().bodyCommandInFlight, true)
  response('new-busy'); finish('new-busy')
  assert.equal(bodies().length, 1)
  assert.equal(tap.read({ body: 2 }).record.outcome, 'busy')
  const before = JSON.stringify(tap.read().records)
  held.resolve({ body: 'OLD_MUST_NOT_LAND', base64Encoded: false }); await tick()
  assert.equal(JSON.stringify(tap.read().records), before)
  assert.equal(tap.read().bodyCommandInFlight, false)
  response('new-ready'); finish('new-ready'); await tick()
  assert.equal(tap.read({ body: 5 }).record.body, 'new')
  assert.equal(bodies().length, 2)
})

test('settlement after stop changes no frozen events or counts', async () => {
  const held = deferred()
  const { tap, response, finish } = fixture({ command: method => method === 'Network.getResponseBody' ? held.promise : undefined })
  await tap.start({ tabId: 7 })
  response('old'); finish('old'); tap.stop()
  const before = tap.read()
  held.reject(new Error('late error')); await tick()
  const after = tap.read()
  for (const key of ['seen', 'matched', 'events', 'bytes', 'records', 'outstandingBodyAtStop', 'endedAt']) assert.deepEqual(after[key], before[key])
})

test('stop during enable defers disable, blocks replacement, and admits no pre-armed events', async () => {
  const enable = deferred(); const disable = deferred()
  const { tap, calls, response } = fixture({ command: method => method === 'Network.enable' ? enable.promise : disable.promise })
  const start = tap.start({ tabId: 7 })
  const cancelled = assert.rejects(start, /stopped/)
  await tick()
  response('before-enable-ack')
  assert.equal(tap.read().events, 0)
  tap.stop()
  assert.equal(calls.filter(c => c.method === 'Network.disable').length, 0)
  await assert.rejects(tap.start({ tabId: 8 }), /transition/)
  enable.resolve(); await cancelled
  assert.equal(calls.filter(c => c.method === 'Network.disable').length, 1)
  await assert.rejects(tap.start({ tabId: 8 }), /transition/)
  disable.resolve(); await tick()
  assert.equal(tap.read().hasCapture, false)
  assert.equal(tap.read().network.pending, false)
})

test('failed starts preserve a stopped pile, including stop during attachment', async () => {
  const attach = deferred()
  let attempts = 0
  const { tap, finish, calls } = fixture({ attach: () => attempts++ === 0 ? undefined : attach.promise })
  await tap.start({ tabId: 7 })
  finish('retained'); tap.stop(); await tick()
  const old = tap.read().records
  const start = tap.start({ tabId: 8 })
  const cancelled = assert.rejects(start, /stopped/)
  tap.stop(); attach.resolve(); await cancelled
  assert.deepEqual(tap.read().records, old)
  assert.equal(tap.read().tabId, 7)
  assert.equal(calls.filter(c => c.method === 'Network.enable').length, 1)
})

test('enable failure preserves evidence and leaves a later explicit start possible', async () => {
  let enables = 0
  const { tap, finish } = fixture({ command: method => {
    if (method === 'Network.enable' && enables++ === 1) throw new Error('enable refused')
  } })
  await tap.start({ tabId: 7 }); finish('retained'); tap.stop(); await tick()
  const old = tap.read()
  await assert.rejects(tap.start({ tabId: 8 }), /enable refused/)
  assert.deepEqual(tap.read(), old)
  await tap.start({ tabId: 8, url: 'file:///tmp/fixture.json' })
  assert.equal(tap.read().tabId, 8)
  assert.equal(tap.read().events, 0)
})

test('detach keeps the native body slot occupied until its stale result settles', async () => {
  const held = deferred()
  const { tap, event, response, finish, bodies } = fixture({ command: method => method === 'Network.getResponseBody' ? held.promise : undefined })
  await tap.start({ tabId: 7 }); response('old'); finish('old'); tap.detached(7)
  await tap.start({ tabId: 8 })
  event('responseReceived', { requestId: 'new', response: { url: 'https://example.test/' } }, 8)
  event('loadingFinished', { requestId: 'new' }, 8)
  assert.equal(tap.read({ body: 2 }).record.outcome, 'busy')
  assert.equal(bodies().length, 1)
  held.resolve({ body: 'old tab', base64Encoded: false }); await tick()
  assert.equal(tap.read().events, 3)
  assert.equal(tap.read().bodyCommandInFlight, false)
})

test('detach retires a pending disable without allowing its settlement to clear a new enable', async () => {
  const disable = deferred(); const enable = deferred()
  let enables = 0
  const { tap } = fixture({ command: method => method === 'Network.disable' ? disable.promise
    : method === 'Network.enable' && enables++ > 0 ? enable.promise : undefined })
  await tap.start({ tabId: 7 }); tap.stop()
  await assert.rejects(tap.start({ tabId: 7 }), /transition/)
  tap.detached(7)
  const replacement = tap.start({ tabId: 7 }); await tick()
  disable.resolve(); await tick()
  await assert.rejects(tap.start({ tabId: 8 }), /transition/)
  enable.resolve(); await replacement
  assert.equal(tap.read().state, 'collecting')
})

test('late enable from a detached generation never disables or replaces a fresh tap', async () => {
  const oldEnable = deferred(); let enables = 0
  const { tap, calls } = fixture({ command: method => method === 'Network.enable' && enables++ === 0 ? oldEnable.promise : undefined })
  const old = tap.start({ tabId: 7 })
  const rejected = assert.rejects(old, /detached/)
  await tick(); tap.detached(7)
  await tap.start({ tabId: 7 })
  oldEnable.resolve(); await rejected
  assert.equal(tap.read().state, 'collecting')
  assert.equal(calls.filter(c => c.method === 'Network.disable').length, 0)
  tap.detached(7, 'tab_removed')
  assert.equal(tap.read().reason, 'tab_removed')
})

test('disable failure stays visible and blocks rearming until confirmed detach', async () => {
  const { tap } = fixture({ command: method => method === 'Network.disable' ? Promise.reject(new Error('disable rejected')) : undefined })
  await tap.start({ tabId: 7 }); tap.stop(); await tick()
  assert.equal(tap.read().network.error, 'disable rejected')
  await assert.rejects(tap.start({ tabId: 8 }), /transition/)
  tap.detached(7)
  await tap.start({ tabId: 8 })
  assert.equal(tap.read().tabId, 8)
})
