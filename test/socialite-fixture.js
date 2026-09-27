import { IngressProducer, sha256 } from '../companion-ingress.js'
import { Socialite } from '../socialite.js'
export const tick = () => new Promise(resolve => setImmediate(resolve))
export async function until (check) {
  const end = Date.now() + 3000
  while (Date.now() < end) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 1)) }
  throw new Error('test condition did not settle')
}
export function deferred () {
  let resolve; let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export async function operation (kind = 'response', bytes = new TextEncoder().encode('source'), operation_id = crypto.randomUUID()) {
  return { operation_id, bytes, review_id: 'review', manifest: { version: 1, kind, bytes: bytes.length, sha256: await sha256(bytes), provenance: { review_id: 'review', source: 'PRIVATE_PROVENANCE' } } }
}
export function peer ({ hold = () => false, timeout } = {}) {
  const frames = []; const held = []; const objects = new Map(); const routes = new Map()
  const socket = { readyState: 1, bufferedAmount: 0 }
  let available = 'available'; let current = socket
  const ingress = new IngressProducer({ timeout, send: (channel, packet) => {
    if (channel !== current || channel.readyState !== 1) return false
    frames.push(structuredClone(packet))
    if (packet.why === 'abort') return true
    queueMicrotask(() => {
      const reply = { what: packet.what, operation_id: packet.operation_id, attempt_id: packet.attempt_id }
      if (packet.why === 'probe') {
        reply.why = available === 'available' ? 'available' : 'rejected'
        if (reply.why === 'rejected') reply.reason = available
      } else {
        let route = routes.get(packet.attempt_id)
        if (!route) { route = { binding: { route_id: crypto.randomUUID(), source: 1, receiver: 2 }, manifest: packet.manifest, chunks: [] }; routes.set(packet.attempt_id, route) }
        reply.binding = route.binding
        if (packet.why === 'begin') {
          const stored = objects.get(packet.operation_id)
          if (stored) { reply.why = 'stored'; reply.receipt = stored.receipt } else { reply.why = 'ready'; reply.offset = 0 }
        } else if (packet.why === 'chunk') {
          const bytes = Uint8Array.from(atob(packet.data), c => c.charCodeAt(0)); route.chunks.push(bytes)
          reply.why = 'ack'; reply.offset = packet.offset + bytes.length
        } else if (packet.why === 'finish') {
          const receipt = { version: 1, operation_id: packet.operation_id, manifest: route.manifest, recorded_at_ms: 1 }
          objects.set(packet.operation_id, { receipt, bytes: Uint8Array.from(route.chunks.flatMap(b => [...b])) })
          reply.why = 'stored'; reply.receipt = receipt
        } else if (packet.why === 'lookup') {
          const stored = objects.get(packet.operation_id)
          reply.why = stored ? 'stored' : 'unknown'; if (stored) reply.receipt = stored.receipt
        }
      }
      if (hold(packet, reply)) held.push({ packet, reply, socket: channel })
      else ingress.receive(reply, channel)
    })
    return true
  } })
  return { ingress, frames, held, objects, routes, socket, get current () { return current },
    presence: value => { available = value },
    replace: () => { current = { readyState: 1, bufferedAmount: 0 }; return current },
    release: (index = 0) => { const h = held.splice(index, 1)[0]; ingress.receive(h.reply, h.socket); return h },
    close: async () => { ingress.disconnect(socket); ingress.disconnect(current); await tick() } }
}
export const descriptor = id => `https://pbs.twimg.com/media/${id}.jpg`
export const actual = id => `https://pbs.twimg.com/media/${id}?format=jpg&name=900x900`
export const tweet = (id = '1', media = [{ type: 'photo', media_url_https: descriptor('one') }]) => ({ __typename: 'Tweet', rest_id: id, legacy: { id_str: id, full_text: 'PRIVATE_BODY_TEXT', extended_entities: { media } } })
export const body = results => JSON.stringify({ data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: results.map(result => ({ content: { entryType: 'TimelineTimelineItem', itemContent: { tweet_results: { result } } } })) }] } } } }, null, 2)
export const BOOKMARKS = 'https://x.com/i/api/graphql/hash/Bookmarks?variables=PRIVATE_QUERY'
export function helper (options = {}) {
  const bus = peer(options); const commands = []; const bodies = new Map(); let busy = false
  const app = new Socialite({ ingress: bus.ingress, socket: () => bus.current, firehoseBusy: () => busy,
    attach: options.attach ?? (async () => {}), getTab: options.getTab ?? (async () => ({ url: 'https://x.com/i/bookmarks' })), hash: options.hash,
    command: async (tab, method, params) => {
      commands.push({ tab, method, params })
      if (options.command) return options.command(tab, method, params, bodies)
      if (method === 'Network.getResponseBody') return bodies.get(params.requestId)
    } })
  function received (id, url = BOOKMARKS, mimeType = 'application/json') {
    app.onEvent(7, 'Network.responseReceived', { requestId: id, timestamp: 12, response: { url, status: 200, mimeType, fromDiskCache: true, headers: { private: 'PRIVATE_HEADER' } } })
  }
  function finish (id) { app.onEvent(7, 'Network.loadingFinished', { requestId: id, timestamp: 13, encodedDataLength: 0 }) }
  return { ...bus, app, commands, bodies, busy: value => { busy = value }, received, finish,
    complete: (id, url, mime) => { received(id, url, mime); finish(id) },
    start: () => app.start({ tabId: 7 }, bus.current),
    cleanup: async () => { app.stop(); await bus.close() } }
}
