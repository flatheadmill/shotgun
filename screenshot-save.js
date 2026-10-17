// Screenshot-specific producer. No filesystem, browser spool, raw-wire logging,
// or publication assertions. The extension supplies capture and socket ownership.
export const LIMITS = Object.freeze({
  pngBytes: 32 * 1024 * 1024, chunkBytes: 64 * 1024,
  totalBytes: 64 * 1024 * 1024, operations: 4,
  dimension: 32768, pixels: 64 * 1024 * 1024, packetBytes: 96 * 1024
})

const encoder = new TextEncoder()
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const size = value => encoder.encode(value).length
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
const same = (a, b) => object(a) && object(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => a[key] === b[key])
const fail = reason => { throw new Error(reason) }
function path (value) {
  return typeof value === 'string' && value.startsWith('/') && !value.endsWith('/') &&
    !value.includes('\0') && !value.split('/').some(part => part === '.' || part === '..') && size(value) <= 4096
}
function dimensions (width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
    width > LIMITS.dimension || height > LIMITS.dimension || width * height > LIMITS.pixels) fail('PNG dimensions exceed limits')
}
async function sha256 (bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
}
function intentValid (value) {
  return keys(value, ['destination', 'bytes', 'sha256', 'mode', 'source_url', 'captured_at']) && path(value.destination) &&
    Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= LIMITS.pngBytes && hex(value.sha256) &&
    ['viewport', 'full_page'].includes(value.mode) && typeof value.source_url === 'string' && size(value.source_url) <= 8192 &&
    typeof value.captured_at === 'string' && size(value.captured_at) <= 128 && size(JSON.stringify(value)) <= 16384
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0)
  return n >>> 0
})
function crc (bytes, start, end) {
  let c = 0xffffffff
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function decodedLength (data) {
  if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0 ||
    data.length > Math.ceil(LIMITS.pngBytes / 3) * 4) fail('PNG base64 exceeds limits or is invalid')
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let last = 0
  for (let i = 0; i < data.length - padding; i++) {
    last = alphabet.indexOf(data[i])
    if (last < 0) fail('invalid PNG base64')
  }
  if ((padding === 2 && (last & 15)) || (padding === 1 && (last & 3))) fail('noncanonical PNG base64')
  const length = data.length / 4 * 3 - padding
  if (length > LIMITS.pngBytes) fail('PNG bytes exceed limit')
  return length
}

export async function decodePng (data) {
  const length = decodedLength(data)
  const binary = atob(data)
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0))
  if (bytes.length !== length || length < 45 || ![137, 80, 78, 71, 13, 10, 26, 10].every((b, n) => bytes[n] === b)) fail('invalid PNG signature')
  const view = new DataView(bytes.buffer)
  let offset = 8; let width; let height; let image = false; let ended = false
  while (offset + 12 <= length) {
    const count = view.getUint32(offset)
    const end = offset + count + 12
    if (end > length) fail('truncated PNG chunk')
    const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    if (crc(bytes, offset + 4, end - 4) !== view.getUint32(end - 4)) fail('PNG checksum mismatch')
    if (offset === 8) {
      if (name !== 'IHDR' || count !== 13) fail('invalid PNG header')
      width = view.getUint32(offset + 8); height = view.getUint32(offset + 12)
      dimensions(width, height)
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
      if (!depths[bytes[offset + 17]]?.includes(bytes[offset + 16]) || bytes[offset + 18] !== 0 ||
        bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) fail('unsupported PNG header')
    } else if (name === 'IHDR') fail('duplicate PNG header')
    if (name === 'acTL') fail('animated PNG is not a screenshot')
    if (name === 'IDAT') image = true
    if (name === 'IEND') {
      if (count !== 0 || end !== length || !image) fail('invalid PNG end')
      ended = true; break
    }
    offset = end
  }
  if (!ended) fail('PNG has no complete end')
  return { bytes, sha256: await sha256(bytes), pixel_width: width, pixel_height: height }
}

export function encodeChunk (bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > LIMITS.chunkBytes) fail('invalid screenshot chunk size')
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 4096) binary += String.fromCharCode(...bytes.subarray(offset, offset + 4096))
  return btoa(binary)
}

