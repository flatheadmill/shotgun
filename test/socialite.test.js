import test from 'node:test'
import assert from 'node:assert/strict'
import { LIMITS, DISPOSITIONS, bookmarks, asset, eligibleMedia, responseBytes, imageBytes } from '../socialite.js'
import { helper, body, tweet, descriptor, actual, BOOKMARKS, deferred, until, tick } from './socialite-fixture.js'

test('recognition and observed wrappers derive only bounded photo/poster references', () => {
  assert.deepEqual(bookmarks(BOOKMARKS), { url: 'https://x.com/i/api/graphql/hash/Bookmarks', hash: 'hash' })
  for (const url of ['http://x.com/i/api/graphql/a/Bookmarks', 'https://x.com.evil/i/api/graphql/a/Bookmarks', 'https://x.com/i/api/graphql/a/b/Bookmarks', 'https://x.com/i/api/graphql/a/Likes']) assert.equal(bookmarks(url), null)
  const post = tweet('1', [{ type: 'photo', media_url_https: descriptor('photo') }, { type: 'video', media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/one/pu/img/poster.jpg', video_info: { variants: [{ url: 'https://video.twimg.com/private.mp4' }] } }])
  post.quoted_status_result = { result: tweet('2', [{ type: 'photo', media_url_https: descriptor('quote') }]) }
  post.quoted_status_result.result.quoted_status_result = { result: tweet('3') }
  post.unobserved = tweet('999')
  const parsed = eligibleMedia(body([{ __typename: 'TweetWithVisibilityResults', tweet: post }]))
  assert.equal(parsed.references.length, 3)
  assert.equal(JSON.stringify(parsed).includes('PRIVATE_BODY_TEXT'), false)
  assert.equal(parsed.references.some(ref => ref.descriptor_url.includes('mp4')), false)
  assert.equal(asset(descriptor('photo'), true), asset(actual('photo')))
  assert.equal(asset('https://pbs.twimg.com/media/photo?format=png&name=small'), asset(actual('photo')))
  for (const url of ['https://pbs.twimg.com/profile_images/a?format=jpg', 'https://other.test/media/photo?format=jpg', 'https://pbs.twimg.com/media/photo.jpg', 'https://pbs.twimg.com/media/photo?format=mp4', 'https://pbs.twimg.com/media/photo?format=webp', 'https://pbs.twimg.com/media/photo.webp?format=jpg']) assert.equal(asset(url), null)
})

test('unknown shapes, identity disagreement and parser bounds remain explicit', () => {
  assert.equal(eligibleMedia('PRIVATE_INVALID_JSON').counts.eligibility_invalid_json, 1)
  assert.equal(eligibleMedia('{}').counts.eligibility_root_unknown, 1)
  const invalid = tweet(); invalid.legacy.id_str = '2'
  const parsed = eligibleMedia(body([invalid, { __typename: 'Unknown', nested: tweet() }]))
  assert.equal(parsed.references.length, 0); assert.equal(parsed.counts.identity_unknown, 1); assert.equal(parsed.counts.result_unknown, 1)
  const many = eligibleMedia(body(Array.from({ length: LIMITS.entries + 1 }, (_, n) => tweet(`${n + 1}`, Array.from({ length: LIMITS.mediaPerPost + 1 }, (_, m) => ({ type: 'photo', media_url_https: descriptor(`${n}-${m}`) }))))))
  assert.equal(many.counts.entry_limit, 1); assert.ok(many.counts.media_limit); assert.ok(many.counts.eligibility_count_pressure)
  assert.equal(many.references.length, LIMITS.eligibilityReferences)
})

test('responses encode the unchanged decoded string; images require complete canonical base64', () => {
  const original = ' { "text": "☃😀", "same": 1 }\n'
  assert.deepEqual(responseBytes({ body: original, base64Encoded: false }), new TextEncoder().encode(original))
  assert.equal(responseBytes({ body: '', base64Encoded: false }).length, 0)
  assert.throws(() => responseBytes({ body: 'e30=', base64Encoded: true }), /representation/)
  assert.throws(() => responseBytes({ body: '☃'.repeat(LIMITS.responseBytes), base64Encoded: false }), /oversized/)
  assert.deepEqual(imageBytes({ body: 'YQ==', base64Encoded: true }), Uint8Array.of(97))
  for (const data of ['', 'YR==', 'YQ', '!!!!', 'YQ==AAAA']) assert.throws(() => imageBytes({ body: data, base64Encoded: true }), /base64/)
  assert.throws(() => imageBytes({ body: 'YQ==', base64Encoded: true, clipped: true }), /clipped/)
  assert.throws(() => imageBytes({ body: 'YQ==', base64Encoded: false }), /representation/)
  assert.throws(() => imageBytes({ body: 'A'.repeat(Math.ceil(LIMITS.imageBytes / 3) * 4 + 4), base64Encoded: true }), /oversized/)
})

test('start needs explicit X tab, available probe and idle Firehose; no capture before enable acknowledgement', async () => {
  const enable = deferred(); const f = helper({ command: (tab, method) => method === 'Network.enable' ? enable.promise : undefined })
  try {
    await assert.rejects(f.app.start({}, f.socket), /explicit_tab_required/)
    f.busy(true); await assert.rejects(f.start(), /firehose_busy/); f.busy(false)
    for (const why of ['missing_companion', 'ambiguous_companion']) { f.presence(why); await assert.rejects(f.start(), new RegExp(why)) }
    assert.equal(f.commands.length, 0)
    f.presence('available'); const starting = f.start(); await until(() => f.commands.some(c => c.method === 'Network.enable'))
    f.complete('early'); assert.equal(f.commands.some(c => c.method === 'Network.getResponseBody'), false)
    enable.resolve(); assert.equal((await starting).state, 'collecting')
    assert.deepEqual(f.frames.map(p => p.why), ['probe', 'probe', 'probe'])
  } finally { enable.resolve(); await f.cleanup() }
  const wrong = helper({ getTab: async () => ({ url: 'https://example.test/' }) })
  try { await assert.rejects(wrong.start(), /explicit_x_tab_required/); assert.equal(wrong.frames.length, 0) } finally { await wrong.cleanup() }
})

test('complete responses and actual image variants retain provenance without parent receipt ordering', async () => {
  const f = helper({ hold: p => p.why === 'finish' })
  try {
    await f.start()
    const text = body([tweet()]); f.bodies.set('parent', { body: text, base64Encoded: false }); f.complete('parent')
    await until(() => f.app.status().eligibilityReferences === 1)
    f.bodies.set('picture', { body: 'YQ==', base64Encoded: true })
    f.app.onEvent(7, 'Network.requestWillBeSent', { requestId: 'picture', timestamp: 14, request: { url: actual('one'), method: 'GET' } })
    f.complete('picture', actual('one'), 'image/jpeg')
    await until(() => f.held.length === 2)
    const response = f.frames.find(p => p.why === 'begin' && p.manifest.kind === 'response')
    const image = f.frames.find(p => p.why === 'begin' && p.manifest.kind === 'image')
    assert.deepEqual(f.objects.get(response.operation_id).bytes, new TextEncoder().encode(text))
    assert.equal(image.manifest.provenance.parent_operation_id, response.operation_id)
    assert.equal(image.manifest.provenance.eligibility.descriptor_url, descriptor('one'))
    assert.equal(image.manifest.provenance.response_url, actual('one'))
    assert.equal(image.manifest.provenance.from_disk_cache, true)
    assert.equal(image.manifest.provenance.request_method, 'GET')
    assert.equal(JSON.stringify(image.manifest).includes('PRIVATE_HEADER'), false)
    assert.equal(JSON.stringify(f.app.status()).includes('PRIVATE_BODY_TEXT'), false)
    f.app.stop(); await tick(); assert.equal(f.ingress.operations.size, 2)
    f.release(); f.release(); await until(() => !f.ingress.unresolved)
  } finally { await f.cleanup() }
})

test('eligibility at completion is conservative, and video bytes are never selected', async () => {
  const f = helper()
  try {
    await f.start(); f.complete('early', actual('one'), 'image/jpeg')
    assert.equal(f.app.counts.image_not_eligible_at_completion, 1)
    f.bodies.set('parent', { body: body([tweet()]), base64Encoded: false }); f.complete('parent')
    await until(() => f.app.status().eligibilityReferences === 1)
    assert.equal(f.commands.some(c => c.params.requestId === 'early'), false)
    f.complete('video', 'https://video.twimg.com/media/one.mp4', 'video/mp4')
    assert.equal(f.commands.some(c => c.params.requestId === 'video'), false)
    // A response already seen may become eligible before its completion.
    f.received('late-eligible', actual('two'), 'image/jpeg')
    await until(() => !f.ingress.unresolved)
    f.bodies.set('next', { body: body([tweet('2', [{ type: 'photo', media_url_https: descriptor('two') }])]), base64Encoded: false }); f.complete('next')
    await until(() => f.app.status().eligibilityReferences === 2)
    f.bodies.set('late-eligible', { body: 'Yg==', base64Encoded: true }); f.finish('late-eligible')
    await until(() => f.app.counts.image_retained === 1)
  } finally { await f.cleanup() }
})

test('image acquisition and transfer pressure do not block responses; waiting descriptors shed newest', async () => {
  const f = helper({ hold: p => p.why === 'chunk' && p.data === 'YQ==' })
  try {
    await f.start(); f.bodies.set('parent', { body: body([tweet()]), base64Encoded: false }); f.complete('parent')
    await until(() => f.app.status().eligibilityReferences === 1)
    for (let n = 0; n < LIMITS.imageWaiting + 2; n++) { const id = `image-${n}`; f.bodies.set(id, { body: 'YQ==', base64Encoded: true }); f.complete(id, actual('one'), 'image/jpeg') }
    await until(() => f.held.length)
    assert.equal(f.app.status().waiting.image.descriptors, LIMITS.imageWaiting)
    assert.equal(f.app.counts.image_waiting_pressure, 1)
    await until(() => ![...f.ingress.operations.values()].some(op => op.manifest.kind === 'response'))
    f.bodies.set('another', { body: '{}', base64Encoded: false }); f.complete('another')
    await until(() => f.app.counts.response_retained === 2)
    assert.equal(f.commands.filter(c => c.method === 'Network.getResponseBody' && c.params.requestId.startsWith('image-')).length, 1)
    assert.ok(f.app.status().workBytesReserved <= LIMITS.totalWorkBytes)
  } finally { await f.cleanup() }
})

test('held native image and response calls own separate reservations and bounded completion queues', async () => {
  const image = deferred(); const response = deferred(); const f = helper()
  try {
    await f.start(); f.bodies.set('parent', { body: body([tweet()]), base64Encoded: false }); f.complete('parent')
    await until(() => f.app.status().eligibilityReferences === 1 && !f.ingress.unresolved && !f.app.slots.response)
    f.bodies.set('native-image', image.promise); f.complete('native-image', actual('one'), 'image/jpeg')
    f.bodies.set('native-response', response.promise); f.complete('native-response')
    assert.equal(f.app.status().workBytesReserved, LIMITS.totalWorkBytes)
    for (let n = 0; n <= LIMITS.responseWaiting; n++) f.complete(`response-${n}`)
    for (let n = 0; n <= LIMITS.imageWaiting; n++) f.complete(`image-${n}`, actual('one'), 'image/jpeg')
    const status = f.app.status()
    assert.equal(status.waiting.response.descriptors, LIMITS.responseWaiting)
    assert.equal(status.waiting.image.descriptors, LIMITS.imageWaiting)
    assert.equal(status.counts.response_waiting_pressure, 1); assert.equal(status.counts.image_waiting_pressure, 1)
    assert.equal(status.native.response.phase, 'body'); assert.equal(status.native.image.phase, 'body')
    f.app.stop(); assert.equal(f.app.status().workBytesReserved, LIMITS.totalWorkBytes)
    image.resolve({ body: 'YQ==', base64Encoded: true }); response.resolve({ body: '{}', base64Encoded: false })
    await until(() => f.app.status().workBytesReserved === 0)
    assert.equal(f.app.counts.stale_body_discarded, 2)
  } finally { f.app.stop(); image.resolve(); response.resolve(); await f.cleanup() }
})

test('metadata and eligibility byte limits shed candidates before their count limits', async () => {
  const f = helper()
  try {
    await f.start()
    const stem = 'a'.repeat(850)
    const url = actual(stem)
    for (let n = 0; n < LIMITS.candidates; n++) {
      f.app.onEvent(7, 'Network.requestWillBeSent', { requestId: `candidate-${n}`, request: { url, method: 'GET' } })
      f.received(`candidate-${n}`, url, 'image/jpeg')
    }
    assert.ok(f.app.counts.candidate_byte_pressure > 0)
    assert.ok(f.app.status().candidateBytes <= LIMITS.candidateBytes)
    assert.ok(f.app.status().candidates < LIMITS.candidates)
    f.app.stop(); await tick(); await f.start()
    const posts = Array.from({ length: 12 }, (_, n) => tweet(`${n}`, Array.from({ length: 8 }, (_, m) => ({ type: 'photo', media_url_https: descriptor(`${stem}-${n}-${m}`) }))))
    f.bodies.set('parent', { body: body(posts), base64Encoded: false }); f.complete('parent')
    await until(() => f.app.counts.response_retained === 1)
    assert.ok(f.app.counts.eligibility_byte_pressure > 0)
    assert.ok(f.app.status().eligibilityBytes <= LIMITS.eligibilityBytes)
    assert.ok(f.app.status().eligibilityReferences < LIMITS.eligibilityReferences)
  } finally { await f.cleanup() }
})

test('stop and replacement retain native reservations until stale body and hash continuations settle', async () => {
  const old = deferred(); const hash = deferred(); let hashes = 0
  const f = helper({ hash: bytes => hashes++ === 0 ? hash.promise : import('../companion-ingress.js').then(m => m.sha256(bytes)) })
  try {
    await f.start(); f.bodies.set('old', old.promise); f.complete('old')
    f.app.stop(); await tick(); await f.start()
    f.bodies.set('new', { body: '{}', base64Encoded: false }); f.complete('new')
    assert.equal(f.commands.filter(c => c.method === 'Network.getResponseBody').length, 1)
    assert.equal(f.app.status().native.response.discardOnSettlement, true)
    old.resolve({ body: 'PRIVATE_OLD', base64Encoded: false }); await until(() => hashes === 1)
    f.app.stop(); await tick(); await f.start()
    hash.resolve('a'.repeat(64)); await tick()
    assert.equal(f.frames.some(p => p.why === 'begin'), false)
    assert.equal(f.app.counts.stale_body_discarded, 2)
  } finally { old.resolve({ body: '', base64Encoded: false }); hash.resolve('a'.repeat(64)); await f.cleanup() }
})

test('stop during enable disables only that generation and failed disable blocks rearm', async () => {
  const enable = deferred(); let failDisable = true
  const f = helper({ command: (tab, method) => { if (method === 'Network.enable') return enable.promise; if (method === 'Network.disable' && failDisable) throw Error('PRIVATE_DISABLE') } })
  try {
    const starting = f.start(); const rejected = assert.rejects(starting, /start_cancelled/)
    await until(() => f.commands.some(c => c.method === 'Network.enable'))
    f.app.stop(); enable.resolve(); await rejected; await tick()
    assert.equal(f.app.status().network, 'disable_failed')
    await assert.rejects(f.start(), /network_owned/)
    f.app.detached(7); failDisable = false; await f.start()
    assert.equal(JSON.stringify(f.app.status()).includes('PRIVATE_DISABLE'), false)
  } finally { enable.resolve(); await f.cleanup() }
})

test('disconnect never resumes; unresolved operations require explicit abandonment before rearm', async () => {
  const f = helper({ hold: p => p.why === 'begin' })
  try {
    await f.start(); f.bodies.set('parent', { body: '{}', base64Encoded: false }); f.complete('parent')
    await until(() => f.held.length)
    f.app.disconnect(f.socket); await tick(); const replacement = f.replace()
    await assert.rejects(f.app.start({ tabId: 7 }, replacement), /unresolved_operations/)
    const id = [...f.ingress.operations.keys()][0]; f.ingress.abandon(id)
    await f.app.start({ tabId: 7 }, replacement)
    f.release(); await tick()
    assert.equal(f.frames.filter(p => p.why === 'begin').length, 1)
    assert.equal(f.frames.some(p => p.why === 'chunk'), false)
    assert.equal(f.app.status().ingress.tombstones[0].state, 'abandoned')
    f.app.disconnect(f.socket); assert.equal(f.app.status().state, 'collecting', 'old socket cannot stop replacement review')
  } finally { await f.cleanup() }
})

test('physical socket replacement fences native completion even before the old close callback', async () => {
  const pending = deferred(); const f = helper()
  try {
    await f.start(); f.bodies.set('old', pending.promise); f.complete('old')
    f.replace()
    assert.equal(f.app.status().native.response.discardOnSettlement, true)
    pending.resolve({ body: body([tweet()]), base64Encoded: false })
    await until(() => !f.app.slots.response)
    assert.equal(f.app.status().eligibilityReferences, 0)
    assert.equal(f.frames.some(p => p.why === 'begin'), false)
    assert.equal(f.app.counts.stale_body_discarded, 1)
  } finally { pending.resolve(); await f.cleanup() }
})

test('candidate limits, visible acquisition failures and status expose all provisional bounds', async () => {
  const f = helper()
  try {
    await f.start()
    for (let n = 0; n <= LIMITS.candidates; n++) f.received(`candidate-${n}`)
    assert.equal(f.app.status().candidates, LIMITS.candidates); assert.equal(f.app.counts.candidate_count_pressure, 1)
    f.app.stop(); await tick(); await f.start()
    f.bodies.set('error', Promise.resolve().then(() => { throw Error('PRIVATE_CDP_ERROR') })); f.complete('error')
    await until(() => f.app.counts.response_unavailable === 1)
    for (const [id, result] of [['encoded', { body: 'e30=', base64Encoded: true }], ['clipped', { body: '{}', base64Encoded: false, clipped: true }], ['oversized', { body: 'x'.repeat(LIMITS.responseBytes + 1), base64Encoded: false }]]) {
      f.bodies.set(id, result); f.complete(id); await until(() => !f.app.slots.response)
    }
    const status = f.app.status(); assert.deepEqual(status.limits, LIMITS)
    assert.deepEqual(Object.keys(status.counts).sort(), [...DISPOSITIONS].sort())
    assert.equal(status.counts.response_representation, 1); assert.equal(status.counts.response_clipped, 1); assert.equal(status.counts.response_oversized, 1)
    assert.equal(JSON.stringify(status).includes('PRIVATE_CDP_ERROR'), false)
  } finally { await f.cleanup() }
})
