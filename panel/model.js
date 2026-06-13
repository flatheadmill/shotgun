const MAX_TOOL_PAYLOAD = 120000
const PREVIEW_CHARS = 700

export class TranscriptModel extends EventTarget {
  constructor () {
    super()
    this.entries = []
    this.entriesById = new Map()
    this.entryKeyToId = new Map()
    this.pendingToolKeysByRound = new Map()
    this.toolCalls = new Map()
    this.lifecycle = []
    this.connected = false
  }

  apply (event) {
    if (!event || !event.type) return
    switch (event.type) {
      case 'session.connected':
        this.connected = true
        this.addLifecycle({ level: 'info', code: 'connected', text: 'connected' })
        break
      case 'session.disconnected':
        this.connected = false
        this.cancelActiveWork('disconnected')
        this.addLifecycle({ level: 'warn', code: 'disconnected', text: 'disconnected' })
        break
      case 'entry.started':
        this.ensureEntry(event)
        break
      case 'entry.completed':
        this.completeEntry(event)
        break
      case 'entry.cancelled':
        this.cancelEntry(event.entryId, event.reason || 'cancelled')
        break
      case 'block.started':
        this.startBlock(event)
        break
      case 'block.delta':
        this.applyDelta(event)
        break
      case 'block.completed':
        this.completeBlock(event)
        break
      case 'lifecycle':
        this.applyLifecycle(event)
        break
      case 'error':
        this.addLifecycle({ level: 'error', code: 'error', text: event.message })
        break
    }
    this.emitChange()
  }

  applyAll (events) {
    for (const event of events) this.apply(event)
  }

  setFold (key, expanded) {
    this.setToolExpanded(key, expanded)
  }

  setToolExpanded (key, expanded) {
    const call = this.toolCalls.get(key)
    if (!call) return
    call.expanded = expanded
    this.emitChange()
  }

  snapshot () {
    return {
      connected: this.connected,
      lifecycle: this.lifecycle.slice(-6).map(item => ({ ...item })),
      tools: Object.fromEntries(Array.from(this.toolCalls.entries()).map(([key, value]) => [key, { ...value }])),
      entries: this.entries
        .filter(entry => !entry.absorbed)
        .map(entry => ({
          ...entry,
          blocks: entry.blocks.filter(Boolean).map(block => ({ ...block }))
        }))
    }
  }

  ensureEntry (event) {
    let entry = this.entriesById.get(event.entryId)
    if (!entry) {
      entry = {
        id: event.entryId,
        key: this.entryKey(event),
        roundId: event.roundId,
        role: event.role,
        blocks: [],
        status: 'streaming',
        authoritative: false
      }
      this.entriesById.set(entry.id, entry)
      this.entryKeyToId.set(entry.key, entry.id)
      this.entries.push(entry)
    } else if (entry.status !== 'cancelled') {
      entry.status = 'streaming'
    }
    return entry
  }

  completeEntry (event) {
    const key = this.entryKey(event)
    const existingId = this.entryKeyToId.get(key) || event.entryId
    let entry = this.entriesById.get(existingId)
    if (!entry) {
      entry = {
        id: event.entryId,
        key,
        roundId: event.roundId,
        role: event.role,
        blocks: [],
        status: 'complete',
        authoritative: Boolean(event.authoritative)
      }
      this.entriesById.set(entry.id, entry)
      this.entryKeyToId.set(key, entry.id)
      this.entries.push(entry)
    }

    if (event.role === 'user' && event.blocks.length > 0 && event.blocks.every(block => block.kind === 'tool_result')) {
      const unpaired = []
      for (const block of event.blocks) {
        const paired = this.attachToolResult(event.roundId, block)
        if (!paired) unpaired.push(block)
      }
      if (unpaired.length === 0) {
        entry.absorbed = true
        return
      }
      event = { ...event, role: 'assistant', blocks: unpaired }
    }

    entry.id = existingId
    entry.key = key
    entry.roundId = event.roundId
    entry.role = event.role
    entry.status = entry.status === 'cancelled' ? 'cancelled' : 'complete'
    entry.authoritative = Boolean(event.authoritative)
    entry.absorbed = false
    entry.blocks = event.blocks.map(block => this.normalizeBlock(event, block))
  }

