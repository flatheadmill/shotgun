// This is the only file that knows what Easement puts on the wire. Its job is
// translation: socket messages in, a small and stable vocabulary of events out,
// so that nothing downstream — not the model, not the components — ever sees a
// raw broadcast. When the protocol shifts under us, and it will, this is the
// file that changes, and ideally the only one. The events are block-first
// because the native unit on the wire is a block within an entry; mirroring
// that here spares the model from taking apart a message the wire already
// delivered in pieces.

export class ProtocolAdapter extends EventTarget {
  constructor () {
    super()
    this.nextLocalEntry = 1
    this.activeRoundId = null
    this.activeAssistantEntryId = null
    this.activeBlocks = new Map()
    this.activeToolUseIds = new Map()
    this.historyReplayId = null
    this.historyLastUuid = null
    this.historyPosition = 0
  }

  ingestEnvelope (envelope) {
    const events = this.eventsForEnvelope(envelope)
    for (const event of events) this.dispatch(event)
    return events
  }

  localUserEntry (text) {
    const entryId = `local-user-${this.nextLocalEntry++}`
    return {
      type: 'entry.completed',
      entryId,
      roundId: this.activeRoundId || entryId,
      role: 'user',
      blocks: [{
        blockId: `${entryId}:user:0`,
        index: 0,
        kind: 'text',
        text,
        data: { type: 'text', text }
      }],
      authoritative: false,
      meta: { local: true, position: 0 }
    }
  }

  eventsForEnvelope (envelope) {
    if (!envelope || typeof envelope !== 'object') return []

    if (envelope.stream === 'connected') return [{ type: 'session.connected' }]
    if (envelope.stream === 'disconnect') return [{ type: 'session.disconnected', reason: 'disconnect' }]

    switch (envelope.what) {
      case 'history':
        return this.historyEvents(envelope)
      case 'turn':
        return this.turnEvents(envelope)
      case 'delta':
        return this.deltaEvents(envelope.event)
      case 'tool_result':
        return this.toolResultEvents(envelope)
      case 'error':
        return [this.errorEvent(envelope)]
      case 'usage':
        return [{ type: 'usage', roundId: this.currentRoundId(), data: envelope }]
      default:
        return []
    }
  }

  historyEvents (message) {
    // The adapter holds no transcript of its own. It treats history as
    // something to rebuild from a replay, never something to carry. We weighed
    // caching history in the service worker so a reopened panel could paint
    // without a round trip, but the service worker is itself fragile — Chrome
    // kills it on idle — and a cache there is one more thing to invalidate and
    // trust. The protocol is the simpler answer: a transcript stream is cheap
    // to ask for and cheap to receive, so the panel asks for a replay and
    // builds off it. When in doubt, wipe and re-render. Nothing here
    // synthesizes what a fresh replay could not reconstruct.
    if (message.why === 'begin') {
      this.historyReplayId = message.replay_id || message.transcript || 'history'
      this.historyLastUuid = message.last_uuid || null
      this.historyPosition = 0
      return []
    }

    if (message.why !== 'entry' || !message.entry) return []
    const entry = message.entry
    const role = normalizeRole(entry.who)
    const roundId = message.replay_id || this.historyReplayId || message.transcript || 'history'
    const position = this.historyPosition++
    const entryId = entry.uuid || `${roundId}:${role}:${position}`
    const blocks = Array.isArray(entry.blocks)
      ? entry.blocks.map((block, index) => normalizeHistoryBlock(block, { entryId, roundId, role, index }))
      : []

    return [{
      type: 'entry.completed',
      entryId,
      roundId,
      role,
      blocks,
      authoritative: true,
      meta: {
        position,
        uuid: entry.uuid || null,
        replayId: roundId,
        lastUuid: this.historyLastUuid,
        notification: entry.notification || null
      }
    }]
  }

  turnEvents (message) {
    const turnId = message.turn_id || this.currentRoundId()

    if (message.why === 'started') {
      this.activeRoundId = turnId
      this.activeAssistantEntryId = this.entryId(turnId, 'assistant', 0)
      this.activeBlocks.clear()
      this.activeToolUseIds.clear()
      return [{
        type: 'lifecycle',
        roundId: turnId,
        level: 'info',
        code: 'round_started',
        text: 'Round started',
        meta: { data: message }
      }]
    }

    if (message.why !== 'completed') return []
    const status = message.status || 'completed'
    const code = turnStatusCode(status)
    const events = [{
      type: 'lifecycle',
      roundId: turnId,
      level: lifecycleLevel(code),
      code,
      text: lifecycleText(code),
      meta: { data: message }
    }]

    if (code === 'round_interrupted' && this.activeAssistantEntryId) {
      events.push({
        type: 'entry.cancelled',
        entryId: this.activeAssistantEntryId,
        roundId: turnId,
        role: 'assistant',
        reason: 'interrupted',
        meta: { data: message }
      })
    }

    this.activeRoundId = null
    this.activeAssistantEntryId = null
    this.activeBlocks.clear()
    this.activeToolUseIds.clear()
    return events
  }

