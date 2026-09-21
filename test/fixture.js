import { deflateSync } from 'node:zlib'

function crc (bytes) {
  let c = 0xffffffff
  for (const b of bytes) {
    c ^= b
    for (let n = 0; n < 8; n++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0)
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk (name, data) {
  const bytes = Buffer.alloc(data.length + 12)
  bytes.writeUInt32BE(data.length)
  bytes.write(name, 4)
  data.copy(bytes, 8)
  bytes.writeUInt32BE(crc(bytes.subarray(4, -4)), bytes.length - 4)
  return bytes
}

export function png (width = 1, height = 1, extra = 0, options = {}) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(options.width ?? width)
  header.writeUInt32BE(options.height ?? height, 4)
  header[8] = 8
  header[9] = 6
  const pixels = Buffer.alloc((width * 4 + 1) * height, 127)
  for (let y = 0; y < height; y++) pixels[y * (width * 4 + 1)] = 0
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), ...(options.animated ? [chunk('acTL', Buffer.alloc(8))] : []), chunk('raNd', Buffer.alloc(extra, 65)),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))
  ])
}

export const call = (fields = {}) => ({
  call_id: 'call-1', slug: 'easement', operation_id: 'op-1',
  action: 'capture', destination: '/safe/capture.png', mode: 'viewport', ...fields
})
export const reply = (request, why, fields = {}) => ({
  what: 'screenshot_save', why, call_id: request.call_id,
  operation_id: request.operation_id, attempt_id: request.attempt_id, ...fields
})
export const tick = () => new Promise(resolve => setImmediate(resolve))
