// Socialite's bounded producer. No acquisition, persistence, retry or raw logs.
export const LIMITS = Object.freeze({
  objectBytes: 2 * 1024 * 1024, chunkBytes: 64 * 1024, packetBytes: 96 * 1024,
  manifestBytes: 8 * 1024, operations: 2, perKindOperations: 1,
  responseBytes: 512 * 1024, imageBytes: 2 * 1024 * 1024,
  controls: 2, tombstones: 32, tombstoneBytes: 256 * 1024, history: 16,
  socketBufferedBytes: 256 * 1024, replyTimeoutMs: 25000
})
const encoder = new TextEncoder()
export const utf8Size = value => encoder.encode(value).length
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
const keys = (value, required, optional = []) => object(value) && required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => required.includes(k) || optional.includes(k))
export class IngressError extends Error { constructor (code) { super(code); this.code = code } }
const fail = code => { throw new IngressError(code) }
export async function sha256 (bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
}
function immutable (value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(immutable); Object.freeze(value) }
  return value
}
function same (left, right, depth = 0) {
  if (left === right) return true
  if (depth > 16 || !left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false
  return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(k => Object.hasOwn(right, k) && same(left[k], right[k], depth + 1))
}
function validBinding (value) {
  return keys(value, ['route_id', 'source', 'receiver']) && id(value.route_id) && ['source', 'receiver'].every(k => Number.isSafeInteger(value[k]) && value[k] >= 0)
}
function validManifest (m) {
  return keys(m, ['version', 'kind', 'bytes', 'sha256', 'provenance']) && m.version === 1 && ['response', 'image'].includes(m.kind) &&
    Number.isSafeInteger(m.bytes) && m.bytes >= 0 && m.bytes <= LIMITS.objectBytes && typeof m.sha256 === 'string' && /^[a-f0-9]{64}$/.test(m.sha256) && object(m.provenance) && utf8Size(JSON.stringify(m)) <= LIMITS.manifestBytes
}
const reasons = new Set(['missing_companion', 'ambiguous_companion', 'route_capacity', 'stage_capacity', 'intent_conflict', 'operation_active', 'endpoint_disconnected', 'attempt_deadline_elapsed', 'staging_cleanup_failed', 'filesystem_error'])
export function encodeChunk (bytes) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 4096) binary += String.fromCharCode(...bytes.subarray(offset, offset + 4096))
  return btoa(binary)
}
const row = op => ({ operation_id: op.id, kind: op.manifest.kind, review_id: op.review, bytes: op.manifest.bytes,
  sha256: op.manifest.sha256, state: op.state, reason: op.reason ?? null, retained: Boolean(op.bytes) })

