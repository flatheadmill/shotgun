// Records are pure event data; emit owns the envelope for the current sink.
// Today that sink is the console, which dies with the MV3 worker. Tomorrow
// emit can route { who: "easement", whom: "shotgun", what: "log", with: record }
// and let Easement stamp when without changing the record or its callers.

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

export function emit (record) {
  const envelope = {
    when: new Date().toISOString(),
    who: 'shotgun',
    what: record
  }
  console.log(JSON.stringify(envelope))
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