  deltaEvents (event) {
    if (!event || !event.type) return []
    const roundId = this.currentRoundId()
    const entryId = this.activeAssistantEntryId || this.entryId(roundId, 'assistant', 0)
    this.activeAssistantEntryId = entryId

    if (event.type === 'content_block_start') {
      const index = event.index ?? this.activeBlocks.size
      const block = event.content_block || {}
      const kind = normalizeKind(block.type)
      const blockId = block.id || this.blockId(roundId, 'assistant', index)
      this.activeBlocks.set(index, { blockId, kind, data: block })
      if (kind === 'tool_use' && block.id) this.activeToolUseIds.set(block.id, { blockId, index })
      return [
        { type: 'entry.started', entryId, roundId, role: 'assistant', meta: { provisional: true, position: 0 } },
        { type: 'block.started', entryId, roundId, blockId, index, kind, data: block, meta: { data: event } }
      ]
    }

    if (event.type === 'content_block_delta') {
      const index = event.index ?? lastActiveIndex(this.activeBlocks)
      const active = this.activeBlocks.get(index)
      if (!active) return []
      const text = deltaText(event.delta)
      if (!text) return []
      return [{ type: 'block.delta', entryId, roundId, blockId: active.blockId, index, kind: active.kind, text }]
    }

    if (event.type === 'content_block_stop') {
      const index = event.index ?? lastActiveIndex(this.activeBlocks)
      const active = this.activeBlocks.get(index)
      if (!active) return []
      this.activeBlocks.delete(index)
      return [{
        type: 'block.completed',
        entryId,
        roundId,
        blockId: active.blockId,
        index,
        kind: active.kind,
        data: active.data || {},
        meta: { data: event }
      }]
    }

    return []
  }

  toolResultEvents (message) {
    const toolUseId = message.tool_use_id
    const active = toolUseId ? this.activeToolUseIds.get(toolUseId) : null
    const roundId = this.currentRoundId()
    const entryId = `${roundId}:tool-results`
    return [{
      type: 'entry.completed',
      entryId,
      roundId,
      role: 'user',
      blocks: [{
        blockId: active?.blockId || `${entryId}:0`,
        index: active?.index ?? 0,
        kind: 'tool_result',
        text: outputText(message.output),
        data: {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: message.output,
          is_error: Boolean(message.is_error)
        },
        meta: { data: message }
      }],
      authoritative: true,
      meta: { position: 1, toolResult: true, toolUseId }
    }]
  }

  errorEvent (message) {
    return {
      type: 'error',
      roundId: this.currentRoundId(),
      message: message.message || message.code || 'unknown error',
      recoverable: Boolean(message.recoverable),
      meta: {
        code: message.code || null,
        details: message.details || null,
        data: message
      }
    }
  }

  currentRoundId () {
    return this.activeRoundId || 'ambient'
  }

  entryId (roundId, role, position) {
    return `${roundId}:${role}:${position}`
  }

  blockId (roundId, role, index) {
    return `${roundId}:${role}:block:${index}`
  }

  dispatch (event) {
    this.dispatchEvent(new CustomEvent('event', { detail: event }))
  }
}

function normalizeHistoryBlock (block, context) {
  return {
    blockId: block?.id || block?.tool_use_id || `${context.entryId}:block:${context.index}`,
    index: context.index,
    kind: normalizeKind(block?.type),
    text: blockText(block),
    data: block || {},
    meta: {}
  }
}

function normalizeKind (type) {
  if (type === 'text') return 'text'
  if (type === 'thinking') return 'thinking'
  if (type === 'tool_use') return 'tool_use'
  if (type === 'tool_result') return 'tool_result'
  return 'generic'
}

function normalizeRole (role) {
  return role === 'user' ? 'user' : 'assistant'
}

function blockText (block) {
  if (!block) return ''
  if (typeof block.text === 'string') return block.text
  if (typeof block.thinking === 'string') return block.thinking
  if (typeof block.content === 'string') return block.content
  return ''
}

function deltaText (delta) {
  if (!delta) return ''
  if (delta.type === 'text_delta') return delta.text || ''
  if (delta.type === 'thinking_delta') return delta.thinking || ''
  return ''
}

function outputText (output) {
  if (typeof output === 'string') return output
  try {
    return JSON.stringify(output)
  } catch {
    return String(output || '')
  }
}

function lastActiveIndex (blocks) {
  let last = 0
  for (const index of blocks.keys()) last = index
  return last
}

function turnStatusCode (status) {
  if (status === 'interrupted') return 'round_interrupted'
  if (status === 'failed') return 'round_failed'
  return 'round_completed'
}

function lifecycleLevel (code) {
  if (code === 'round_interrupted') return 'warn'
  if (code === 'round_failed') return 'error'
  return 'info'
}

function lifecycleText (code) {
  if (code === 'round_started') return 'Round started'
  if (code === 'round_completed') return 'Round completed'
  if (code === 'round_interrupted') return 'Round interrupted'
  if (code === 'round_failed') return 'Round failed'
  return code || 'Lifecycle event'
}