export class IngressProducer {
  constructor ({ send, timeout = LIMITS.replyTimeoutMs, onChange = () => {} }) {
    this.send = send; this.timeout = timeout; this.onChange = onChange
    this.operations = new Map(); this.tombstones = new Map(); this.contexts = new Map(); this.history = []
    this.counts = { stored: 0, unconfirmed: 0, abandoned: 0, tombstone_pressure: 0, control_pressure: 0, history_evicted: 0, invalid_reply: 0 }
  }
  canAccept (kind) { return ['response', 'image'].includes(kind) && this.operations.size < LIMITS.operations && ![...this.operations.values()].some(op => op.manifest.kind === kind) }
  get unresolved () { return this.operations.size > 0 }
  retain ({ operation_id, bytes, manifest, review_id }, socket) {
    if (!id(operation_id) || !(bytes instanceof Uint8Array) || !validManifest(manifest) || manifest.bytes !== bytes.length ||
      bytes.length > LIMITS[`${manifest.kind}Bytes`] || !this.canAccept(manifest.kind) || this.operations.has(operation_id) || this.tombstones.has(operation_id)) fail('ingress_capacity_or_intent')
    const op = { id: operation_id, bytes, manifest: immutable(JSON.parse(JSON.stringify(manifest))), review: review_id, state: 'retained', reason: null }
    this.operations.set(op.id, op)
    void this.transfer(op, socket)
    this.onChange()
    return op.id
  }
  context (action, operation, socket, op = null) {
    if (action !== 'transfer' && [...this.contexts.values()].filter(c => c.action !== 'transfer').length >= LIMITS.controls) {
      this.counts.control_pressure++; fail('control_capacity')
    }
    const ctx = { action, operation, socket, op, attempt: crypto.randomUUID(), binding: null, waiter: null, stopped: false }
    this.contexts.set(ctx.attempt, ctx); return ctx
  }
  packet (ctx, why, fields = {}) {
    return { what: 'companion_ingress', why, operation_id: ctx.operation, attempt_id: ctx.attempt, ...(ctx.binding ? { binding: ctx.binding } : {}), ...fields }
  }
  halt (ctx, code) {
    ctx.stopped = true
    this.contexts.delete(ctx.attempt)
    if (ctx.waiter) { const waiter = ctx.waiter; ctx.waiter = null; clearTimeout(waiter.timer); waiter.reject(new IngressError(code)) }
  }
  disconnect (socket) { for (const ctx of this.contexts.values()) if (ctx.socket === socket) this.halt(ctx, 'connection_lost') }
  receive (packet, socket) {
    const ctx = this.contexts.get(packet?.attempt_id)
    if (!ctx || ctx.socket !== socket || ctx.stopped) return false
    if (!ctx.waiter || packet.operation_id !== ctx.operation || packet.what !== 'companion_ingress' ||
      !keys(packet, ['what', 'why', 'operation_id', 'attempt_id'], ['binding', 'offset', 'receipt', 'reason']) || utf8Size(JSON.stringify(packet)) > LIMITS.packetBytes) {
      this.counts.invalid_reply++; this.halt(ctx, 'invalid_reply'); return false
    }
    const waiter = ctx.waiter; ctx.waiter = null; clearTimeout(waiter.timer); waiter.resolve(packet); return true
  }
  async exchange (ctx, why, fields = {}, expected = null) {
    if (ctx.stopped) fail('attempt_stopped')
    const packet = this.packet(ctx, why, fields)
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.halt(ctx, 'reply_timeout'), this.timeout)
      ctx.waiter = { resolve, reject, timer }
      try { if (utf8Size(JSON.stringify(packet)) > LIMITS.packetBytes || !this.send(ctx.socket, packet)) this.halt(ctx, 'send_unavailable') } catch { this.halt(ctx, 'send_unavailable') }
    })
    if (ctx.stopped) fail('attempt_stopped')
    const refusal = ['rejected', 'unconfirmed'].includes(result.why)
    if (why === 'probe') {
      if (result.binding !== undefined || result.offset !== undefined || result.receipt !== undefined || (!refusal && (result.why !== 'available' || result.reason !== undefined))) fail('invalid_reply')
    } else {
      if (result.binding !== undefined && (!validBinding(result.binding) || (ctx.binding && !same(ctx.binding, result.binding)))) fail('invalid_binding')
      if (!refusal && !validBinding(result.binding)) fail('invalid_binding')
      if (ctx.binding && !same(ctx.binding, result.binding)) fail('invalid_binding')
      if (!ctx.binding && result.binding) ctx.binding = immutable({ ...result.binding })
      if (result.why === 'stored') {
        const receipt = result.receipt
        if (!['begin', 'finish', 'lookup'].includes(why) || result.offset !== undefined || result.reason !== undefined ||
          !keys(receipt, ['version', 'operation_id', 'manifest', 'recorded_at_ms']) || receipt.version !== 1 || receipt.operation_id !== ctx.operation ||
          !Number.isSafeInteger(receipt.recorded_at_ms) || receipt.recorded_at_ms < 0 || !same(receipt.manifest, ctx.op.manifest)) fail('invalid_receipt')
      } else if (!refusal) {
        const allowed = why === 'begin' ? 'ready' : why === 'chunk' ? 'ack' : null
        if (why === 'lookup' && ['unknown', 'receiving'].includes(result.why)) {
          if (result.offset !== undefined) fail('invalid_credit')
        } else if (result.why !== allowed || result.offset !== expected) fail('invalid_credit')
        if (result.receipt !== undefined || result.reason !== undefined) fail('invalid_reply')
      }
    }
    if (refusal) {
      if (typeof result.reason !== 'string' || utf8Size(result.reason) > 128 || result.offset !== undefined || result.receipt !== undefined) fail('invalid_reply')
      fail(reasons.has(result.reason) ? result.reason : 'peer_refused')
    }
    return result
  }
  async probe (socket) {
    const ctx = this.context('probe', crypto.randomUUID(), socket)
    try { return (await this.exchange(ctx, 'probe')).why === 'available' } finally { this.halt(ctx, 'probe_ended'); this.contexts.delete(ctx.attempt) }
  }
  async transfer (op, socket) {
    const ctx = this.context('transfer', op.id, socket, op)
    try {
      op.state = 'opening'
      let result = await this.exchange(ctx, 'begin', { manifest: op.manifest }, 0)
      if (result.why !== 'stored') {
        for (let offset = 0; offset < op.manifest.bytes; offset += LIMITS.chunkBytes) {
          if (ctx.stopped || !op.bytes) fail('attempt_stopped')
          op.state = 'transferring'
          const end = Math.min(offset + LIMITS.chunkBytes, op.manifest.bytes)
          result = await this.exchange(ctx, 'chunk', { offset, data: encodeChunk(op.bytes.subarray(offset, end)) }, end)
        }
        op.state = 'finishing'
        result = await this.exchange(ctx, 'finish')
      }
      this.stored(op)
    } catch (error) {
      if (this.operations.get(op.id) === op) {
        op.state = 'unconfirmed'; op.reason = error instanceof IngressError ? error.code : 'transfer_failed'; this.counts.unconfirmed++
      }
    } finally { this.halt(ctx, 'transfer_ended'); this.contexts.delete(ctx.attempt); this.onChange() }
  }
  stored (op) {
    if (this.operations.get(op.id) !== op && this.tombstones.get(op.id) !== op) return
    for (const ctx of this.contexts.values()) if (ctx.op === op && ctx.action === 'transfer') this.halt(ctx, 'receipt_confirmed')
    op.bytes = null; op.state = 'stored'; op.reason = null
    this.operations.delete(op.id); this.tombstones.delete(op.id); this.counts.stored++
    this.history.push(row(op)); if (this.history.length > LIMITS.history) { this.history.shift(); this.counts.history_evicted++ }
    this.onChange()
  }
  async lookup (operation, socket) {
    const op = this.operations.get(operation) ?? this.tombstones.get(operation)
    if (!op) fail('operation_not_retained')
    const ctx = this.context('lookup', operation, socket, op)
    try {
      const result = await this.exchange(ctx, 'lookup', { manifest: op.manifest })
      if (result.why === 'stored') this.stored(op)
      return { operation_id: operation, outcome: result.why, ...row(op) }
    } finally { this.halt(ctx, 'lookup_ended'); this.contexts.delete(ctx.attempt) }
  }
  abandon (operation) {
    const op = this.operations.get(operation)
    if (!op) fail('operation_not_retained')
    const size = utf8Size(JSON.stringify(op.manifest))
    if (this.tombstones.size >= LIMITS.tombstones || this.tombstoneBytes() + size > LIMITS.tombstoneBytes) { this.counts.tombstone_pressure++; fail('tombstone_capacity') }
    for (const ctx of this.contexts.values()) if (ctx.op === op) {
      if (ctx.action === 'transfer' && ctx.binding && !ctx.stopped) {
        try { this.send(ctx.socket, this.packet(ctx, 'abort')) } catch { /* Remote acceptance remains unknown. */ }
      }
      this.halt(ctx, 'operator_abandoned')
    }
    op.bytes = null; op.state = 'abandoned'; op.reason = 'remote_acceptance_unknown'
    this.operations.delete(op.id); this.tombstones.set(op.id, op); this.counts.abandoned++
    this.onChange(); return row(op)
  }
  tombstoneBytes () { return [...this.tombstones.values()].reduce((n, op) => n + utf8Size(JSON.stringify(op.manifest)), 0) }
  status () {
    return { limits: LIMITS, counts: { ...this.counts }, operations: [...this.operations.values()].map(row), tombstones: [...this.tombstones.values()].map(row),
      history: this.history.map(r => ({ ...r })), tombstoneManifestBytes: this.tombstoneBytes(),
      retainedBytes: [...this.operations.values()].reduce((n, op) => n + op.bytes.length, 0), activeContexts: this.contexts.size }
  }
}