export function capturePlan (mode, metrics, dpr) {
  if (!['viewport', 'full_page'].includes(mode) || !Number.isFinite(dpr) || dpr <= 0) fail('invalid capture metrics')
  const viewport = metrics?.cssVisualViewport
  const content = metrics?.cssContentSize
  const rect = mode === 'viewport' ? { width: viewport?.clientWidth, height: viewport?.clientHeight } : content
  // A conservative allocation preflight, not a rule for CDP output scaling.
  // Actual PNG dimensions are authoritative. Never multiply clip.scale by DPR.
  dimensions(Math.ceil(rect?.width), Math.ceil(rect?.height))
  dimensions(Math.ceil(rect.width * Math.max(1, dpr)), Math.ceil(rect.height * Math.max(1, dpr)))
  const params = { format: 'png', fromSurface: true, captureBeyondViewport: mode === 'full_page' }
  if (mode === 'full_page') {
    // CDP Viewport uses DIPs; cssContentSize uses CSS pixels. The measured
    // browser zoom converts between them, independently of DPR/pinch scale.
    // https://chromedevtools.github.io/devtools-protocol/tot/Page/#type-Viewport
    const zoom = viewport?.zoom
    if (!Number.isFinite(zoom) || zoom <= 0) fail('missing or invalid browser zoom')
    if (!Number.isFinite(content.x) || !Number.isFinite(content.y) ||
      !Number.isFinite(content.x * zoom) || !Number.isFinite(content.y * zoom)) fail('invalid content origin')
    params.clip = { x: content.x * zoom, y: content.y * zoom, width: content.width * zoom, height: content.height * zoom, scale: 1 }
    dimensions(Math.ceil(params.clip.width), Math.ceil(params.clip.height))
  }
  return params
}

export async function resolveSaveTab (tabId, slug, getContext, activeTabs) {
  if (tabId !== undefined) {
    if (!Number.isSafeInteger(tabId) || tabId <= 0) fail('invalid tabId')
    return tabId
  }
  const context = await getContext(slug)
  if (context?.currentTabId) return context.currentTabId
  const [tab] = await activeTabs()
  if (!tab?.id) fail('no tab to capture')
  return tab.id
}

export async function validateReceipt (receipt, why, args, local) {
  const reject = () => fail('Wicket receipt does not match the screenshot operation')
  if (!keys(receipt, ['operation', 'attempt', 'event_id', 'requested', 'destination', 'verified', 'accepted_at', 'observed_at', 'outcome']) ||
    !same(receipt.operation, { slug: args.slug, caller: 'shotgun', operation_id: args.operation_id }) ||
    !keys(receipt.attempt, ['call_id', 'attempt_id']) || !id(receipt.attempt.call_id) || !id(receipt.attempt.attempt_id) ||
    !intentValid(receipt.requested) || !path(receipt.destination) ||
    receipt.destination.split('/').at(-1) !== receipt.requested.destination.split('/').at(-1) ||
    (args.destination !== undefined && receipt.requested.destination !== args.destination) ||
    (args.mode !== undefined && receipt.requested.mode !== args.mode) ||
    (local?.intent && !same(receipt.requested, local.intent)) ||
    typeof receipt.observed_at !== 'string' || !Number.isFinite(Date.parse(receipt.observed_at))) reject()
  const key = await sha256(encoder.encode(args.slug + '\0' + args.operation_id))
  if (receipt.accepted_at === null) {
    const temporary = new RegExp(`^\\.wicket-screenshot-${key}-[0-9a-f]{32}\\.stage-[0-9]+-temporary$`)
    if (!temporary.test(receipt.event_id) || !['failed', 'aborted'].includes(why)) reject()
  } else if (typeof receipt.accepted_at !== 'string' || !Number.isFinite(Date.parse(receipt.accepted_at)) || receipt.event_id !== `screenshot-${key}-terminal`) reject()
  const outcome = receipt.outcome
  if ((why === 'stored' && outcome !== 'stored') || (why === 'aborted' && outcome !== 'aborted') ||
    (why === 'published' && (!keys(outcome, ['published_durability_unconfirmed']) ||
      !keys(outcome.published_durability_unconfirmed, ['reason']) || typeof outcome.published_durability_unconfirmed.reason !== 'string')) ||
    (why === 'failed' && (!keys(outcome, ['failed']) || !keys(outcome.failed, ['action', 'reason']) ||
      typeof outcome.failed.action !== 'string' || typeof outcome.failed.reason !== 'string'))) reject()
  const verified = receipt.verified
  if (verified !== null) {
    if (!keys(verified, ['mime_type', 'bytes', 'sha256', 'pixel_width', 'pixel_height']) || verified.mime_type !== 'image/png' ||
      verified.bytes !== receipt.requested.bytes || verified.sha256 !== receipt.requested.sha256 ||
      (local?.bytes && (verified.pixel_width !== local.pixel_width || verified.pixel_height !== local.pixel_height))) reject()
    dimensions(verified.pixel_width, verified.pixel_height)
  } else if (why === 'stored' || why === 'published' || receipt.accepted_at !== null) reject()
  if (!['stored', 'published', 'failed', 'aborted'].includes(why)) reject()
}

