// One explicitly armed passive review. Canonical extraction belongs to the
// filesystem companion; this parser only learns photo/poster eligibility.
import { LIMITS as INGRESS, IngressError, sha256, utf8Size } from './companion-ingress.js'

export const LIMITS = Object.freeze({
  responseBytes: INGRESS.responseBytes, imageBytes: INGRESS.imageBytes,
  nativeCommandsPerKind: 1, candidates: 128, candidateBytes: 256 * 1024,
  candidateMetadataBytes: 4096, eligibilityReferences: 256, eligibilityBytes: 128 * 1024,
  responseWaiting: 2, responseWaitingBytes: 16 * 1024,
  imageWaiting: 64, imageWaitingBytes: 128 * 1024,
  responseWorkBytes: 4 * 1024 * 1024, imageWorkBytes: 16 * 1024 * 1024,
  totalWorkBytes: 20 * 1024 * 1024,
  urlBytes: 1024, urlInputBytes: 8192, idBytes: 128, instructions: 8, entries: 128, mediaPerPost: 8,
  statusBytes: 64 * 1024
})
export const ENABLE_PARAMS = Object.freeze({ maxPostDataSize: 0 })
export const DISPOSITIONS = Object.freeze([
  'events_seen', 'candidate_count_pressure', 'candidate_byte_pressure', 'candidate_metadata_limit',
  'candidate_retired', 'response_without_metadata', 'image_not_eligible_at_completion',
  'response_waiting_pressure', 'image_waiting_pressure', 'stop_candidates_discarded', 'stop_waiting_discarded',
  'response_unavailable', 'image_unavailable', 'response_representation', 'image_representation',
  'response_clipped', 'image_clipped', 'response_oversized', 'image_oversized', 'image_base64_invalid',
  'response_retained', 'image_retained', 'response_hash_failed', 'image_hash_failed', 'stale_body_discarded',
  'manifest_limit', 'ingress_admission_failed', 'eligibility_invalid_json', 'eligibility_root_unknown',
  'graphql_errors', 'instruction_unknown', 'entry_unknown', 'result_unknown', 'identity_unknown',
  'media_unknown', 'descriptor_unsupported', 'instruction_limit', 'entry_limit', 'media_limit',
  'eligibility_count_pressure', 'eligibility_byte_pressure', 'eligibility_duplicate'
])
const encoder = new TextEncoder()
const sized = value => utf8Size(JSON.stringify(value))
const fail = code => { throw new IngressError(code) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const count = (counts, key, n = 1) => { counts[key] = Math.min(Number.MAX_SAFE_INTEGER, (counts[key] ?? 0) + n) }
function parsedUrl (text) {
  if (typeof text !== 'string' || text.length > LIMITS.urlInputBytes || utf8Size(text) > LIMITS.urlInputBytes) return null
  try { return new URL(text) } catch { return null }
}
export function bookmarks (text) {
  const url = parsedUrl(text)
  if (!url || url.origin !== 'https://x.com') return null
  const match = /^\/i\/api\/graphql\/([^/]+)\/Bookmarks$/.exec(url.pathname)
  if (!match || utf8Size(url.origin + url.pathname) > LIMITS.urlBytes || utf8Size(match[1]) > LIMITS.idBytes) return null
  return { url: url.origin + url.pathname, hash: match[1] }
}
export function asset (text, descriptor = false) {
  const url = parsedUrl(text)
  if (!url || url.origin !== 'https://pbs.twimg.com' || url.username || url.password || url.hash || utf8Size(text) > LIMITS.urlBytes) return null
  let path = url.pathname
  if (descriptor) {
    if (!/\.(jpg|png)$/.test(path)) return null
    path = path.replace(/\.(jpg|png)$/, '')
  } else if (!['jpg', 'png'].includes(url.searchParams.get('format')) || /\.[^/]+$/.test(path)) return null
  // These are the observed photo/poster path families, never video variants or
  // profile images. No URL is manufactured from this comparison key.
  if (!/^\/(media|ext_tw_video_thumb|amplify_video_thumb)\/[^/]/.test(path)) return null
  return url.origin + path
}
export function eligibleMedia (text) {
  const references = []; const counts = {}; let referenceBytes = 0
  let body
  try { body = JSON.parse(text) } catch { return { references, counts: { eligibility_invalid_json: 1 } } }
  if (Array.isArray(body?.errors) && body.errors.length) count(counts, 'graphql_errors')
  const instructions = body?.data?.bookmark_timeline_v2?.timeline?.instructions
  if (!Array.isArray(instructions)) return { references, counts: { ...counts, eligibility_root_unknown: 1 } }
  if (instructions.length > LIMITS.instructions) count(counts, 'instruction_limit')
  let remaining = LIMITS.entries
  const visit = (result, quote = false) => {
    if (result?.__typename === 'TweetWithVisibilityResults') result = result.tweet
    if (result?.__typename !== 'Tweet') { count(counts, 'result_unknown'); return }
    const postId = result.rest_id
    if (typeof postId !== 'string' || !/^\d{1,32}$/.test(postId) || (result.legacy?.id_str !== undefined && result.legacy.id_str !== postId)) { count(counts, 'identity_unknown'); return }
    const media = result.legacy?.extended_entities?.media
    if (Array.isArray(media)) {
      if (media.length > LIMITS.mediaPerPost) count(counts, 'media_limit')
      for (const item of media.slice(0, LIMITS.mediaPerPost)) {
        if (!['photo', 'video', 'animated_gif'].includes(item?.type)) { count(counts, 'media_unknown'); continue }
        const descriptor = item.media_url_https
        const key = asset(descriptor, true)
        if (!key) { count(counts, 'descriptor_unsupported'); continue }
        const reference = { key, post_id: postId, media_type: item.type, descriptor_url: descriptor, quote }
        const bytes = sized(reference)
        if (references.length >= LIMITS.eligibilityReferences) { count(counts, 'eligibility_count_pressure'); continue }
        if (referenceBytes + bytes > LIMITS.eligibilityBytes) { count(counts, 'eligibility_byte_pressure'); continue }
        references.push(reference); referenceBytes += bytes
      }
    }
    if (!quote && result.quoted_status_result?.result) visit(result.quoted_status_result.result, true)
  }
  for (const instruction of instructions.slice(0, LIMITS.instructions)) {
    if (instruction?.type !== 'TimelineAddEntries' || !Array.isArray(instruction.entries)) { count(counts, 'instruction_unknown'); continue }
    if (instruction.entries.length > remaining) count(counts, 'entry_limit')
    for (const entry of instruction.entries.slice(0, remaining)) {
      remaining--
      if (entry?.content?.entryType === 'TimelineTimelineCursor') continue
      if (entry?.content?.entryType !== 'TimelineTimelineItem') { count(counts, 'entry_unknown'); continue }
      visit(entry.content.itemContent?.tweet_results?.result)
    }
  }
  return { references, counts }
}
export function responseBytes (result) {
  if (result?.clipped || result?.retainedBytes !== undefined && result.retainedBytes !== result.returnedBytes) fail('response_clipped')
  if (result?.base64Encoded !== false || typeof result?.body !== 'string') fail('response_representation')
  if (result.body.length > LIMITS.responseBytes) fail('response_oversized')
  const bytes = encoder.encode(result.body)
  if (bytes.length > LIMITS.responseBytes) fail('response_oversized')
  return bytes
}
export function imageBytes (result) {
  if (result?.clipped || result?.retainedBytes !== undefined && result.retainedBytes !== result.returnedBytes) fail('image_clipped')
  if (result?.base64Encoded !== true || typeof result?.body !== 'string') fail('image_representation')
  const data = result.body
  if (data.length > Math.ceil(LIMITS.imageBytes / 3) * 4) fail('image_oversized')
  if (!data.length || data.length % 4) fail('image_base64_invalid')
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let last = 0
  for (let i = 0; i < data.length - padding; i++) { last = alphabet.indexOf(data[i]); if (last < 0) fail('image_base64_invalid') }
  if (padding === 2 && last & 15 || padding === 1 && last & 3) fail('image_base64_invalid')
  const length = data.length / 4 * 3 - padding
  if (length > LIMITS.imageBytes) fail('image_oversized')
  const binary = atob(data)
  return Uint8Array.from(binary, c => c.charCodeAt(0))
}
function scalar (value, limit = LIMITS.idBytes) {
  if (typeof value === 'string' && utf8Size(value) <= limit) return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'boolean') return value
  return undefined
}
function identity (url) {
  const response = bookmarks(url)
  if (response) return { kind: 'response', url: response.url, operation_hash: response.hash }
  const key = asset(url)
  return key ? { kind: 'image', url, key } : null
}