  startBlock (event) {
    const entry = this.ensureEntry({
      entryId: event.entryId,
      roundId: event.roundId,
      role: 'assistant',
      meta: { position: 0 }
    })
    entry.blocks[event.index] = this.normalizeBlock(event, {
      blockId: event.blockId,
      index: event.index,
      kind: event.kind,
      text: '',
      data: event.data || {},
      streaming: event.kind === 'text' || event.kind === 'thinking'
    })
  }

  applyDelta (event) {
    const entry = this.entriesById.get(event.entryId)
    if (!entry) return
    const block = entry.blocks[event.index]
    if (!block) return
    block.text += event.text
    block.streaming = true
    block.status = 'streaming'
    block.version++
  }

  completeBlock (event) {
    const entry = this.entriesById.get(event.entryId)
    if (!entry) return
    const block = entry.blocks[event.index]
    if (!block) return
    block.streaming = false
    block.status = entry.status === 'cancelled' ? 'cancelled' : 'complete'
    block.version++
    if (block.kind === 'tool_use') this.ensureToolCall(entry.roundId, block)
  }

  applyLifecycle (event) {
    this.addLifecycle({ level: event.level, code: event.code, text: event.text, roundId: event.roundId })
    if (event.code === 'round_interrupted') this.cancelActiveWork('interrupted')
    if (event.code === 'round_completed') this.completeActiveWork(event.roundId)
  }

  normalizeBlock (event, block) {
    const normalized = {
      id: block.blockId,
      index: block.index,
      kind: block.kind,
      text: block.text || '',
      data: block.data || {},
      status: block.streaming ? 'streaming' : 'complete',
      streaming: Boolean(block.streaming),
      version: 1
    }

    if (normalized.kind === 'tool_use') {
      normalized.toolKey = this.ensureToolCall(event.roundId, normalized)
    } else if (normalized.kind === 'tool_result') {
      normalized.toolKey = this.attachToolResult(event.roundId, normalized) || this.ensureUnpairedResult(event.roundId, normalized)
      normalized.kind = 'tool_use'
    }
    return normalized
  }

  ensureToolCall (roundId, block) {
    const data = block.data || {}
    const callId = data.id || data.call_id || data.tool_use_id || null
    const order = this.toolCount(roundId)
    const key = callId ? `tool:${callId}` : `${roundId}:tool:${order}`
    if (this.toolCalls.has(key)) return key

    const retained = retainPayload(data.input ?? data)
    const call = {
      key,
      roundId,
      order,
      name: data.name || data.f || 'tool',
      inputSummary: data.input_summary || summarizeInput(data.input),
      input: retained.full,
      inputTruncated: retained.truncated,
      status: 'pending',
      error: false,
      preview: data.input_summary || summarizeInput(data.input),
      result: '',
      resultTruncated: false,
      image: null,
      expanded: false
    }
    this.toolCalls.set(key, call)
    if (!this.pendingToolKeysByRound.has(roundId)) this.pendingToolKeysByRound.set(roundId, [])
    this.pendingToolKeysByRound.get(roundId).push(key)
    return key
  }

  attachToolResult (roundId, block) {
    const data = block.data || {}
    const explicit = data.tool_use_id || data.call_id || data.id
    let key = explicit ? `tool:${explicit}` : null
    if (!key || !this.toolCalls.has(key)) key = this.nextPendingTool(roundId)
    if (!key || !this.toolCalls.has(key)) return null

    const payload = data.content ?? data.output ?? data
    const retained = retainPayload(payload)
    const call = this.toolCalls.get(key)
    call.status = data.is_error ? 'error' : 'complete'
    call.error = Boolean(data.is_error)
    call.preview = previewPayload(payload)
    call.result = retained.full
    call.resultTruncated = retained.truncated
    call.image = findImagePayload(payload)
    return key
  }