function validateCall (args) {
  if (!id(args.call_id) || !id(args.slug) || !id(args.operation_id)) fail('screenshot_save requires valid call, slug and caller-known operation_id')
  if (!['capture', 'retry', 'status', 'abandon'].includes(args.action)) fail('screenshot_save requires action capture, retry, status or abandon')
  if (args.where !== undefined && args.where !== 'localhost') fail('screenshot_save supports only localhost')
  if (args.destination !== undefined && !path(args.destination)) fail('destination must be absolute without dot components')
  if (args.mode !== undefined && !['viewport', 'full_page'].includes(args.mode)) fail('invalid screenshot mode')
  if (args.tabId !== undefined && (!Number.isSafeInteger(args.tabId) || args.tabId <= 0)) fail('invalid tabId')
  if (args.action === 'capture' && (args.destination === undefined || args.mode === undefined)) fail('capture requires destination and mode')
}
const terminal = why => ['stored', 'published', 'failed', 'aborted'].includes(why)
const disposition = why => terminal(why) || ['unknown', 'receiving', 'rejected', 'unresolved', 'abandoned'].includes(why)

export class ScreenshotSaver {
  constructor ({ send, capture, observe = () => {}, timeout = 25000 }) {
    this.send = send; this.capture = capture; this.observe = observe; this.timeout = timeout
    this.operations = new Map(); this.calls = new Map()
  }

  get retainedBytes () {
    let total = 0
    for (const op of this.operations.values()) total += op.bytes?.length ?? op.reservation ?? 0
    return total
  }

  release (key) {
    const op = this.operations.get(key)
    if (op?.reservation) op.discard = true
    else this.operations.delete(key)
  }

  note (ctx, what, reason) {
    this.observe({ who: 'screenshot', what, why: reason, how: 'cdp / screenshot_save',
      with: { call_id: ctx.args.call_id, operation_id: ctx.args.operation_id, attempt_id: ctx.attempt, slug: ctx.args.slug } })
  }

  packet (ctx, why, fields = {}) {
    return { what: 'screenshot_save', why, call_id: ctx.args.call_id, operation_id: ctx.args.operation_id, attempt_id: ctx.attempt, ...fields }
  }

  // Replies are received only on the socket that owned the dispatched call.
  // Unknown/retired calls and sockets cannot alter a current waiter.
  receive (packet, socket) {
    const ctx = this.calls.get(packet?.call_id)
    if (!ctx || ctx.socket !== socket || ctx.stopped) return false
    if (packet?.what !== 'screenshot_save' || packet.operation_id !== ctx.args.operation_id || packet.attempt_id !== ctx.attempt ||
      !object(packet) || Object.keys(packet).some(k => !['what', 'why', 'call_id', 'operation_id', 'attempt_id', 'next_offset', 'receipt', 'reason'].includes(k)) ||
      size(JSON.stringify(packet)) > LIMITS.packetBytes) {
      this.stop(ctx, 'screenshot reply identity or envelope differs')
      return false
    }
    if (!ctx.waiter) {
      // Easement may end a call while CDP is still capturing. Retain a terminal
      // route disposition, and prevent that capture from sending a later begin.
      if (['rejected', 'unresolved'].includes(packet.why)) {
        ctx.late = packet; this.stop(ctx, 'route ended during capture')
      } else this.stop(ctx, 'screenshot reply has no outstanding command')
      return false
    }
    const waiter = ctx.waiter
    ctx.waiter = null; clearTimeout(waiter.timer)
    waiter.resolve(packet)
    return true
  }