export class Socialite {
  constructor ({ ingress, attach, command, getTab, socket, firehoseBusy, hash = sha256, now = () => new Date().toISOString() }) {
    Object.assign(this, { ingress, attach, command, getTab, socket, firehoseBusy, hash, now })
    this.current = null; this.transition = null
    this.slots = { response: null, image: null }
    this.counts = Object.fromEntries(DISPOSITIONS.map(key => [key, 0]))
    ingress.onChange = () => { this.pump('response'); this.pump('image') }
  }
  get ownsNetwork () { return Boolean(this.transition) || this.current?.state === 'collecting' }
  valid (run) { return Boolean(run) && this.current === run && run.state === 'collecting' && run.socket === this.socket() && run.socket.readyState === 1 }
  async start ({ tabId }, socket) {
    if (!Number.isSafeInteger(tabId) || tabId <= 0) fail('explicit_tab_required')
    if (this.ownsNetwork) fail('network_owned')
    if (this.firehoseBusy()) fail('firehose_busy')
    if (this.ingress.unresolved) fail('unresolved_operations')
    if (socket !== this.socket() || socket?.readyState !== 1) fail('connection_unavailable')
    const transition = { tabId, socket, phase: 'checking_tab', cancelled: false }
    this.transition = transition
    const live = () => { if (this.transition !== transition || transition.cancelled || socket !== this.socket() || socket.readyState !== 1) fail('start_cancelled') }
    let url
    try {
      url = (await this.getTab(tabId))?.url; live()
      if (parsedUrl(url)?.origin !== 'https://x.com' || utf8Size(url) > LIMITS.urlBytes) fail('explicit_x_tab_required')
      transition.phase = 'probe'; await this.ingress.probe(socket); live()
      transition.phase = 'attach'; await this.attach(tabId); live()
      transition.phase = 'enable'; await this.command(tabId, 'Network.enable', { ...ENABLE_PARAMS })
    } catch (error) {
      if (this.transition === transition) this.transition = null
      throw error instanceof IngressError ? error : new IngressError('start_failed')
    }
    if (this.transition !== transition) fail('start_cancelled')
    if (transition.cancelled || socket !== this.socket() || socket.readyState !== 1) { this.disable(transition); fail('start_cancelled') }
    this.current = { marker: {}, id: crypto.randomUUID(), tabId, socket, url, state: 'collecting', startedAt: this.now(), endedAt: null, reason: null,
      candidates: new Map(), candidateBytes: 0, eligibility: new Map(), eligibilityBytes: 0,
      waiting: { response: [], image: [] }, waitingBytes: { response: 0, image: 0 } }
    this.transition = null
    return this.status()
  }
  disable (transition) {
    transition.phase = 'disable'; this.transition = transition
    void (async () => {
      try { await this.command(transition.tabId, 'Network.disable', {}); if (this.transition === transition) this.transition = null } catch {
        if (this.transition === transition) transition.phase = 'disable_failed'
      }
    })()
  }
  stop (reason = 'operator_stop', detached = false) {
    if (this.transition && !['disable', 'disable_failed'].includes(this.transition.phase)) this.transition.cancelled = true
    const run = this.current
    if (run?.state === 'collecting') {
      run.state = 'stopped'; run.reason = reason; run.endedAt = this.now()
      count(this.counts, 'stop_candidates_discarded', run.candidates.size)
      count(this.counts, 'stop_waiting_discarded', run.waiting.response.length + run.waiting.image.length)
      run.candidates.clear(); run.candidateBytes = 0; run.eligibility.clear(); run.eligibilityBytes = 0
      run.waiting = { response: [], image: [] }; run.waitingBytes = { response: 0, image: 0 }
      if (!detached) this.disable({ tabId: run.tabId, socket: run.socket })
    }
    return this.status()
  }
  detached (tabId, reason = 'debugger_detached') {
    if (this.transition?.tabId === tabId) this.transition = null
    if (this.current?.tabId === tabId && this.current.state === 'collecting') this.stop(reason, true)
  }
  navigation (tabId, url) {
    if (typeof url !== 'string' || parsedUrl(url)?.origin === 'https://x.com') return
    if (this.transition?.tabId === tabId || this.current?.tabId === tabId && this.current.state === 'collecting') this.stop('left_x')
  }
  disconnect (socket) {
    this.ingress.disconnect(socket)
    if (this.transition?.socket === socket || this.current?.socket === socket && this.current.state === 'collecting') this.stop('socket_disconnected')
  }
  removeCandidate (run, id) {
    const candidate = run.candidates.get(id)
    if (candidate) { run.candidates.delete(id); run.candidateBytes -= candidate.size }
    return candidate
  }
  onEvent (tabId, method, params) {
    const run = this.current
    if (!this.valid(run) || run.tabId !== tabId || !['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed'].includes(method)) return
    count(this.counts, 'events_seen')
    const id = params?.requestId
    if (typeof id !== 'string' || utf8Size(id) > LIMITS.idBytes) { count(this.counts, 'candidate_metadata_limit'); return }
    if (method === 'Network.loadingFailed' || method === 'Network.requestWillBeSent' && params.redirectResponse) {
      if (this.removeCandidate(run, id)) count(this.counts, 'candidate_retired')
      if (method === 'Network.loadingFailed') return
    }
    if (method === 'Network.requestWillBeSent' || method === 'Network.responseReceived') {
      const source = method === 'Network.requestWillBeSent' ? params.request : params.response
      const selected = identity(source?.url)
      const previous = this.removeCandidate(run, id)
      if (!selected || selected.kind === 'image' && method === 'Network.responseReceived' && !String(source?.mimeType ?? '').startsWith('image/')) return
      const candidate = { ...selected, request_id: id, ...(previous?.kind === selected.kind ? previous : {}), ...selected }
      if (method === 'Network.requestWillBeSent') Object.assign(candidate, { request_seen: true, request_url: selected.url, request_method: scalar(source.method), request_timestamp: scalar(params.timestamp), frame_id: scalar(params.frameId), loader_id: scalar(params.loaderId) })
      else {
        candidate.response_seen = true; candidate.response_timestamp = scalar(params.timestamp)
        for (const [key, value] of Object.entries({ response_url: selected.url, status: source.status, mime_type: source.mimeType, from_disk_cache: source.fromDiskCache, from_service_worker: source.fromServiceWorker, from_prefetch_cache: source.fromPrefetchCache })) candidate[key] = scalar(value, key === 'response_url' ? LIMITS.urlBytes : LIMITS.idBytes)
      }
      delete candidate.size; candidate.size = sized(candidate)
      if (candidate.size > LIMITS.candidateMetadataBytes) count(this.counts, 'candidate_metadata_limit')
      else if (run.candidates.size >= LIMITS.candidates) count(this.counts, 'candidate_count_pressure')
      else if (run.candidateBytes + candidate.size > LIMITS.candidateBytes) count(this.counts, 'candidate_byte_pressure')
      else { run.candidates.set(id, candidate); run.candidateBytes += candidate.size }
    } else if (method === 'Network.loadingFinished') {
      const candidate = this.removeCandidate(run, id)
      if (!candidate) return
      if (!candidate.response_seen) { count(this.counts, 'response_without_metadata'); return }
      if (candidate.kind === 'image') {
        const reference = run.eligibility.get(candidate.key)
        if (!reference) { count(this.counts, 'image_not_eligible_at_completion'); return }
        candidate.eligibility = reference
      }
      candidate.completed_timestamp = scalar(params.timestamp); candidate.encoded_data_length = scalar(params.encodedDataLength)
      const kind = candidate.kind; candidate.size = sized(candidate)
      if (run.waiting[kind].length >= LIMITS[`${kind}Waiting`] || run.waitingBytes[kind] + candidate.size > LIMITS[`${kind}WaitingBytes`]) { count(this.counts, `${kind}_waiting_pressure`); return }
      run.waiting[kind].push(candidate); run.waitingBytes[kind] += candidate.size
      this.pump(kind)
    }
  }
  pump (kind) {
    const run = this.current
    if (!this.valid(run) || this.slots[kind] || !this.ingress.canAccept(kind) || !run.waiting[kind].length) return
    if (run.socket !== this.socket() || run.socket.readyState !== 1) { this.stop('socket_replaced'); return }
    const candidate = run.waiting[kind].shift(); run.waitingBytes[kind] -= candidate.size
    const slot = { run, candidate, operation: crypto.randomUUID(), phase: 'body', workBytes: LIMITS[`${kind}WorkBytes`] }
    if (Object.values(this.slots).reduce((n, s) => n + (s?.workBytes ?? 0), 0) + slot.workBytes > LIMITS.totalWorkBytes) throw new Error('invalid Socialite work reservation constants')
    this.slots[kind] = slot
    void this.collect(slot)
  }
  async collect (slot) {
    const { run, candidate, operation } = slot; const kind = candidate.kind
    try {
      let result
      try { result = await this.command(run.tabId, 'Network.getResponseBody', { requestId: candidate.request_id }) } catch { count(this.counts, this.valid(run) ? `${kind}_unavailable` : 'stale_body_discarded'); return }
      if (!this.valid(run)) { count(this.counts, 'stale_body_discarded'); return }
      let bytes
      try { bytes = kind === 'response' ? responseBytes(result) : imageBytes(result) } catch (error) { count(this.counts, error instanceof IngressError && DISPOSITIONS.includes(error.code) ? error.code : `${kind}_representation`); return }
      if (kind === 'response') {
        const parsed = eligibleMedia(result.body)
        for (const [key, n] of Object.entries(parsed.counts)) count(this.counts, key, n)
        for (const reference of parsed.references) {
          if (run.eligibility.has(reference.key)) { count(this.counts, 'eligibility_duplicate'); continue }
          const entry = Object.freeze({ ...reference, parent_operation_id: operation }); const size = sized(entry)
          if (run.eligibility.size >= LIMITS.eligibilityReferences) count(this.counts, 'eligibility_count_pressure')
          else if (run.eligibilityBytes + size > LIMITS.eligibilityBytes) count(this.counts, 'eligibility_byte_pressure')
          else { run.eligibility.set(reference.key, entry); run.eligibilityBytes += size }
        }
      }
      slot.phase = 'hash'
      let digest
      try { digest = await this.hash(bytes) } catch { count(this.counts, this.valid(run) ? `${kind}_hash_failed` : 'stale_body_discarded'); return }
      if (!this.valid(run)) { count(this.counts, 'stale_body_discarded'); return }
      const { size, key, url, response_seen, kind: omittedKind, ...facts } = candidate
      const provenance = { review_id: run.id, review_started_at: run.startedAt, tab_id: run.tabId, armed_page_url: run.url, observed_at: this.now(),
        cdp_base64_encoded: result.base64Encoded, request_seen: Boolean(candidate.request_seen), ...facts,
        ...(candidate.eligibility ? { parent_operation_id: candidate.eligibility.parent_operation_id } : {}) }
      const manifest = { version: 1, kind, bytes: bytes.length, sha256: digest, provenance }
      if (sized(manifest) > INGRESS.manifestBytes) { count(this.counts, 'manifest_limit'); return }
      try { this.ingress.retain({ operation_id: operation, bytes, manifest, review_id: run.id }, run.socket); count(this.counts, `${kind}_retained`) } catch { count(this.counts, 'ingress_admission_failed') }
    } finally {
      if (this.slots[kind] === slot) this.slots[kind] = null
      this.pump(kind)
    }
  }
  status () {
    const run = this.current
    return { state: run?.state ?? 'stopped', review_id: run?.id ?? null, tabId: run?.tabId ?? null, startedAt: run?.startedAt ?? null, endedAt: run?.endedAt ?? null,
      reason: run?.reason ?? null, network: this.transition?.phase ?? 'idle', limits: LIMITS, networkEnable: ENABLE_PARAMS, counts: { ...this.counts },
      candidates: run?.candidates.size ?? 0, candidateBytes: run?.candidateBytes ?? 0, eligibilityReferences: run?.eligibility.size ?? 0, eligibilityBytes: run?.eligibilityBytes ?? 0,
      waiting: Object.fromEntries(['response', 'image'].map(kind => [kind, { descriptors: run?.waiting[kind].length ?? 0, bytes: run?.waitingBytes[kind] ?? 0 }])),
      native: Object.fromEntries(['response', 'image'].map(kind => [kind, this.slots[kind] ? { phase: this.slots[kind].phase, discardOnSettlement: !this.valid(this.slots[kind].run), reservedWorkBytes: this.slots[kind].workBytes } : null])),
      workBytesReserved: Object.values(this.slots).reduce((n, s) => n + (s?.workBytes ?? 0), 0), ingress: this.ingress.status() }
  }
}