  ensureUnpairedResult (roundId, block) {
    const key = `${roundId}:unpaired-result:${block.index}`
    if (this.toolCalls.has(key)) return key
    const payload = block.data?.content ?? block.text ?? block.data
    const retained = retainPayload(payload)
    this.toolCalls.set(key, {
      key,
      roundId,
      order: 9999 + block.index,
      name: 'tool_result',
      inputSummary: 'unpaired result',
      input: '',
      inputTruncated: false,
      status: block.data?.is_error ? 'error' : 'complete',
      error: Boolean(block.data?.is_error),
      preview: previewPayload(payload),
      result: retained.full,
      resultTruncated: retained.truncated,
      image: findImagePayload(payload),
      expanded: false
    })
    return key
  }

  nextPendingTool (roundId) {
    const queue = this.pendingToolKeysByRound.get(roundId) || []
    while (queue.length > 0) {
      const key = queue.shift()
      const call = this.toolCalls.get(key)
      if (call && call.status === 'pending') return key
    }
    return null
  }

  toolCount (roundId) {
    return Array.from(this.toolCalls.values()).filter(call => call.roundId === roundId && !call.key.includes('unpaired')).length
  }

  cancelEntry (entryId, reason) {
    const entry = this.entriesById.get(entryId)
    if (!entry) return
    entry.status = 'cancelled'
    for (const block of entry.blocks) {
      if (!block) continue
      block.status = 'cancelled'
      block.streaming = false
      if (block.toolKey) this.cancelTool(block.toolKey, reason)
    }
  }

  cancelActiveWork (reason) {
    for (const entry of this.entries) {
      if (entry.status === 'streaming') this.cancelEntry(entry.id, reason)
    }
    for (const call of this.toolCalls.values()) {
      if (call.status === 'pending') {
        call.status = 'cancelled'
        call.preview = call.preview || reason
      }
    }
  }

  completeActiveWork (roundId) {
    for (const entry of this.entries) {
      if (entry.roundId === roundId && entry.status === 'streaming') entry.status = 'complete'
    }
  }

  cancelTool (key, reason) {
    const call = this.toolCalls.get(key)
    if (!call || call.status !== 'pending') return
    call.status = 'cancelled'
    call.preview = call.preview || reason
  }

  addLifecycle (item) {
    this.lifecycle.push({ ...item, id: `banner-${this.lifecycle.length + 1}` })
  }

  entryKey (event) {
    const position = event.meta?.position ?? (event.role === 'assistant' ? 0 : 1)
    return `${event.roundId}:${event.role}:${position}`
  }

  emitChange () {
    this.dispatchEvent(new CustomEvent('change'))
  }
}

function summarizeInput (input) {
  if (input == null) return ''
  if (typeof input === 'string') return truncateOneLine(input, 120)
  if (typeof input === 'object') {
    const path = input.path || input.file || input.url || input.selector
    if (path) return truncateOneLine(String(path), 120)
  }
  return truncateOneLine(JSON.stringify(input), 120)
}

function retainPayload (payload) {
  const text = stringifyPayload(payload)
  return text.length <= MAX_TOOL_PAYLOAD
    ? { full: text, truncated: false }
    : { full: text.slice(0, MAX_TOOL_PAYLOAD), truncated: true }
}

function previewPayload (payload) {
  return truncateMultiline(stringifyPayload(payload), PREVIEW_CHARS)
}

function stringifyPayload (payload) {
  if (payload == null) return ''
  if (typeof payload === 'string') return payload
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return String(payload)
  }
}

function truncateOneLine (text, max) {
  const oneLine = String(text || '').replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine
}

function truncateMultiline (text, max) {
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

function findImagePayload (payload) {
  const parsed = parsePayload(payload)
  const blocks = Array.isArray(parsed) ? parsed : parsed?.content
  if (!Array.isArray(blocks)) return null
  const image = blocks.find(item => item?.type === 'image' && item.data)
  if (!image) return null
  return {
    data: image.data,
    mimeType: image.mimeType || image.media_type || 'image/jpeg'
  }
}

function parsePayload (payload) {
  if (typeof payload !== 'string') return payload
  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}
