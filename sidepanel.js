const input = document.getElementById('input')
const button = document.getElementById('send')
const content = document.getElementById('content')

let roundActive = false

button.addEventListener('click', send)
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') send()
})

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'envelope') return
  const envelope = message.envelope

  switch (envelope.stream) {
    case 'entry':
      renderEntry(envelope.data)
      break

    case 'delta':
      renderDelta(envelope.data)
      break

    case 'lifecycle': {
      const event = typeof envelope.data === 'string'
        ? envelope.data
        : Object.keys(envelope.data)[0] || ''
      if (event === 'round_started') {
        roundActive = true
        setInputEnabled(false)
      } else if (event === 'round_completed' || event === 'round_interrupted') {
        roundActive = false
        finishStreaming()
        setInputEnabled(true)
      }
      break
    }

    case 'connected':
      append('system', '(connected)')
      break

    case 'disconnect':
      append('system', '(disconnected)')
      roundActive = false
      setInputEnabled(true)
      break

    case 'usage':
      break

    case 'error': {
      const msg = envelope.data && envelope.data.message
        ? envelope.data.message : 'unknown error'
      append('system', msg)
      break
    }
  }
})

function setInputEnabled (enabled) {
  button.disabled = !enabled
  input.disabled = !enabled
  if (enabled) input.focus()
}

function send () {
  const text = input.value.trim()
  if (!text) return

  append('you', text)
  input.value = ''
  setInputEnabled(false)

  chrome.runtime.sendMessage({ type: 'send', text })
}

// -- Entry rendering (history and complete entries from transcript) --

function renderEntry (data) {
  if (!data || !data.blocks) return
  if (data.kind === 'user') {
    for (const block of data.blocks) {
      if (block.type === 'text') {
        append('you', block.text)
      }
    }
    return
  }

  for (const block of data.blocks) {
    if (block.type === 'thinking') {
      append('thinking', block.text)
    } else if (block.type === 'text') {
      append('claude', block.text)
    } else if (block.type === 'tool_use') {
      append('tool', block.name + ' ' + block.input_summary)
    } else if (block.type === 'tool_result') {
      const prefix = block.is_error ? '[error] ' : ''
      append('tool', prefix + truncate(block.content, 200))
    }
  }
}

// -- Delta rendering (streaming) --

let streamingEl = null
let streamingType = null

function renderDelta (data) {
  const type = data.type
  if (!type) return

  if (type === 'content_block_start') {
    const block = data.content_block
    if (!block) return
    if (block.type === 'text') {
      streamingEl = createStreamingEl('claude')
      streamingType = 'text'
    } else if (block.type === 'thinking') {
      streamingEl = createStreamingEl('thinking')
      streamingType = 'thinking'
    } else if (block.type === 'tool_use') {
      streamingType = 'tool_use'
      streamingEl = null
    }
  } else if (type === 'content_block_delta') {
    const delta = data.delta
    if (!delta) return
    if (streamingType === 'text' && delta.type === 'text_delta' && streamingEl) {
      streamingEl.textContent += delta.text
      content.scrollTop = content.scrollHeight
    } else if (streamingType === 'thinking' && delta.type === 'thinking_delta' && streamingEl) {
      streamingEl.textContent += delta.thinking
      content.scrollTop = content.scrollHeight
    }
  } else if (type === 'content_block_stop') {
    streamingEl = null
    streamingType = null
  }
}

function createStreamingEl (role) {
  const div = document.createElement('div')
  div.className = 'message ' + role
  content.appendChild(div)
  return div
}

function finishStreaming () {
  streamingEl = null
  streamingType = null
}

// -- Helpers --

function append (role, text) {
  const div = document.createElement('div')
  div.className = 'message ' + role
  div.textContent = text
  content.appendChild(div)
  content.scrollTop = content.scrollHeight
}

function truncate (s, max) {
  if (!s) return ''
  return s.length <= max ? s : s.slice(0, max) + '...'
}

chrome.runtime.sendMessage({ type: 'connect' })
