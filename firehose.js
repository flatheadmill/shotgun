// One disposable Network tap. Object identity is the private generation marker;
// the native body slot and Network transition outlive a stopped/replaced pile.
export const LIMITS = Object.freeze({
  events: 4000, bytes: 8 * 1024 * 1024,
  bodyBytes: 512 * 1024, readBytes: 1024 * 1024,
  readEvents: 100, errorBytes: 1024, urlBytes: 8192
})
export const ENABLE_PARAMS = Object.freeze({ maxPostDataSize: 65536 })

const encoder = new TextEncoder()
const bytes = value => encoder.encode(value).length
const jsonBytes = value => bytes(JSON.stringify(value))
const families = new Set([
  'Network.requestWillBeSent', 'Network.responseReceived',
  'Network.loadingFinished', 'Network.loadingFailed'
])
const pick = (value, keys) => Object.fromEntries(keys
  .filter(key => value[key] !== undefined).map(key => [key, value[key]]))
const response = value => pick(value, [
  'url', 'status', 'statusText', 'mimeType', 'headers', 'protocol',
  'encodedDataLength', 'fromDiskCache', 'fromServiceWorker', 'fromPrefetchCache'
])

function prefix (text, length, base64 = false) {
  if (base64) length -= length % 4
  else if (length > 0 && length < text.length &&
    /[\uD800-\uDBFF]/.test(text[length - 1]) && /[\uDC00-\uDFFF]/.test(text[length])) length--
  return text.slice(0, length)
}

// Search a prefix, without decoding/re-encoding the supplied representation.
function fit (text, accepts, base64 = false) {
  let low = 0; let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (accepts(prefix(text, mid, base64))) low = mid
    else high = mid - 1
  }
  // A sliced string can keep its much larger source alive in the JS engine.
  // Round-trip only the bounded prefix, preserving even lone UTF-16 surrogates.
  return JSON.parse(JSON.stringify(prefix(text, low, base64)))
}

function errorText (error) {
  const text = error instanceof Error ? error.message : String(error)
  return fit(text, value => bytes(value) <= LIMITS.errorBytes)
}