  stop (ctx, reason) {
    ctx.stopped = true
    ctx.interrupt?.()
    if (ctx.waiter) {
      const waiter = ctx.waiter; ctx.waiter = null; clearTimeout(waiter.timer)
      waiter.reject(new Error(reason))
    }
  }

  disconnect (socket) {
    for (const ctx of this.calls.values()) if (ctx.socket === socket) this.stop(ctx, 'connection lost; query status by operation_id')
  }

  async exchange (ctx, why, fields = {}) {
    if (ctx.stopped) fail('screenshot call no longer owns a connected route')
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.stop(ctx, 'screenshot reply deadline elapsed; query status by operation_id'), why === 'finish' ? 55000 : this.timeout)
      ctx.waiter = { resolve, reject, timer }
      try {
        if (!this.send(ctx.socket, this.packet(ctx, why, fields))) this.stop(ctx, 'connection lost; query status by operation_id')
      } catch { this.stop(ctx, 'screenshot send failed; query status by operation_id') }
    })
    if (terminal(result.why)) {
      try { await validateReceipt(result.receipt, result.why, ctx.args, this.operations.get(ctx.key)) } catch {
        this.stop(ctx, 'receipt mismatch; query status by operation_id')
        throw new Error('receipt mismatch')
      }
    }
    else {
      const allowed = why === 'status' ? ['unknown', 'receiving', 'rejected', 'unresolved'] : why === 'begin' ? ['ready', 'rejected', 'unresolved'] : why === 'chunk' ? ['ack', 'rejected', 'unresolved'] : why === 'abandon' ? ['abandoned', 'rejected', 'unresolved'] : ['rejected', 'unresolved']
      if (!allowed.includes(result.why) || result.receipt !== undefined ||
        (result.reason !== undefined && typeof result.reason !== 'string')) fail('screenshot reply violates phase')
      if (['ready', 'ack', 'receiving'].includes(result.why)) {
        const expected = why === 'begin' ? 0 : why === 'chunk' ? fields.offset + decodedLength(fields.data) : null
        if (!Number.isSafeInteger(result.next_offset) || result.next_offset < 0 || result.next_offset > LIMITS.pngBytes ||
          (expected !== null && result.next_offset !== expected)) fail('screenshot acknowledgement offset differs')
      } else if (result.next_offset !== undefined) fail('unexpected screenshot offset')
    }
    return result
  }

  async run (args, socket) {
    // Only these call-local fields participate in this protocol. Do not retain
    // the entire dispatch envelope or consult the worker's legacy currentSlug.
    args = { call_id: args.call_id, slug: args.slug, operation_id: args.operation_id, action: args.action,
      destination: args.destination, mode: args.mode, tabId: args.tabId, where: args.where }
    const ctx = { args, socket, attempt: crypto.randomUUID(), key: args.slug + '\0' + args.operation_id, started: false, stopped: false }
    ctx.interrupted = new Promise(resolve => { ctx.interrupt = resolve })
    try { validateCall(args) } catch (error) { return this.packet(ctx, 'rejected', { reason: error.message }) }
    if (this.calls.size >= LIMITS.operations || this.calls.has(args.call_id) || [...this.calls.values()].some(c => c.key === ctx.key)) {
      return this.packet(ctx, 'rejected', { reason: 'screenshot call or operation is already active, or capacity is reached' })
    }
    this.calls.set(args.call_id, ctx)
    try {
      let result = await this.exchange(ctx, 'status', { where: 'localhost' })
      if (terminal(result.why)) { this.release(ctx.key); return result }
      if (args.action === 'abandon') {
        try {
          if (['unknown', 'receiving'].includes(result.why)) result = await this.exchange(ctx, 'abandon')
          return result
        } finally {
          this.release(ctx.key)
          this.note(ctx, 'abandon', 'explicitly discarded retained PNG bytes')
        }
      }
      if (args.action === 'status' || !['unknown', 'receiving'].includes(result.why)) return result
      let op = this.operations.get(ctx.key)
      if (args.action === 'retry' && !op?.bytes) return result
      if (op && ((args.destination !== undefined && args.destination !== op.intent?.destination) ||
        (args.mode !== undefined && args.mode !== op.intent?.mode) || (args.tabId !== undefined && args.tabId !== op.tabId))) fail('retry conflicts with original capture intent')
      if (args.action === 'capture') {
        if (result.why !== 'unknown') return result
        if (op) fail('operation already captured in this worker; use retry with the original intent')
        if (this.operations.size >= LIMITS.operations || this.retainedBytes + LIMITS.pngBytes > LIMITS.totalBytes) {
          return await this.exchange(ctx, 'reject', { reason: 'retention_capacity' })
        }
        op = { reservation: LIMITS.pngBytes }; this.operations.set(ctx.key, op)
        this.note(ctx, 'capture', 'requested exact PNG capture')
        // Chrome has no capture-cancel primitive. A disconnected call can end
        // promptly, but its reservation remains until the pending CDP work
        // settles. Those bytes may then support an explicit same-worker retry.
        const captureTask = (async () => {
          try {
            const capture = await this.capture(args)
            if (!(capture.bytes instanceof Uint8Array) || capture.bytes.length === 0 || capture.bytes.length > LIMITS.pngBytes || !hex(capture.sha256)) fail('invalid capture')
            dimensions(capture.pixel_width, capture.pixel_height)
            const intent = { destination: args.destination, bytes: capture.bytes.length, sha256: capture.sha256, mode: args.mode, source_url: capture.source_url, captured_at: capture.captured_at }
            if (!intentValid(intent)) fail('capture manifest exceeds limits')
            if (op.discard) this.operations.delete(ctx.key)
            else Object.assign(op, capture, { intent, reservation: 0 })
            return true
          } catch {
            this.operations.delete(ctx.key)
            this.note(ctx, 'fail_capture', 'exact PNG capture or validation failed')
            return false
          }
        })()
        const captureTimer = setTimeout(() => this.stop(ctx, 'capture deadline elapsed'), 20000)
        const complete = await Promise.race([captureTask, ctx.interrupted])
        clearTimeout(captureTimer)
        if (complete === false) return await this.exchange(ctx, 'reject', { reason: 'capture_failed' })
      }
      if (ctx.stopped) return ctx.late ?? this.packet(ctx, 'unresolved', { reason: 'capture retained in memory; query status by operation_id' })
      // Easement binds destination before dispatch. Retry cannot supply it late.
      if (args.destination === undefined) fail('retry with bytes requires the original destination in tool arguments')
      ctx.started = true
      result = await this.exchange(ctx, 'begin', { where: 'localhost', intent: op.intent })
      if (result.why === 'ready') {
        for (let offset = 0; offset < op.bytes.length; offset += LIMITS.chunkBytes) {
          result = await this.exchange(ctx, 'chunk', { offset, data: encodeChunk(op.bytes.subarray(offset, offset + LIMITS.chunkBytes)) })
          if (result.why !== 'ack') break
        }
        if (result.why === 'ack') result = await this.exchange(ctx, 'finish')
      }
      if (terminal(result.why)) this.release(ctx.key)
      if (!disposition(result.why)) fail('screenshot transfer ended without a disposition')
      return result
    } catch {
      const why = ctx.started || ctx.stopped ? 'unresolved' : 'rejected'
      this.note(ctx, 'reject_transfer', 'capture, route or receipt could not be established; query status by operation_id')
      return ctx.late ?? this.packet(ctx, why, { reason: 'capture, route or receipt could not be established; query status by operation_id' })
    } finally {
      this.stop(ctx, 'call ended')
      this.calls.delete(args.call_id)
    }
  }
}
