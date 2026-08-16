// Records are pure event data; emit owns the envelope for the current sink.
// A sink set by the service worker routes { what: "log", why: "write", whom:
// "shotgun", with: record } to Easement, which stamps when, turns whom into the
// line's who and with into its what, and writes it to the one shared file. With
// no sink or a closed socket, emit falls back to the console — ephemeral, and
// self-limiting because the worker that holds that console dies.

const ANCHORS = new Set(['whom', 'where', 'why', 'how'])

export function record (who, what, fields = {}) {
  const event = { who, what }
  const details = {}

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    if (ANCHORS.has(key)) {
      event[key] = String(value)
    } else {
      details[key] = value
    }
  }

  event.with = details
  return event
}

let sink = null

export function setSink (fn) {
  sink = fn
}

export function emit (record) {
  if (sink && sink({ what: 'log', why: 'write', whom: 'shotgun', with: record })) return
  // No sink yet, or the socket is down: log the line Easement would have
  // written, so a developer watching the console sees the same shape.
  console.log(JSON.stringify({ when: new Date().toISOString(), who: 'shotgun', what: record }))
}

export function trace (who, what, fields = {}) {
  emit(record(who, what, fields))
}

export function error (who, what, err, fields = {}) {
  const why = err instanceof Error ? err.message : String(err)
  const details = { ...fields, why }
  if (err instanceof Error && err.stack) details.stack = err.stack
  emit(record(who, what, details))
}