function literal (value) {
  if (value === undefined) return null
  if (typeof value !== 'string' || !value || value.trim() !== value ||
    bytes(value) > LIMITS.urlBytes || /[\u0000-\u0020\u007f\\?#]/.test(value)) throw new Error('url must be a nonempty absolute URL without query or fragment')
  try { new URL(value) } catch { throw new Error('url must be an absolute URL') }
  return value
}

function eventRecord (method, params) {
  const record = { event: method, ...pick(params, [
    'requestId', 'timestamp', 'wallTime', 'loaderId', 'frameId', 'type'
  ]) }
  if (method === 'Network.requestWillBeSent') {
    Object.assign(record, pick(params, ['documentURL', 'initiator']))
    record.request = pick(params.request, ['url', 'method', 'headers', 'postData', 'hasPostData', 'postDataEntries'])
    if (params.redirectResponse) record.redirectResponse = response(params.redirectResponse)
  } else if (method === 'Network.responseReceived') record.response = response(params.response)
  else Object.assign(record, pick(params, ['encodedDataLength', 'errorText', 'canceled', 'blockedReason', 'corsErrorStatus']))
  return record
}

const bodyResult = (run, record) => ({ tabId: run.tabId, record })

export class Firehose {
  constructor ({ attach, command, now = () => new Date().toISOString() }) {
    this.attach = attach
    this.command = command
    this.now = now
    this.current = null
    this.transition = null
    this.bodySlot = null
  }

  async start ({ tabId, url }) {
    if (!Number.isSafeInteger(tabId) || tabId <= 0) throw new Error('start requires an explicit positive tabId')
    const selector = literal(url)
    if (this.current?.state === 'collecting') throw new Error('Firehose is already collecting; stop it before starting again')
    if (this.transition) throw new Error('Network transition is unresolved; read its status before starting again')
    const transition = { tabId, phase: 'attach', cancelled: false }
    this.transition = transition
    try {
      await this.attach(tabId)
      if (this.transition !== transition || transition.cancelled) throw new Error('Firehose start was stopped or detached')
      transition.phase = 'enable'
      await this.command(tabId, 'Network.enable', { ...ENABLE_PARAMS })
    } catch (error) {
      if (this.transition === transition) this.transition = null
      throw error
    }
    if (this.transition !== transition) throw new Error('Firehose start was detached')
    if (transition.cancelled) {
      this.disable(transition)
      throw new Error('Firehose start was stopped')
    }
    // The armed window begins at the enable acknowledgement. Until then reads
    // still address the previous stopped pile; a failed start cannot erase it.
    this.current = {
      marker: {},
      tabId, url: selector, state: 'collecting', startedAt: this.now(), endedAt: null,
      reason: null, events: [], bytes: 0, seen: 0, matched: 0,
      candidates: new Map(), omitted: null, outstandingBody: null
    }
    this.transition = null
    return this.summary()
  }

  disable (transition) {
    transition.phase = 'disable'
    this.transition = transition
    // A rejected disable leaves reporting uncertain. Keep that guard until a
    // confirmed detach/removal; do not silently enable a replacement over it.
    void (async () => {
      try {
        await this.command(transition.tabId, 'Network.disable', {})
        if (this.transition === transition) this.transition = null
      } catch (error) {
        if (this.transition === transition) {
          transition.phase = 'disable_failed'
          transition.error = errorText(error)
        }
      }
    })()
  }

  end (run, state, reason, omitted = null, detached = false) {
    if (run.state !== 'collecting') return
    run.state = state
    run.reason = reason
    run.endedAt = this.now()
    run.omitted = omitted
    run.candidates.clear()
    if (this.bodySlot?.marker === run.marker) {
      run.outstandingBody = { response: this.bodySlot.response, finished: this.bodySlot.finished, outcome: 'discard_on_settlement' }
    }
    if (!detached) this.disable({ tabId: run.tabId })
  }

  stop () {
    if (this.transition && ['attach', 'enable'].includes(this.transition.phase)) this.transition.cancelled = true
    if (this.current) this.end(this.current, 'stopped', 'stop')
    return this.summary()
  }

  detached (tabId, reason = 'debugger_detached') {
    if (this.transition?.tabId === tabId) this.transition = null
    if (this.current?.tabId === tabId) this.end(this.current, 'stopped', reason, null, true)
    // The old native body's promise still owns the global slot until settlement.
  }

  append (run, record) {
    if (this.current !== run || run.state !== 'collecting') return null
    record = { index: run.events.length, ...record }
    const size = jsonBytes(record)
    // Leave room for the inventory's bounded control header. An event too large
    // to inspect even alone closes the tap instead of becoming unreadable data.
    const reason = run.events.length >= LIMITS.events ? 'event_limit'
      : run.bytes + size > LIMITS.bytes ? 'byte_limit'
        : size > LIMITS.readBytes - 32 * 1024 ? 'read_limit' : null
    if (reason) {
      const omitted = { event: record.event, outcome: 'not_retained' }
      if (record.event === 'body') Object.assign(omitted, pick(record, ['response', 'finished']))
      this.end(run, 'full', reason, omitted)
      return null
    }
    run.events.push(record)
    run.bytes += size
    if (run.events.length === LIMITS.events || run.bytes === LIMITS.bytes) {
      this.end(run, 'full', run.events.length === LIMITS.events ? 'event_limit' : 'byte_limit')
    }
    return record
  }

  onEvent (tabId, method, params) {
    const run = this.current
    if (!run || run.state !== 'collecting' || run.tabId !== tabId || !families.has(method)) return
    run.seen++
    const selected = method === 'Network.responseReceived' &&
      (run.url === null || params.response.url.split(/[?#]/, 1)[0] === run.url)
    if (selected) run.matched++
    const record = this.append(run, eventRecord(method, params))
    if (!record || run.state !== 'collecting') return
    const id = params.requestId
    if (method === 'Network.responseReceived') {
      run.candidates.delete(id)
      if (selected) run.candidates.set(id, record.index)
    } else if (method === 'Network.loadingFailed' || (method === 'Network.requestWillBeSent' && params.redirectResponse)) {
      run.candidates.delete(id)
    } else if (method === 'Network.loadingFinished' && run.candidates.has(id)) {
      const response = run.candidates.get(id)
      run.candidates.delete(id)
      const outcome = { event: 'body', requestId: id, response, finished: record.index }
      if (this.bodySlot) this.append(run, { ...outcome, outcome: 'busy' })
      else {
        // The native command owns only a marker, not the old pile's data. A
        // replacement can release the old evidence even if this call is held.
        const slot = { marker: run.marker, tabId: run.tabId, ...outcome }
        this.bodySlot = slot
        void this.collectBody(slot)
      }
    }
  }

  async collectBody (slot) {
    const { tabId, requestId, response, finished } = slot
    try {
      let result; let error; let failed = false
      try { result = await this.command(tabId, 'Network.getResponseBody', { requestId }) } catch (e) { error = e; failed = true }
      if (this.bodySlot === slot) this.bodySlot = null
      const run = this.current
      if (!run || run.marker !== slot.marker || run.state !== 'collecting') return
      const record = { index: run.events.length, event: 'body', requestId, response, finished }
      if (failed || typeof result?.body !== 'string' || typeof result?.base64Encoded !== 'boolean') {
        this.append(run, { ...record, outcome: 'unavailable', error: errorText(failed ? error : 'Invalid response-body result from Chrome') })
        return
      }
      const returnedBytes = bytes(result.body)
      const make = body => ({ ...record, outcome: 'retained', body, base64Encoded: result.base64Encoded,
        returnedBytes, retainedBytes: bytes(body), clipped: body.length < result.body.length })
      const candidate = prefix(result.body, Math.min(result.body.length, LIMITS.bodyBytes), result.base64Encoded)
      const body = fit(candidate, body => bytes(body) <= LIMITS.bodyBytes &&
        jsonBytes(bodyResult(run, make(body))) <= LIMITS.readBytes - 32 * 1024, result.base64Encoded)
      this.append(run, make(body))
    } finally {
      if (this.bodySlot === slot) this.bodySlot = null
    }
  }

  summary () {
    const run = this.current
    return {
      hasCapture: Boolean(run), state: run?.state ?? 'stopped', tabId: run?.tabId ?? null, url: run?.url ?? null,
      startedAt: run?.startedAt ?? null, endedAt: run?.endedAt ?? null, reason: run?.reason ?? null,
      seen: run?.seen ?? 0, matched: run?.matched ?? 0, events: run?.events.length ?? 0, bytes: run?.bytes ?? 0,
      omitted: run?.omitted ?? null, outstandingBodyAtStop: run?.outstandingBody ?? null,
      bodyCommandInFlight: Boolean(this.bodySlot),
      network: this.transition ? { tabId: this.transition.tabId, pending: this.transition.phase !== 'disable_failed',
        error: this.transition.error ?? null } : { pending: false, error: null },
      limits: LIMITS, networkEnable: ENABLE_PARAMS
    }
  }

  read (args = {}) {
    const { from = 0, limit = 50, body } = args
    const run = this.current
    if (body !== undefined) {
      if (args.from !== undefined || args.limit !== undefined) throw new Error('read takes either a body position or an inventory slice')
      if (!Number.isSafeInteger(body) || body < 0 || run?.events[body]?.event !== 'body') throw new Error('body must name a body-outcome pile position')
      return bodyResult(run, run.events[body])
    }
    if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > LIMITS.readEvents) {
      throw new Error(`read requires from >= 0 and limit between 1 and ${LIMITS.readEvents}`)
    }
    const result = { ...this.summary(), from, records: [], next: from }
    for (const record of (run?.events ?? []).slice(from, from + limit)) {
      const { body: omittedBody, ...inventory } = record
      result.records.push(inventory)
      result.next = record.index + 1
      if (jsonBytes(result) > LIMITS.readBytes) {
        result.records.pop()
        result.next = record.index
        break
      }
    }
    return result
  }
}
