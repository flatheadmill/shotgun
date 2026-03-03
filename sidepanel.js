const input = document.getElementById('input')
const button = document.getElementById('send')
const content = document.getElementById('content')

button.addEventListener('click', send)
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') send()
})

// Listen for envelopes forwarded by the service worker.
chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'envelope') return
  const envelope = message.envelope

  if (envelope.stream === 'entry') {
    renderEntry(envelope.data)
  }

  if (envelope.stream === 'lifecycle') {
    // Round completed — re-enable input.
    const event = typeof envelope.data === 'string'
      ? envelope.data
      : Object.keys(envelope.data)[0] || ''
    if (event === 'round_completed') {
      button.disabled = false
      input.focus()
    }
  }

  if (envelope.stream === 'disconnect') {
    append('system', '(disconnected)')
    button.disabled = false
  }
})

function send () {
  const text = input.value.trim()
  if (!text) return

  append('you', text)
  input.value = ''
  button.disabled = true

  chrome.runtime.sendMessage({ type: 'send', text })
}

function renderEntry (data) {
  if (!data || !data.blocks) return
  const role = data.kind === 'user' ? 'you' : 'claude'

  for (const block of data.blocks) {
    if (block.type === 'text') {
      append(role, block.text)
    }
  }
}

function append (role, text) {
  const div = document.createElement('div')
  div.className = 'message ' + role
  div.textContent = text
  content.appendChild(div)
  content.scrollTop = content.scrollHeight
}

// Connect on load.
chrome.runtime.sendMessage({ type: 'connect' })
